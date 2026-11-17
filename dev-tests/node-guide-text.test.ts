// 「Shoestring でノードを建てる手順」の説明文の整形（src/lib/node/guideText.ts）を確かめる。
// 実行: npx tsx dev-tests/node-guide-text.test.ts
import { readFileSync } from 'node:fs';
import { parseGuideText, parseInline, type GuideBlock, type Inline } from '../src/lib/node/guideText';
import { SHOESTRING_STEPS } from '../src/lib/node/shoestringGuide';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const plain = (parts: Inline[]) => parts.map((p) => p.text).join('');
const codes = (parts: Inline[]) => parts.filter((p) => p.kind === 'code').map((p) => p.text);
const lists = (bs: GuideBlock[]) => bs.filter((b): b is Extract<GuideBlock, { type: 'list' }> => b.type === 'list');

// --- インライン
{
  const p = parseInline('`docker compose up -d` で起動し、config.ini と --package を見る');
  ok(codes(p).join('|') === 'docker compose up -d|config.ini|--package', 'inline: backticks + file name + flag', p);
  ok(plain(p) === 'docker compose up -d で起動し、config.ini と --package を見る', 'inline: text is kept as is', plain(p));
  ok(codes(parseInline('ca.key.pem と linking_transaction.dat と docker-compose-recovery.yaml')).join('|') === 'ca.key.pem|linking_transaction.dat|docker-compose-recovery.yaml', 'inline: several file names');
  ok(codes(parseInline('symbol-node/config.ini')).length === 0, 'inline: a path is left alone (not half-styled)');
  ok(codes(parseInline('pip install --upgrade symbol-shoestring')).join('|') === '--upgrade', 'inline: flag only');
  ok(codes(parseInline('https://example.com/a.ini')).length === 0, 'inline: URL is left alone');
}

// --- 見出し・段落・空行
{
  const bs = parseGuideText('最初の段落。\n同じ段落ではなく、狭いまま別の段落。\n\n## 見出し\n本文');
  ok(bs.map((b) => b.type).join() === 'paragraph,paragraph,heading,paragraph', 'blocks: paragraph, paragraph, heading, paragraph', bs.map((b) => b.type));
  ok(bs[0].loose === false && bs[1].loose === false && bs[2].loose === true && bs[3].loose === false, 'blocks: blank line makes the next block loose');
}

// --- 見出し語（太字）
{
  const a = parseGuideText('使う理由: 以前は symbol-bootstrap でした')[0];
  ok(a.type === 'paragraph' && a.label === '使う理由:' && plain(a.body) === '以前は symbol-bootstrap でした', 'label: ascii colon', a);
  const b = parseGuideText('特徴：ノードの役割')[0];
  ok(b.type === 'paragraph' && b.label === '特徴：' && plain(b.body) === 'ノードの役割', 'label: full-width colon without a space', b);
  const c = parseGuideText('Insufficient funds（資金不足）: 資金を送る')[0];
  ok(c.type === 'paragraph' && c.label === 'Insufficient funds（資金不足）:', 'label: trailing parenthesis allowed', c);
  const d = parseGuideText('（例: PEER | API）')[0];
  ok(d.type === 'paragraph' && d.label === undefined, 'label: a line starting with a parenthesis is not a label', d);
  const e = parseGuideText('http://localhost:3000 を開く')[0];
  ok(e.type === 'paragraph' && e.label === undefined, 'label: URL colon is not a label', e);
  const f = parseGuideText('これは、とても長い文で、コロンの前が見出し語にならない: 本文')[0];
  ok(f.type === 'paragraph' && f.label === undefined, 'label: a sentence with 、 is not a label', f);
  const g = parseGuideText('`openssl version`: 確認')[0];
  ok(g.type === 'paragraph' && g.label === undefined, 'label: code before the colon is not a label', g);
}

// --- 箇条書き（・ / - / 入れ子 / 補足の行）
{
  const bs = parseGuideText('・一つ目\n・二つ目: 説明\n　・入れ子A\n　・入れ子B\n　補足の行\n・三つ目');
  const l = lists(bs);
  ok(bs.length === 1 && l.length === 1 && !l[0].ordered && l[0].items.length === 3, 'bullets: one list of 3', bs);
  ok(l[0].items[1].label === '二つ目:' && l[0].items[1].children.length === 2, 'bullets: label + 2 children', l[0].items[1]);
  const last = l[0].items[1].children[1];
  ok(last.notes.length === 1 && plain(last.notes[0]) === '補足の行', 'bullets: indented plain line becomes a note of the last child', last);
  ok(plain(l[0].items[2].body) === '三つ目', 'bullets: next top-level item continues the list');

  const en = lists(parseGuideText('- deploy\n- migrate\n  - sub\n  indented note'));
  ok(en.length === 1 && en[0].items.length === 2 && en[0].items[1].children.length === 1, 'bullets: "- " and 2-space indent (en/ko/zh/ru style)', en);
  ok(en[0].items[1].children[0].notes.length === 1, 'bullets: 2-space indented plain line is a note');

  const flag = parseGuideText('--output-transaction-only を付ける')[0];
  ok(flag.type === 'paragraph', 'bullets: a line starting with --option is not a bullet', flag);
}

