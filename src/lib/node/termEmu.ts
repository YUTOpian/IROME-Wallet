// 簡易ターミナルエミュレータ（ノード画面の symbol-bootstrap wizard 用）。
//
// wizard の選択式の画面は、再描画のたびに「カーソルを上へ戻す・行を消す」エスケープ列を使う。
// エスケープ列を消して文字だけ出すと、同じ行が何度も重なって出てしまう。そこで、エージェントから生の出力を受け取り、
// ここで文字の格子（行 × 桁）に書き込み直して、いまの画面の見た目の文字列を作る。
//
// 対応するもの（wizard の画面に要る範囲だけ）:
//   - 文字の表示、改行（LF は、行頭に戻る改行として扱う）、CR、BS、Tab、全角文字（2 桁）、結合文字
//   - カーソル移動 CSI A B C D E F G H f d、保存・復元（CSI s u、ESC 7 8）、ESC M
//   - 消去 CSI J（0 1 2 3）・K（0 1 2）・X、行の挿入・削除 CSI L M、文字の挿入・削除 CSI @ P
// 対応しないもの: 色・太字などの装飾（CSI m は読み捨て）、代替画面、マウス、端末への問い合わせの返事。
// 読み捨てるもの: OSC（タイトルなど）、文字集合の指定、「?」で始まる設定（カーソルの表示・非表示など）。
//
// 画面の高さは決めない。行は下へ伸びていく。「H」などの絶対位置は、いちばん下の ROWS 行（端末の高さ）を基準にする。
// 純粋な関数だけで作ってあり、画面（React）にもテストにも、そのまま使える。

export const DEFAULT_COLS = 120;
/** 端末の高さ（エージェントが端末に伝える高さと同じ）。CSI H などの基準になる。 */
export const ROWS = 40;
/** 持っておく最大の行数。超えたら、古い行から捨てる。 */
export const MAX_ROWS = 4000;
const MAX_PARAMS = 64;

type State = 'text' | 'esc' | 'csi' | 'osc' | 'oscEsc' | 'skip1';

/** 1 文字の表示幅（0: 結合文字など、1: 普通、2: 全角）。 */
export function charWidth(cp: number): 0 | 1 | 2 {
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x20e3 || cp === 0xfeff) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

export class TermEmu {
  readonly cols: number;
  /** 各行は「1 桁 1 要素」。全角文字は、文字の次の桁に空文字 '' を置く。 */
  private rows: string[][] = [[]];
  private r = 0;
  private c = 0;
  /** 画面（端末の高さ ROWS）の先頭の行。 */
  private top = 0;
  private saved = { r: 0, c: 0 };
  private state: State = 'text';
  private params = '';

  constructor(cols: number = DEFAULT_COLS) {
    this.cols = Math.max(20, Math.floor(cols));
  }

  get cursor(): { row: number; col: number } { return { row: this.r, col: this.c }; }

  reset(): void {
    this.rows = [[]];
    this.r = 0; this.c = 0; this.top = 0;
    this.saved = { r: 0, c: 0 };
    this.state = 'text';
    this.params = '';
  }

  /** 画面の見た目の文字列（行ごと。行末の空白と、下の空行は落とす）。 */
  lines(): string[] {
    const out = this.rows.map((cells) => cells.join('').replace(/\s+$/, ''));
    let end = out.length;
    while (end > 0 && out[end - 1] === '') end -= 1;
    return out.slice(0, end);
  }

  text(): string { return this.lines().join('\n'); }

  write(chunk: string): void {
    for (const ch of chunk) this.feed(ch);
    this.scroll();
  }

  // ---- 内部 ----

  private row(i: number): string[] {
    while (this.rows.length <= i) this.rows.push([]);
    return this.rows[i];
  }

  /** 画面の先頭を、いちばん下の ROWS 行に合わせる。行が多すぎたら、古い行を捨てる。 */
  private scroll(): void {
    this.top = Math.max(this.top, this.rows.length - ROWS);
    if (this.rows.length > MAX_ROWS) {
      const drop = this.rows.length - MAX_ROWS;
      this.rows.splice(0, drop);
      this.r = Math.max(0, this.r - drop);
      this.top = Math.max(0, this.top - drop);
      this.saved.r = Math.max(0, this.saved.r - drop);
    }
  }

  private feed(ch: string): void {
    switch (this.state) {
      case 'text': this.text1(ch); return;
      case 'esc': this.esc1(ch); return;
      case 'csi': this.csi1(ch); return;
      case 'osc':
        if (ch === '\x07') this.state = 'text';
        else if (ch === '\x1b') this.state = 'oscEsc';
        return;
      case 'oscEsc':
        this.state = ch === '\\' ? 'text' : 'esc';
        if (ch !== '\\') this.esc1(ch);
        return;
      case 'skip1': this.state = 'text'; return;
    }
  }

