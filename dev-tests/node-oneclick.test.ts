// 「ノード構築」: 組み立てる手順が、許可の判定をすべて通ること・config.ini の書き換え・入力の確認・説明文（ja / en）が揃っていること。
// 実行: npx tsx dev-tests/node-oneclick.test.ts
import { readFileSync } from 'node:fs';
import { parseCommandLine, validateSubdir, validateWorkspaceFile } from '../src/lib/node/nodeCommands';
import { applyConfig, defaultOptions, featuresValue, isValidHost, missingTools, overridesContent, planStop, planSteps, planUpdate, setIniValues, toolsReady, validateDir, validateOptions } from '../src/lib/node/oneClick';
import type { OneClickOptions } from '../src/lib/node/oneClick';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

// --- ボタンを押せる条件
const t = (d: boolean, p: boolean, s: boolean) => ({ docker: { found: d }, python: { found: p }, shoestring: { found: s } });
ok(toolsReady(t(true, true, true)), 'ready when all three found');
for (const [d, p, s] of [[false, true, true], [true, false, true], [true, true, false], [false, false, false]] as const) ok(!toolsReady(t(d, p, s)), `not ready: ${d}/${p}/${s}`);
ok(missingTools(t(false, true, false)).join() === 'docker,shoestring', 'missingTools lists the absent ones');

// --- features
ok(featuresValue({ harvesting: false, voting: false }) === 'PEER | API', 'features: plain');
ok(featuresValue({ harvesting: true, voting: false }) === 'PEER | API | HARVESTER', 'features: harvesting');
ok(featuresValue({ harvesting: false, voting: true }) === 'PEER | API | VOTER', 'features: voting');
ok(featuresValue({ harvesting: true, voting: true }) === 'PEER | API | HARVESTER | VOTER', 'features: both');

// --- 手順: すべて、許可の判定を通る（秘密鍵が出る形・wizard は使わない）。作業フォルダも通る
for (const net of ['mainnet', 'testnet'] as const) for (const h of [false, true]) for (const v of [false, true]) {
  const o: OneClickOptions = { ...defaultOptions(), network: net, harvesting: h, voting: v };
  const steps = planSteps(o);
  ok(steps.length > 0 && new Set(steps.map((s) => s.id)).size === steps.length, 'step ids unique');
  for (const s of steps) {
    if (s.kind !== 'run') continue;
    const r = parseCommandLine(s.line ?? '', {});
    ok(r.ok, `allowed without wizard/secret: ${s.line}`, r);
    ok(validateSubdir(s.cwd ?? '').ok, `cwd ok: ${s.cwd}`);
  }
  const setup = steps.find((s) => s.id === 'setup')?.line ?? '';
  ok(setup.includes(`--package ${net === 'mainnet' ? 'mainnet' : 'sai'} `), `package for ${net}`);
}
ok(planSteps(defaultOptions()).map((s) => s.id).join() === 'docker_up,openssl,init,config,overrides,key,setup,start,ps', 'step order');

// --- 停止・更新: すべて許可の判定を通る。更新は公式の順（pip → down → upgrade → up → 確認）で、overrides.ini が無いときは --overrides を付けない
for (const [name, steps] of [['stop', planStop({ dir: 'n1' })], ['update+ov', planUpdate({ dir: 'n1' }, true)], ['update', planUpdate({ dir: 'n1' }, false)]] as const) {
  for (const s of steps) { const r = parseCommandLine(s.line ?? '', {}); ok(r.ok, `${name}: allowed: ${s.line}`, r); ok(validateSubdir(s.cwd ?? '').ok, `${name}: cwd ok`); }
}
ok(planStop({ dir: 'n1' }).map((s) => s.id).join() === 'docker_up,down', 'stop order');
ok(planUpdate({ dir: 'n1' }, true).map((s) => s.id).join() === 'docker_up,pip,down,upgrade,start,ps', 'update order');
ok(planUpdate({ dir: 'n1' }, true).find((s) => s.id === 'upgrade')?.line === 'python3 -m shoestring upgrade --config config.ini --directory . --overrides overrides.ini', 'update with overrides');
ok(planUpdate({ dir: 'n1' }, false).find((s) => s.id === 'upgrade')?.line === 'python3 -m shoestring upgrade --config config.ini --directory .', 'update without overrides');
ok(planStop({ dir: 'n1' })[1].cwd === 'n1' && planUpdate({ dir: 'n1' }, true)[1].cwd === '', 'cwd: node folder for compose, workspace for pip');
ok(validateDir('symbol-node') && !validateDir('') && !validateDir('tools') && !validateDir('../x'), 'validateDir');

// --- 入力の確認
ok(validateOptions(defaultOptions()) === null, 'defaults are valid');
for (const dir of ['', '.', '..', '../x', '/abs', 'C:/x', 'tools', 'Tools/x', 'a/../b', 'con', 'a:b']) ok(validateOptions({ ...defaultOptions(), dir }) === 'dir', `bad dir: ${dir}`);
ok(validateOptions({ ...defaultOptions(), dir: 'nodes/main' }) === null, 'nested dir ok');
ok(validateOptions({ ...defaultOptions(), friendlyName: '' }) === 'name', 'empty name');
ok(validateOptions({ ...defaultOptions(), friendlyName: 'a\nb' }) === 'name', 'newline in name');
ok(validateOptions({ ...defaultOptions(), friendlyName: 'x'.repeat(65) }) === 'name', 'long name');
for (const host of ['my-node.example.com', '203.0.113.5', '2001:db8::1', '']) ok(validateOptions({ ...defaultOptions(), host }) === null, `host ok: ${host}`);
for (const host of ['a b', 'a\nb', 'x;y', 'http://x', '-a.com', 'a..b', 'a=b']) ok(validateOptions({ ...defaultOptions(), host }) === 'host', `host bad: ${host}`);
ok(isValidHost('localhost'), 'localhost is a syntactically valid host');
ok(validateWorkspaceFile('symbol-node/config.ini').ok && validateWorkspaceFile('symbol-node/overrides.ini').ok, 'editable files are allowed by the agent policy');