// --- 番号つき
{
  const bs = parseGuideText('① 一\n② 二\n\n1) one\n2) two: detail\n  - Unknown: x');
  const l = lists(bs);
  ok(l.length === 2 && l.every((x) => x.ordered), 'numbered: two ordered lists', bs);
  ok(l[0].items.map((i) => i.marker).join() === '①,②' && l[1].items.map((i) => i.marker).join() === '1),2)', 'numbered: markers are kept as written', l);
  ok(l[1].items[1].label === 'two:' && l[1].items[1].children.length === 1, 'numbered: label and child bullet', l[1].items[1]);
  const dot = lists(parseGuideText('1. Update Shoestring: pip\n2. Stop the node'));
  ok(dot.length === 1 && dot[0].ordered && dot[0].items.map((i) => i.marker).join() === '1.,2.' && dot[0].items[0].label === 'Update Shoestring:', 'numbered: "1. " style (en/ru/zh/ko upgrade steps)', dot);
  ok(parseGuideText('3.10 以降の Python')[0].type === 'paragraph' && parseGuideText('3.10 以降の Python').length === 1, 'numbered: "3.10" is a version, not a step');
  const mixed = parseGuideText('① 手順\n・箇条書き');
  ok(mixed.length === 2 && lists(mixed)[0].ordered && !lists(mixed)[1].ordered, 'numbered: a top-level bullet after steps starts a new list', mixed);
}

// --- 補足・注意
{
  const [a, b] = parseGuideText('> 補足です\n>! 注意: 気をつけて');
  ok(a.type === 'callout' && !a.warn && plain(a.body) === '補足です', 'callout: info', a);
  ok(b.type === 'callout' && b.warn && b.label === '注意:' && plain(b.body) === '気をつけて', 'callout: warning with label', b);
}

// --- 空白・改行コード
{
  ok(parseGuideText('').length === 0 && parseGuideText('\n\n  \n').length === 0, 'empty text gives no blocks');
  ok(parseGuideText('a\r\n\r\nb').length === 2 && parseGuideText('a\r\n\r\nb')[1].loose, 'CRLF is handled');
}

// --- 実際の文章: 5 つの言語すべてで、説明文が整形を通り、記号が画面に残らない
const readJson = (f: string) => JSON.parse(readFileSync(new URL(`../src/i18n/${f}`, import.meta.url), 'utf-8')) as Record<string, any>;
const findService = (o: any): Record<string, string> | undefined => {
  if (o && typeof o === 'object') {
    if (typeof o.node_ss_overview_body === 'string') return o;
    for (const v of Object.values(o)) { const r = findService(v); if (r) return r; }
  }
  return undefined;
};
const messages = readJson('messages.json');
const langs: Record<string, Record<string, string>> = {
  ja: messages.ja.service,
  en: messages.en.service,
  ru: findService(readJson('ru.json'))!,
  zh: findService(readJson('zh.json'))!,
  ko: findService(readJson('ko.json'))!,
};
const textKeys = ['node_ss_intro', 'node_ss_overview_body', ...SHOESTRING_STEPS.map((s) => `node_ss_${s.id}_body`)];

