// 簡易ターミナルエミュレータ（ノード画面の wizard 用）: エスケープ列を、見た目の文字列に直せるかを確かめる（ネットワークにも実行にも触れない）。
// 実行: npx tsx dev-tests/term-emu.test.ts
import { DEFAULT_COLS, MAX_ROWS, TermEmu, charWidth } from '../src/lib/node/termEmu';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const run = (...chunks: string[]) => { const e = new TermEmu(); for (const c of chunks) e.write(c); return e; };
const text = (...chunks: string[]) => run(...chunks).text();
const ESC = '\x1b';

// --- 文字・改行
ok(text('abc') === 'abc', 'plain text');
ok(text('a\nb') === 'a\nb', 'LF moves down and back to column 0');
ok(text('a\r\nb') === 'a\nb', 'CRLF is one line break');
ok(text('abc\rX') === 'Xbc', 'CR returns to column 0 and overwrites');
ok(text('abc\b\bX') === 'aXc', 'BS moves left');
ok(text('a\tb') === 'a       b', 'Tab goes to the next multiple of 8', JSON.stringify(text('a\tb')));
ok(text('a\x07b') === 'ab', 'bell is dropped');
ok(text('') === '' && run('').lines().length === 0, 'empty');
ok(text('a\n\n\n') === 'a', 'blank lines at the bottom are dropped');
ok(text('a   \nb  ') === 'a\nb', 'trailing spaces are dropped');

// --- 装飾・設定は読み捨て
ok(text(`${ESC}[31mred${ESC}[0m ok`) === 'red ok', 'SGR colors are dropped');
ok(text(`${ESC}[?25lhi${ESC}[?25h`) === 'hi', 'cursor hide / show are dropped');
ok(text(`${ESC}]0;title\x07x`) === 'x', 'OSC (BEL) is dropped');
ok(text(`${ESC}]0;title${ESC}\\x`) === 'x', 'OSC (ST) is dropped');
ok(text(`${ESC}(Bx`) === 'x', 'charset designation is dropped');
ok(text(`${ESC}[6nx`) === 'x', 'device status report is dropped');
ok(text(`${ESC}[>1u${ESC}[=0cx`) === 'x', 'private-prefixed CSI is dropped');
ok(text(`${ESC}[1;2;3;4;5mx`) === 'x', 'long SGR is dropped');

// --- 塊の境目で割れたエスケープ列
ok(text('ab\x1b', '[', '1', 'DX') === 'aX', 'escape sequence split across writes', JSON.stringify(text('ab\x1b', '[', '1', 'DX')));
ok(text('a\x1b', '[', '2', 'Kb') === ' b', 'CSI 2K split across writes clears the line and keeps the column');
ok(text(`${ESC}]0;ti`, 'tle\x07', 'x') === 'x', 'OSC split across writes');

// --- カーソル移動・消去
ok(text(`abc${ESC}[2DX`) === 'aXc', 'CSI D (left)');
ok(text(`abc${ESC}[1;1HX`) === 'Xbc', 'CSI H (home)');
ok(text(`abcdef${ESC}[3GX`) === 'abXdef', 'CSI G (column)');
ok(text(`ab${ESC}[3CX`) === 'ab   X', 'CSI C (right) pads with spaces');
ok(text(`line1\nline2${ESC}[1AX`) === 'line1X\nline2', 'CSI A (up) keeps the column');
ok(text(`line1\nline2${ESC}[1A${ESC}[1BX`) === 'line1\nline2X', 'CSI B (down)');
ok(text(`ab\ncd${ESC}[1F`) === 'ab\ncd', 'CSI F (previous line start)');
ok(text(`ab\n${ESC}[1EX`) === 'ab\n\nX', 'CSI E (next line start)', JSON.stringify(text(`ab\n${ESC}[1EX`)));
ok(text(`abc${ESC}[5AX`) === 'abcX', 'cursor up stops at the first line');
ok(text(`abcdef\r${ESC}[3C${ESC}[K`) === 'abc', 'CSI K (to end of line)');
ok(text(`abcdef\r${ESC}[3C${ESC}[1K`) === '    ef', 'CSI 1K (to start of line)', JSON.stringify(text(`abcdef\r${ESC}[3C${ESC}[1K`)));
ok(text(`abc${ESC}[2Kx`) === '   x', 'CSI 2K (whole line) keeps the cursor column', JSON.stringify(text(`abc${ESC}[2Kx`)));
ok(text(`abcdef\r${ESC}[2C${ESC}[2Xz`) === 'abz ef', 'CSI X (erase chars)', text(`abcdef\r${ESC}[2C${ESC}[2Xz`));
ok(text(`abcdef\r${ESC}[2C${ESC}[2P`) === 'abef', 'CSI P (delete chars)', text(`abcdef\r${ESC}[2C${ESC}[2P`));
ok(text(`abcd\r${ESC}[2C${ESC}[2@`) === 'ab  cd', 'CSI @ (insert chars)', text(`abcd\r${ESC}[2C${ESC}[2@`));
ok(text(`a\nb\nc${ESC}[1A${ESC}[1M`) === 'a\nc', 'CSI M (delete line)', text(`a\nb\nc${ESC}[1A${ESC}[1M`));
ok(text(`a\nb\nc${ESC}[1A${ESC}[1L`) === 'a\n\nb\nc', 'CSI L (insert line)', text(`a\nb\nc${ESC}[1A${ESC}[1L`));
ok(text(`ab${ESC}7cd${ESC}8X`) === 'abXd', 'ESC 7 / ESC 8 (save / restore cursor)', text(`ab${ESC}7cd${ESC}8X`));
ok(text(`ab${ESC}[scd${ESC}[uX`) === 'abXd', 'CSI s / u (save / restore cursor)');
ok(text(`a\nb${ESC}Mc`) === 'ac\nb', 'ESC M (reverse index)', text(`a\nb${ESC}Mc`));