  private text1(ch: string): void {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x1b) { this.state = 'esc'; return; }
    if (cp === 0x0a) { this.r += 1; this.c = 0; this.row(this.r); return; }
    if (cp === 0x0d) { this.c = 0; return; }
    if (cp === 0x08) { this.c = Math.max(0, this.c - 1); return; }
    if (cp === 0x09) { this.c = Math.min(this.cols - 1, (Math.floor(this.c / 8) + 1) * 8); return; }
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) return; // その他の制御文字（ベルなど）は読み捨て
    this.put(ch, charWidth(cp));
  }

  private put(ch: string, w: 0 | 1 | 2): void {
    if (w === 0) {
      // 結合文字: 直前の文字にくっつける
      const row = this.row(this.r);
      let i = this.c - 1;
      if (i >= 0 && row[i] === '') i -= 1;
      if (i >= 0 && row[i] !== undefined) row[i] += ch;
      return;
    }
    if (this.c + w > this.cols) { this.r += 1; this.c = 0; }
    const row = this.row(this.r);
    while (row.length < this.c) row.push(' ');
    // 全角文字の半分だけを上書きしたら、残りの半分は空白にする
    if (row[this.c] === '' && this.c > 0) row[this.c - 1] = ' ';
    if (w === 1 && row[this.c + 1] === '') row[this.c + 1] = ' ';
    row[this.c] = ch;
    if (w === 2) {
      if (row[this.c + 2] === '') row[this.c + 2] = ' ';
      row[this.c + 1] = '';
    }
    this.c += w;
  }

  private esc1(ch: string): void {
    this.state = 'text';
    switch (ch) {
      case '[': this.state = 'csi'; this.params = ''; return;
      case ']': this.state = 'osc'; return;
      case '(': case ')': case '*': case '+': case '#': this.state = 'skip1'; return;
      case '7': this.saved = { r: this.r, c: this.c }; return;
      case '8': this.r = this.saved.r; this.c = this.saved.c; this.row(this.r); return;
      case 'M': this.r = Math.max(0, this.r - 1); return;
      case 'D': this.r += 1; this.row(this.r); return;
      case 'E': this.r += 1; this.c = 0; this.row(this.r); return;
      case 'c': this.reset(); return;
      case '\x1b': this.state = 'esc'; return;
      default: return;
    }
  }

  private csi1(ch: string): void {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x1b) { this.state = 'esc'; return; }
    if (cp >= 0x20 && cp <= 0x3f) { // 引数（数字 ; ?）と中間バイト
      this.params += ch;
      if (this.params.length > MAX_PARAMS) { this.state = 'text'; this.params = ''; }
      return;
    }
    this.state = 'text';
    if (cp >= 0x40 && cp <= 0x7e) this.csi(ch, this.params);
    this.params = '';
  }

  private csi(final: string, params: string): void {
    // 「?」「>」「=」「<」で始まる設定（カーソルの表示・非表示、代替画面など）と、中間バイトつきは読み捨てる
    if (/^[?>=<]/.test(params) || /[ -/]/.test(params)) return;
    const nums = params === '' ? [] : params.split(';').map((s) => (s === '' ? 0 : Number.parseInt(s, 10) || 0));
    const n = (i: number, d: number): number => (nums[i] !== undefined && nums[i] > 0 ? nums[i] : d);
    const row = (): string[] => this.row(this.r);
    switch (final) {
      case 'A': this.r = Math.max(0, this.r - n(0, 1)); return;
      case 'B': this.r += n(0, 1); this.row(this.r); return;
      case 'C': this.c = Math.min(this.cols - 1, this.c + n(0, 1)); return;
      case 'D': this.c = Math.max(0, this.c - n(0, 1)); return;
      case 'E': this.r += n(0, 1); this.c = 0; this.row(this.r); return;
      case 'F': this.r = Math.max(0, this.r - n(0, 1)); this.c = 0; return;
      case 'G': this.c = Math.min(this.cols - 1, n(0, 1) - 1); return;
      case 'd': this.r = this.top + n(0, 1) - 1; this.row(this.r); return;
      case 'H': case 'f':
        this.r = this.top + n(0, 1) - 1;
        this.c = Math.min(this.cols - 1, n(1, 1) - 1);
        this.row(this.r);
        return;
      case 'J': {
        const mode = nums[0] ?? 0;
        if (mode === 0) {
          this.eraseLine(0);
          this.rows.length = this.r + 1;
        } else if (mode === 1) {
          for (let i = this.top; i < this.r; i += 1) this.rows[i] = [];
          this.eraseLine(1);
        } else if (mode === 2) {
          for (let i = this.top; i < this.rows.length; i += 1) this.rows[i] = [];
        } else if (mode === 3) {
          // 画面より上に流れた分を捨てる
          const cut = Math.min(this.top, this.rows.length);
          this.rows.splice(0, cut);
          this.r = Math.max(0, this.r - cut);
          this.saved.r = Math.max(0, this.saved.r - cut);
          this.top = 0;
          this.row(this.r);
        }
        return;
      }
      case 'K': this.eraseLine(nums[0] ?? 0); return;
      case 'X': {
        const cells = row();
        const end = Math.min(this.cols, this.c + n(0, 1));
        for (let i = this.c; i < end && i < cells.length; i += 1) cells[i] = ' ';
        return;
      }
      case 'L': this.rows.splice(this.r, 0, ...Array.from({ length: Math.min(n(0, 1), ROWS) }, () => [] as string[])); return;
      case 'M': this.rows.splice(this.r, n(0, 1)); this.row(this.r); return;
      case '@': {
        const cells = row();
        while (cells.length < this.c) cells.push(' ');
        cells.splice(this.c, 0, ...Array.from({ length: n(0, 1) }, () => ' '));
        if (cells.length > this.cols) cells.length = this.cols;
        return;
      }
      case 'P': row().splice(this.c, n(0, 1)); return;
      case 's': this.saved = { r: this.r, c: this.c }; return;
      case 'u': this.r = this.saved.r; this.c = this.saved.c; this.row(this.r); return;
      default: return; // m（装飾）・h / l（設定）・n（問い合わせ）などは読み捨て
    }
  }

  private eraseLine(mode: number): void {
    const cells = this.row(this.r);
    if (mode === 0) {
      if (this.c > 0 && cells[this.c] === '') cells[this.c - 1] = ' ';
      cells.length = Math.min(cells.length, this.c);
    } else if (mode === 1) {
      for (let i = 0; i <= this.c && i < cells.length; i += 1) cells[i] = ' ';
      if (cells[this.c + 1] === '') cells[this.c + 1] = ' ';
    } else if (mode === 2) {
      cells.length = 0;
    }
  }
}
