// 「Shoestring でノードを建てる手順」: 手順の中のひな型が、許可の判定を通ることと、説明文（ja / en）が揃っていることを確かめる。
// 実行: npx tsx dev-tests/node-shoestring-guide.test.ts
import { readFileSync } from 'node:fs';
import { COMMAND_PRESETS, isWizardArgv, parseCommandLine, validateSubdir, validateWorkspaceFile } from '../src/lib/node/nodeCommands';
import { OVERRIDES_TEMPLATE, SHOESTRING_STEPS } from '../src/lib/node/shoestringGuide';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const messages = JSON.parse(readFileSync(new URL('../src/i18n/messages.json', import.meta.url), 'utf-8')) as Record<'ja' | 'en', { service: Record<string, string> }>;

// --- pemview は通る（アドレスと公開鍵を見るだけ）。秘密鍵を出すフラグは、これまでどおり通さない
ok(parseCommandLine('shoestring pemview --input ca.key.pem --network mainnet').ok, 'pemview allowed');
ok(!parseCommandLine('shoestring pemview --input ca.key.pem --show-private').ok, 'pemview --show-private refused without the secret confirmation');
ok(!parseCommandLine('shoestring pemview --input ca.key.pem --show-private=1').ok, 'pemview --show-private=1 refused without the secret confirmation');

// --- 公式の手順にある、この画面では通さないもの（別のターミナルで行う）は、通らないまま
for (const line of [
  'python3 -m shoestring.wizard',
  'openssl genpkey -algorithm ed25519 -out /etc/ca.key.pem',
  'docker compose -f other.yaml up',
]) ok(!parseCommandLine(line).ok, `still refused: ${line}`);
// 用途を絞って通すようになったもの（以前は別のターミナルで行うものとして説明だけしていた）
for (const line of [
  'openssl version',
  'openssl genpkey -algorithm ed25519 -out ca.key.pem',
  'docker compose -f docker-compose-recovery.yaml up --abort-on-container-exit',
  'irome upgrade shoestring',
]) ok(parseCommandLine(line).ok, `narrowly allowed: ${line}`);
ok(parseCommandLine('shoestring wizard').ok === false && parseCommandLine('shoestring wizard', { wizard: true }).ok, 'shoestring wizard: only when wizard is turned on');

// --- 概要（番号なし）
for (const lang of ['ja', 'en'] as const) for (const k of ['node_ss_overview_title', 'node_ss_overview_body']) ok(typeof messages[lang].service[k] === 'string' && messages[lang].service[k] !== '', `${lang} text: ${k}`);

// --- 手順
const ids = new Set<string>();
for (const step of SHOESTRING_STEPS) {
  ok(!ids.has(step.id), `unique step id: ${step.id}`);
  ids.add(step.id);
  for (const lang of ['ja', 'en'] as const) {
    for (const k of [`node_ss_${step.id}_title`, `node_ss_${step.id}_body`]) ok(typeof messages[lang].service[k] === 'string' && messages[lang].service[k] !== '', `${lang} text: ${k}`);
  }
  for (const line of step.lines ?? []) {
    ok(parseCommandLine(line, { wizard: true }).ok, `step ${step.id}: template passes the allow-list`, line);
    // wizard 以外は、wizard を有効にしなくても通ること
    ok(isWizardArgv(line.split(' ')) || parseCommandLine(line).ok, `step ${step.id}: template passes without turning the wizard on`, line);
    const preset = COMMAND_PRESETS.find((p) => p.line === line);
    ok(preset !== undefined, `step ${step.id}: template is also in COMMAND_PRESETS`, line);
    if (preset) for (const lang of ['ja', 'en'] as const) ok(typeof messages[lang].service[preset.noteKey.replace('service.', '')] === 'string', `${lang} note: ${preset.noteKey}`);
  }
  (step.terminalOnly ?? []).forEach((line, j) => {
    ok(!parseCommandLine(line).ok, `step ${step.id}: terminal-only line is not runnable here`, line);
    for (const lang of ['ja', 'en'] as const) ok(typeof messages[lang].service[`node_ss_${step.id}_t${j}`] === 'string', `${lang} text: node_ss_${step.id}_t${j}`);
  });
  if (step.fileTemplate) {
    // 設定ファイルの欄に入れて保存できる名前か（作業フォルダの中の .ini）
    const r = validateWorkspaceFile(`symbol-node/${step.fileTemplate.name}`);
    ok(r.ok, `file template path is editable: ${step.fileTemplate.name}`, r);
    ok(step.fileTemplate.content.endsWith('\n') && step.fileTemplate.content.includes('[node.localnode]'), 'overrides template has the [node.localnode] section');
  }
}

// --- 公式の手順の順番
const order = SHOESTRING_STEPS.map((s) => s.id);
for (const [a, b] of [['init', 'config'], ['config', 'overrides'], ['overrides', 'identity'], ['identity', 'setup'], ['setup', 'harvest'], ['harvest', 'start'], ['start', 'verify'], ['verify', 'recovery'], ['recovery', 'upgrade'], ['upgrade', 'maintain']] as const) {
  ok(order.indexOf(a) >= 0 && order.indexOf(a) < order.indexOf(b), `order: ${a} before ${b}`);
}
// ノードのアップデート（公式ドキュメントの順）: Shoestring を上げる → 止める → shoestring upgrade → 起動し直す → 確認
ok(SHOESTRING_STEPS.find((s) => s.id === 'upgrade')?.lines?.join(' | ') === 'python3 -m pip install --upgrade symbol-shoestring | python3 -m pip show symbol-shoestring | docker compose down | python3 -m shoestring upgrade --config config.ini --directory . --overrides overrides.ini | docker compose up -d | docker compose ps -a | irome upgrade shoestring', 'upgrade step follows the official order (pip, show, down, upgrade, up, ps)');
ok(SHOESTRING_STEPS.filter((s) => s.optional).map((s) => s.id).join() === 'harvest,voting', 'optional steps: harvest, voting');

// --- 公式の例のとおりのひな形
ok(OVERRIDES_TEMPLATE.includes('host = my-symbol-node.com') && OVERRIDES_TEMPLATE.includes('friendlyName = My Symbol Node'), 'overrides template matches the official example');

// --- 作業フォルダ（symbol-node）が、そのまま使える
{ const r = validateSubdir('symbol-node'); ok(r.ok && r.value === 'symbol-node', 'symbol-node is a valid working folder', r); }

// --- 公式のとおりの引数の順（init --package … config.ini）と、setup の引数
{
  const init = parseCommandLine('shoestring init --package mainnet config.ini');
  ok(init.ok && init.argv.join(' ') === 'shoestring init --package mainnet config.ini', 'init: official argument order');
  const setup = parseCommandLine(SHOESTRING_STEPS.find((s) => s.id === 'setup')!.lines![0]);
  ok(setup.ok && setup.argv.includes('--ca-key-path') && setup.argv.includes('--overrides') && setup.argv.includes('mainnet'), 'setup: official arguments (mainnet)');
}

console.log(`${checks} checks, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