// --- 画面の消去
ok(text(`old\nlines${ESC}[2J${ESC}[Hnew`) === 'new', 'clear screen + home', text(`old\nlines${ESC}[2J${ESC}[Hnew`));
ok(text(`a\nb\nc${ESC}[1A${ESC}[0J`) === 'a\nb', 'CSI 0J (to end of screen)', text(`a\nb\nc${ESC}[1A${ESC}[0J`));
ok(text(`a\nb\nc${ESC}[1A\r${ESC}[1J`) === '\n\nc', 'CSI 1J (to start of screen)', JSON.stringify(text(`a\nb\nc${ESC}[1A\r${ESC}[1J`)));
ok(text(`x${ESC}[3J${ESC}[Hy`) === 'y', 'CSI 3J then home');
ok(text(`a${ESC}c`) === '', 'ESC c (reset)');

// --- 折り返し・全角
{
  const e = new TermEmu(20);
  e.write('0123456789012345678901234');
  ok(e.lines().length === 2 && e.lines()[0].length === 20 && e.lines()[1] === '01234', 'wraps at the column count', e.lines());
}
ok(charWidth(0x65e5) === 2 && charWidth(0x41) === 1 && charWidth(0x0301) === 0 && charWidth(0x276f) === 1, 'charWidth');
ok(text('日本') === '日本', 'wide chars');
ok(text(`日本${ESC}[2DX`) === '日X', 'overwriting half of a wide char blanks the rest', JSON.stringify(text(`日本${ESC}[2DX`)));
ok(text(`日本${ESC}[3DX`) === ' X本', 'overwriting the second half of a wide char blanks the first', JSON.stringify(text(`日本${ESC}[3DX`)));
ok(text('e\u0301x') === 'e\u0301x', 'combining char attaches to the previous one');
{
  const e = new TermEmu(20);
  e.write('0123456789012345678日');
  ok(e.lines().join('|') === '0123456789012345678|日', 'a wide char that does not fit moves to the next line', e.lines());
}

// --- inquirer 風の再描画（これが、選択式の画面が重なって出ていた原因）
{
  const eraseLines = (n: number) => { let s = ''; for (let i = 0; i < n; i++) s += `${ESC}[2K${i < n - 1 ? `${ESC}[1A` : ''}`; return `${s}${ESC}[G`; };
  const frame = (sel: number) => ['? Select preset', ...['bootstrap', 'testnet', 'mainnet'].map((o, i) => `${i === sel ? '❯' : ' '} ${o}`)].join('\n');
  const e = new TermEmu();
  e.write(`${ESC}[?25l${frame(0)}`);
  for (const sel of [1, 2, 1, 0]) e.write(`${eraseLines(4)}${frame(sel)}`);
  const lines = e.lines();
  ok(lines.length === 4, 'redraw: the same lines do not pile up', lines);
  ok(lines[0] === '? Select preset' && lines[1] === '❯ bootstrap' && lines[2] === '  testnet' && lines[3] === '  mainnet', 'redraw: only the last frame is shown', lines);
  // 決定したあとは、1 行にまとまる（消して書き直す）
  e.write(`${eraseLines(4)}? Select preset bootstrap\r\n${ESC}[?25h`);
  ok(e.text() === '? Select preset bootstrap', 'redraw: the answered prompt collapses to one line', e.text());
  // 画面を作り直す方式（行を消さず、カーソルを戻して上書き）も同じ
  const e2 = new TermEmu();
  e2.write(frame(0));
  e2.write(`${ESC}[3A\r${frame(2)}`);
  ok(e2.lines()[1] === '  bootstrap' && e2.lines()[3] === '❯ mainnet' && e2.lines().length === 4, 'redraw: cursor-up and overwrite', e2.lines());
}

// --- 大量の出力
{
  const e = new TermEmu();
  let big = '';
  for (let i = 0; i < MAX_ROWS + 500; i++) big += `line ${i}\n`;
  e.write(big);
  ok(e.lines().length <= MAX_ROWS, 'old lines are dropped past the limit', e.lines().length);
  ok(e.lines()[e.lines().length - 1] === `line ${MAX_ROWS + 499}`, 'the newest line is kept');
  e.write(`${ESC}[2J${ESC}[Hok`);
  ok(e.lines().pop() === 'ok', 'clear works after trimming');
  e.reset();
  ok(e.text() === '' && e.cursor.row === 0 && e.cursor.col === 0, 'reset');
}
ok(new TermEmu(5).cols === 20 && new TermEmu().cols === DEFAULT_COLS, 'columns: lower bound and default');
// でたらめな入力でも、止まらず落ちない
{
  const e = new TermEmu();
  let junk = '';
  for (let i = 0; i < 20000; i++) junk += String.fromCharCode((i * 7919) % 256);
  e.write(junk);
  e.write(`${ESC}[`.repeat(200) + 'x');
  ok(e.lines().length <= MAX_ROWS, 'garbage input is survived');
}

console.log(`${checks} checks, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
