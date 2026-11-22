// 「Shoestring でノードを建てる手順」の説明文（i18n の文字列）を、画面で読みやすく並べるための読み取り処理。
// 表示は pages/node/GuideText.tsx。ここは React を使わない（dev-tests/node-guide-text.test.ts で確かめる）。
//
// 文字列には、次のような軽い書き方を使える。書き方を知らない言語の文字列でも、そのまま読める（何も起きないだけ）。
//
//   ## 見出し                     見出し（左に線）
//   ・箇条書き   /   - 箇条書き    行頭が「・」か「- 」
//   ① 番号つき  /  1) 番号つき  /  1. 番号つき     行頭が丸数字か「数字)」「数字. 」（番号はそのまま見せる）
//   　・ひとつ下の箇条書き          行頭に全角スペース（半角スペース 2 つ以上でも可）を付けると、直前の項目の下にぶら下がる
//   　補足の行                     同じく、行頭を下げた箇条書きでない行は、直前の項目の下に小さく出る
//   > 補足                        枠つきの補足（青）
//   >! 注意                       枠つきの注意（黄）
//   語: 本文                      行頭の「語:」「語：」は太字（32 文字まで。。や、を含むものは見出し語にしない）
//   `コード`                      等幅
//   空行                          段落のあいだを広くする（空行なしの改行は、狭いまま別の段落になる）
//
// ファイル名（config.ini など）と --オプション は、`` で囲まなくても等幅になる。

export interface Inline {
  kind: 'text' | 'code';
  text: string;
}

export interface GuideItem {
  /** 番号つきの項目の番号（「①」「1)」）。箇条書きでは空 */
  marker: string;
  /** 太字にする見出し語（コロンつき）。無ければ undefined */
  label?: string;
  body: Inline[];
  /** 項目の下に小さく出す補足の行 */
  notes: Inline[][];
  /** ひとつ下の箇条書き */
  children: GuideItem[];
}

export type GuideBlock =
  | { type: 'heading'; text: Inline[]; loose: boolean }
  | { type: 'paragraph'; label?: string; body: Inline[]; loose: boolean }
  | { type: 'callout'; warn: boolean; label?: string; body: Inline[]; loose: boolean }
  | { type: 'list'; ordered: boolean; items: GuideItem[]; loose: boolean };

// 行頭が「・」か「- 」「* 」「• 」（「--option」で始まる行は箇条書きにしない）
const BULLET = /^(?:・|[-*•]\s)\s*(.*)$/;
// 行頭が丸数字（①〜⑳）、「1)」、「1. 」（「3.10」のような版の番号は、番号にしない）
const NUMBERED = /^(?:([①-⑳])\s*|(\d{1,2}\))\s*|(\d{1,2}\.)\s+)(.*)$/;
// 行頭の「語:」。半角のコロンは後ろに空白があるときだけ（http:// などを巻き込まない）。（ ）は末尾に 1 つだけ許す
const LABEL = /^((?:[^:：。、`（）()]){1,32}(?:（[^（）`]{1,16}）)?)(：\s*|:\s+)(\S[\s\S]*)$/;
// 囲まなくても等幅にするもの: ファイル名（.ini .pem .dat .yaml .yml）と --オプション
const AUTO_CODE = /(^|[^\w./-])((?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:ini|pem|dat|ya?ml))|(?:--[a-z][a-z0-9-]*))(?![\w-])/g;

function autoCode(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  AUTO_CODE.lastIndex = 0;
  for (let m = AUTO_CODE.exec(text); m; m = AUTO_CODE.exec(text)) {
    const start = m.index + m[1].length;
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
    out.push({ kind: 'code', text: m[2] });
    last = start + m[2].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** `…` で囲んだ所を等幅に、それ以外は autoCode に通す。 */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const re = /`([^`\n]+)`/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push(...autoCode(s.slice(last, m.index)));
    out.push({ kind: 'code', text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(...autoCode(s.slice(last)));
  return out;
}

function splitLabel(s: string): { label?: string; body: Inline[] } {
  const m = LABEL.exec(s);
  if (m) return { label: `${m[1].trim()}${m[2].trim()}`, body: parseInline(m[3]) };
  return { body: parseInline(s) };
}

export function parseGuideText(text: string): GuideBlock[] {
  const blocks: GuideBlock[] = [];
  let loose = false; // 直前に空行があった
  let list: Extract<GuideBlock, { type: 'list' }> | null = null;

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.trim() === '') {
      loose = true;
      list = null;
      continue;
    }
    const indented = /^(?:\u3000| {2,}|\t)/.test(raw);
    const line = raw.trim();

    if (line.startsWith('## ')) {
      blocks.push({ type: 'heading', text: parseInline(line.slice(3).trim()), loose });
      list = null;
      loose = false;
      continue;
    }

    const callout = /^>(!?)\s?(.*)$/.exec(line);
    if (callout) {
      const { label, body } = splitLabel(callout[2]);
      blocks.push({ type: 'callout', warn: callout[1] === '!', label, body, loose });
      list = null;
      loose = false;
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = numbered !== null;
      const { label, body } = splitLabel(bullet ? bullet[1] : numbered![4]);
      const item: GuideItem = { marker: numbered ? (numbered[1] ?? numbered[2] ?? numbered[3]) : '', label, body, notes: [], children: [] };
      if (indented && list && list.items.length > 0) {
        list.items[list.items.length - 1].children.push(item);
      } else {
        if (!list || list.ordered !== ordered) {
          list = { type: 'list', ordered, items: [], loose };
          blocks.push(list);
        }
        list.items.push(item);
      }
      loose = false;
      continue;
    }

    if (indented && list && list.items.length > 0) {
      const last = list.items[list.items.length - 1];
      const target = last.children.length > 0 ? last.children[last.children.length - 1] : last;
      target.notes.push(parseInline(line));
      loose = false;
      continue;
    }

    list = null;
    const { label, body } = splitLabel(line);
    blocks.push({ type: 'paragraph', label, body, loose });
    loose = false;
  }
  return blocks;
}