for (const [lang, s] of Object.entries(langs)) {
  ok(!!s, `${lang}: service strings found`);
  if (!s) continue;
  for (const k of textKeys) {
    const src = s[k];
    ok(typeof src === 'string' && src.length > 0, `${lang}: ${k} exists`);
    if (typeof src !== 'string') continue;
    const bs = parseGuideText(src);
    ok(bs.length > 0, `${lang}: ${k} gives blocks`);
    // 記号（## ・ > ` の書き方）が、そのまま画面に出ないこと
    const shown: string[] = [];
    const add = (parts: Inline[]) => shown.push(plain(parts));
    const addItem = (i: any) => { if (i.label) shown.push(i.label); add(i.body); i.notes.forEach(add); i.children.forEach(addItem); };
    for (const b of bs) {
      if (b.type === 'heading') add(b.text);
      else if (b.type === 'list') b.items.forEach(addItem);
      else { if (b.label) shown.push(b.label); add(b.body); }
    }
    const all = shown.join('\n');
    ok(!all.includes('`'), `${lang}: ${k} has no stray backtick`, all.match(/.{0,20}`.{0,20}/)?.[0]);
    ok(!/^## /m.test(all) && !/^>!? /m.test(all), `${lang}: ${k} has no raw ## or >`, all.slice(0, 80));
  }
}

// ノード画面の説明文（node_ss_ 以外）も、5 つの言語すべてで、記号が画面に残らず、見出し語にコードが混ざらない
{
  const nodeKeys = ['node_conn_howto', 'node_link_hint', 'node_allowed_body', 'node_link_none', 'node_warn_testnet', 'node_wd_intro', 'node_docker_howto', 'node_wizard_hint', 'node_watch_intro', 'node_ar_note', 'node_link_note', 'node_wizard_needs_pty', 'node_files_hint', 'node_uninstall_hint', 'node_un_keeps_body', 'node_watch_note'];
  for (const [lang, s] of Object.entries(langs)) {
    for (const k of nodeKeys) {
      ok(typeof s[k] === 'string' && s[k] !== '', `${lang}: ${k} exists`);
      if (typeof s[k] !== 'string') continue;
      const labels: string[] = [];
      const walk = (i: any) => { if (i.label) labels.push(i.label); i.children.forEach(walk); };
      for (const b of parseGuideText(s[k])) { if (b.type === 'list') b.items.forEach(walk); else if (b.type !== 'heading' && b.label) labels.push(b.label); }
      ok(labels.every((l) => !l.includes('`')), `${lang}: ${k} label has no backtick`, labels);
    }
  }
  // 2 つのコードを含む行が、見出し語にならないこと
  const c = parseGuideText('証明書（`node.crt.pem`）: ここから読みます')[0];
  ok(c.type === 'paragraph' && c.label === undefined && codes(c.body).join() === 'node.crt.pem', 'label: code inside the parenthesis is not a label', c);
}

// 日本語は、見出し・箇条書き・番号・注意の枠を使って組み直してある（長い 1 本の文章ではない）
{
  const ja = langs.ja;
  const kinds = (k: string) => new Set(parseGuideText(ja[k]).map((b) => b.type));
  ok(kinds('node_ss_overview_body').has('heading') && kinds('node_ss_overview_body').has('list'), 'ja overview: headings and lists');
  ok(kinds('node_ss_harvest_body').has('list') && lists(parseGuideText(ja.node_ss_harvest_body)).some((l) => l.ordered && l.items.some((i) => i.children.length > 0)), 'ja harvest: numbered steps with nested status list');
  ok(kinds('node_ss_start_body').has('callout'), 'ja start: has a warning callout');
  ok(kinds('node_ss_upgrade_body').has('list') && lists(parseGuideText(ja.node_ss_upgrade_body))[0].items.length === 4, 'ja upgrade: 4 numbered steps');
  // 段落が長すぎないこと（1 つの段落・項目が 220 文字を超えない）
  for (const k of textKeys) {
    for (const b of parseGuideText(ja[k])) {
      const lens: number[] = [];
      if (b.type === 'paragraph' || b.type === 'callout') lens.push(plain(b.body).length);
      if (b.type === 'list') b.items.forEach((i) => lens.push(plain(i.body).length));
      for (const n of lens) ok(n <= 220, `ja: ${k} has no overlong paragraph (${n} chars)`);
    }
  }
}

// --- 手順番号の参照: 投票キーの更新（renew-voting-keys）は「保守」の手順にある。どの言語でも、その番号で案内していること
{
  const n = SHOESTRING_STEPS.findIndex((s) => s.id === 'maintain') + 1;
  for (const [lang, s] of Object.entries(langs)) {
    const body = s?.node_ss_voting_body ?? '';
    ok(body.includes('renew-voting-keys'), `${lang}: voting body mentions renew-voting-keys`);
    ok(new RegExp(`(?<!\\d)${n}(?!\\d)`).test(body), `${lang}: voting body points to step ${n} (maintain)`, body.match(/.{0,20}renew-voting-keys.{0,5}/)?.[0]);
    ok(!/(?<!\d)14(?!\d)/.test(body), `${lang}: voting body no longer points to step 14 (upgrade)`);
  }
  // 入れ替えてよい: 参照先の手順が、いまの番号と合っていること（ja の本文の「手順 N」）
  const idx = (id: string) => SHOESTRING_STEPS.findIndex((s) => s.id === id) + 1;
  const jaRefs: Array<[string, string, number]> = [
    ['node_ss_intro', '手順 7 で取り込めます', idx('identity')],
    ['node_ss_config_body', '手順 6', idx('overrides')],
    ['node_ss_identity_body', '（手順 11）', idx('start')],
    ['node_ss_identity_body', '手順 9 で資金', idx('harvest')],
    ['node_ss_install_body', '手順 14 の', idx('upgrade')],
    ['node_ss_init_body', '手順 11 から', idx('start')],
    ['node_ss_harvest_body', '手順 7 の', idx('identity')],
    ['node_ss_maintain_body', '手順 14「', idx('upgrade')],
    ['node_ss_maintain_body', '手順 9 の', idx('harvest')],
  ];
  for (const [k, needle, expected] of jaRefs) {
    ok(langs.ja[k].includes(needle), `ja ${k}: contains "${needle}"`);
    ok(needle.includes(`手順 ${expected}`), `ja ${k}: "${needle}" matches the step number ${expected}`);
  }
}

console.log(`${checks} checks, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