// --- overrides.ini
ok(overridesContent({ friendlyName: 'N', host: '' }) === '[node.localnode]\nfriendlyName = N\n', 'overrides without host');
ok(overridesContent({ friendlyName: 'N', host: 'h.example.com' }) === '[node.localnode]\nhost = h.example.com\nfriendlyName = N\n', 'overrides with host');

// --- config.ini の書き換え
const SAMPLE = `[network]\nname = mainnet\n\n[node]\n; roles\nfeatures = PEER | API | HARVESTER\ncaCommonName =\nnodeCommonName =\napiHttps = false\n\n[images]\nclient = symbolplatform/symbol-server:gcc-x\n`;
const out = applyConfig(SAMPLE, { ...defaultOptions(), harvesting: false, voting: true, friendlyName: 'Foo' });
ok(out.includes('features = PEER | API | VOTER\n'), 'features replaced', out);
ok(out.includes('caCommonName = Foo CA\n') && out.includes('nodeCommonName = Foo\n'), 'common names filled', out);
ok(out.includes('apiHttps = false\n') && out.includes('[images]\nclient = symbolplatform/symbol-server:gcc-x\n') && out.includes('[network]\nname = mainnet\n'), 'other sections untouched', out);
ok((out.match(/features/g) ?? []).length === 1, 'features not duplicated');
// キーが無いときは、セクションの中に足す（次のセクションの前）
const out2 = setIniValues('[node]\nfoo = 1\n\n[images]\na = b\n', 'node', { features: 'PEER | API' });
ok(out2 === '[node]\nfoo = 1\nfeatures = PEER | API\n\n[images]\na = b\n', 'append inside section', JSON.stringify(out2));
// セクションが無いときは、末尾に作る
ok(setIniValues('[a]\nx = 1\n', 'node', { features: 'PEER' }) === '[a]\nx = 1\n\n[node]\nfeatures = PEER\n', 'create section', JSON.stringify(setIniValues('[a]\nx = 1\n', 'node', { features: 'PEER' })));
// CRLF（Windows）は保つ
const crlf = setIniValues('[node]\r\nfeatures = PEER\r\nx = 1\r\n', 'node', { features: 'PEER | API' });
ok(crlf === '[node]\r\nfeatures = PEER | API\r\nx = 1\r\n', 'CRLF kept', JSON.stringify(crlf));
// 同じキーが別のセクションにあっても、対象のセクションだけ
const out3 = setIniValues('[a]\nfeatures = X\n[node]\nfeatures = Y\n', 'node', { features: 'Z' });
ok(out3 === '[a]\nfeatures = X\n[node]\nfeatures = Z\n', 'only target section', JSON.stringify(out3));
// コメントアウトされた行は、キーとして扱わない
const out4 = setIniValues('[node]\n; features = old\n', 'node', { features: 'Z' });
ok(out4.includes('; features = old') && out4.includes('\nfeatures = Z'), 'commented key untouched', JSON.stringify(out4));
// 冪等: 2 回かけても同じ
ok(applyConfig(out, { ...defaultOptions(), voting: true, friendlyName: 'Foo' }) === out, 'idempotent');

// --- 説明文（ja / en）
const messages = JSON.parse(readFileSync(new URL('../src/i18n/messages.json', import.meta.url), 'utf-8')) as Record<'ja' | 'en', { service: Record<string, string> }>;
const keys = [
  'title', 'intro', 'needs', 'need_docker', 'need_python', 'need_shoestring', 'dir', 'dir_hint', 'network', 'net_mainnet', 'net_testnet', 'harvesting', 'harvesting_hint', 'voting', 'voting_hint',
  'name', 'host', 'host_hint', 'build', 'building', 'stop', 'exists', 'err_dir', 'err_name', 'err_host', 'cancelled', 'failed', 'done', 'done_key', 'done_harvest', 'done_voting', 'go_guide', 'testnet_note', 'mainnet_note',
  'update', 'updating', 'stop_node', 'stopping', 'manage_hint', 'no_node', 'confirm_stop', 'confirm_update', 'failed_manage', 'done_stop', 'done_update',
  ...[...planSteps(defaultOptions()), ...planStop(defaultOptions()), ...planUpdate(defaultOptions(), true)].map((s) => `step_${s.id}`), ...['docker_up', 'openssl', 'init', 'setup', 'start', 'down', 'pip', 'upgrade'].map((s) => `hint_${s}`),
];
for (const lang of ['ja', 'en'] as const) for (const k of keys) ok(typeof messages[lang].service[`node_oc_${k}`] === 'string' && messages[lang].service[`node_oc_${k}`] !== '', `${lang} text: node_oc_${k}`);

console.log(`${checks} checks, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
