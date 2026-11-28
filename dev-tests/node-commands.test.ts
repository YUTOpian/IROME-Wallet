// ノード構築コンソール: 許可するコマンドの判定（ネットワークにも実行にも触れない）。
// 実行: npx tsx dev-tests/node-commands.test.ts
import { COMMAND_PRESETS, isLoopbackAgentUrl, isWizardArgv, parseCommandLine, tokenize, validateSubdir, validateWorkspaceFile } from '../src/lib/node/nodeCommands';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const allowed = (line: string) => parseCommandLine(line).ok;
const reason = (line: string) => { const r = parseCommandLine(line); return r.ok ? '' : r.reason; };

// --- トークナイザ
{
  const t = tokenize(`symbol-bootstrap config -p "my net" -c 'a b'`);
  ok(t.ok && JSON.stringify(t.argv) === JSON.stringify(['symbol-bootstrap', 'config', '-p', 'my net', '-c', 'a b']), 'quotes keep spaces', t);
  ok(tokenize('a  b\tc').ok && (tokenize('a  b\tc') as { argv: string[] }).argv.length === 3, 'whitespace collapses');
  ok(tokenize("echo ''").ok && (tokenize("echo ''") as { argv: string[] }).argv.length === 2, 'empty quoted arg is kept');
  ok(!tokenize('').ok && tokenize('').ok === false, 'empty rejected');
  for (const ch of ['|', ';', '&', '>', '<', '$', '`', '(', ')', '\\']) ok(!tokenize(`docker ps ${ch} x`).ok, `shell char ${ch} rejected`);
  ok(tokenize(`docker logs "a;b"`).ok, 'shell char inside quotes is literal');
  ok(!tokenize('docker ps\nrm -rf /').ok, 'newline rejected');
  ok(!tokenize('docker ps\0').ok, 'NUL rejected');
  ok(!tokenize('symbol-bootstrap config "x').ok, 'unclosed quote rejected');
  ok(!tokenize('a '.repeat(41)).ok, 'too many args rejected');
  ok(!tokenize('a'.repeat(2001)).ok, 'too long rejected');
}

// --- 許可するもの
for (const line of [
  'symbol-bootstrap config -p mainnet -a dual -c custom.yml --noPassword',
  'symbol-bootstrap start -p testnet -a dual -d --healthCheck',
  'symbol-bootstrap healthCheck', 'symbol-bootstrap stop', 'symbol-bootstrap --version', 'symbol-bootstrap --help',
  'symbol-bootstrap start -p mainnet -a dual -d --upgrade',
  'symbol-bootstrap encrypt --source custom-preset.yml --destination custom-preset.enc.yml', 'symbol-bootstrap decrypt --source custom-preset.enc.yml --destination custom-preset.yml',
  'shoestring init config.ini --package sai', 'shoestring setup --config config.ini --ca-key-path ca.key.pem',
  'shoestring health --config config.ini', 'shoestring upgrade --config config.ini', 'shoestring --help', 'shoestring -h',
  'symbol-node-watcher start', 'symbol-node-watcher start /path/to/config.json', 'symbol-node-watcher stop',
  'docker --version', 'docker version', 'docker info', 'docker ps', 'docker ps -a', 'docker logs --tail 100 -f symbol-node_rest-gateway_1',
  'docker stats --no-stream', 'docker compose ps',
  'docker start symbol-node_broker_1', 'docker stop -t 30 a b', 'docker restart --time 10 rest-gateway', 'docker rm old_container', 'docker pull symbolplatform/symbol-server:gcc-1.0.3.8',
  'docker compose up -d', 'docker compose up -d --remove-orphans --force-recreate broker', 'docker compose down', 'docker compose down --remove-orphans -t 20',
  'docker compose start', 'docker compose stop -t 60', 'docker compose restart broker', 'docker compose pull -q', 'docker compose logs --tail 50 broker', 'docker compose version',
  'node --version', 'node -v', 'irome install bootstrap', 'irome install shoestring', 'irome install nodewatch',
  'irome uninstall bootstrap', 'irome uninstall shoestring', 'irome uninstall nodewatch',
]) ok(allowed(line), `allowed: ${line}`, reason(line));

// --- 通さないもの
const denied: Array<[string, string]> = [
  ['rm -rf /', 'tool_not_allowed'],
  ['sudo docker ps', 'tool_not_allowed'],
  ['bash -c ls', 'tool_not_allowed'],
  ['npm install -g evil', 'tool_not_allowed'],
  ['pip install evil', 'tool_not_allowed'],
  ['python3 -c 1', 'tool_not_allowed'],
  ['docker run --rm -v /:/host alpine sh', 'docker_subcommand'],
  ['docker exec -it x sh', 'docker_subcommand'],
  ['docker rm -f x', 'docker_flag'],
  ['docker rm -v x', 'docker_flag'],
  ['docker rm', 'docker_target_required'],
  ['docker stop', 'docker_target_required'],
  ['docker restart $x', 'shell_char'],
  ['docker restart ../x', 'docker_argument'],
  ['docker start --privileged x', 'docker_flag'],
  ['docker stop -t abc x', 'docker_flag_value'],
  ['docker pull', 'docker_target_required'],
  ['docker pull evil@sha256:abc', 'docker_argument'],
  ['docker pull -a x', 'docker_flag'],
  ['docker run alpine', 'docker_subcommand'],
  ['docker cp a b', 'docker_subcommand'],
  ['docker build .', 'docker_subcommand'],
  ['docker compose up -f /tmp/evil.yml', 'docker_flag'],
  ['docker compose -f /tmp/evil.yml up', 'docker_compose_file'],
  ['docker compose --project-directory / up', 'docker_compose_subcommand'],
  ['docker compose up --build', 'docker_flag'],
  ['docker compose down -v', 'docker_flag'],
  ['docker compose down --rmi all', 'docker_flag'],
  ['docker compose run x sh', 'docker_compose_subcommand'],
  ['docker compose config', 'docker_compose_subcommand'],
  ['docker compose exec x sh', 'docker_compose_subcommand'],
  ['docker compose', 'docker_compose_subcommand'],
  ['docker ps --format {{.ID}}', 'docker_flag'],
  ['docker ps -v', 'docker_flag'],
  ['docker logs --tail', 'docker_flag_value'],
  ['docker logs --tail abc/def x', 'docker_flag_value'],
  ['docker ps extra', 'docker_argument'],
  ['docker logs ../x', 'docker_argument'],
  ['docker logs -x', 'docker_flag'],
  ['node -e 1', 'node_only_version'],
  ['node --version x', 'node_only_version'],
  ['node', 'node_only_version'],
  ['symbol-bootstrap', 'missing_subcommand'],
  ['symbol-bootstrap --version x', 'subcommand_not_allowed'],
  ['shoestring wizard', 'wizard_disabled'],
  ['shoestring import-harvesters --show-private', 'secret_confirm_required'],
  ['shoestring import-harvesters --show-private=1', 'secret_confirm_required'],
  ['symbol-bootstrap config --show-private', 'secret_confirm_required'],
  ['symbol-node-watcher restart', 'subcommand_not_allowed'],
  ['symbol-node-watcher start a b', 'too_many_args'],
  ['irome install', 'irome_usage'],
  ['irome install evil', 'irome_usage'],
  ['irome uninstall', 'irome_usage'],
  ['irome uninstall evil', 'irome_usage'],
  ['irome uninstall bootstrap extra', 'irome_usage'],
  ['irome remove bootstrap', 'irome_usage'],
  ['irome install bootstrap extra', 'irome_usage'],
  ['symbol-bootstrap config && rm -rf /', 'shell_char'],
  ['symbol-bootstrap config $(id)', 'shell_char'],
  ['symbol-bootstrap config `id`', 'shell_char'],
];
for (const [line, why] of denied) ok(reason(line) === why, `denied(${why}): ${line}`, reason(line));
ok(!allowed('x'.repeat(10)), 'unknown tool rejected');
ok(!parseCommandLine(`docker logs ${'a'.repeat(501)}`).ok, 'very long arg rejected');

// --- 作業フォルダ
{
  const good = (s: string) => { const r = validateSubdir(s); return r.ok ? r.value : null; };
  ok(good('') === '', 'empty subdir = workspace root');
  ok(good('.') === '', 'dot = root');
  ok(good('target') === 'target', 'simple');
  ok(good('./nodes/mainnet/') === 'nodes/mainnet', 'normalized');
  ok(good('nodes\\mainnet') === 'nodes/mainnet', 'backslash normalized');
  for (const s of ['..', '../x', 'a/../b', '/etc', 'C:/x', 'C:\\x', 'a//b', 'a/./b', 'a\u0000b', 'x'.repeat(201)]) ok(good(s) === null, `subdir rejected: ${JSON.stringify(s)}`);
}

// --- エージェントの URL
for (const u of ['http://127.0.0.1:7391', 'http://localhost:7391', 'http://[::1]:7391']) ok(isLoopbackAgentUrl(u), `loopback ok: ${u}`);
for (const u of ['https://127.0.0.1:7391', 'http://192.168.1.5:7391', 'http://example.com', 'http://127.0.0.1.evil.com', 'http://localhost.evil.com', 'file:///x', 'garbage', '']) ok(!isLoopbackAgentUrl(u), `loopback rejected: ${u}`);

// --- ひな型は、すべて自分の判定を通る
// wizard のひな型は、画面で wizard を有効にしたときだけ通る（それ以外のひな型は、無効のままで通ること）
// 秘密鍵が出るひな型は、確認（secret: true）を通したときだけ通る（確認なしでは断られる）
for (const p of COMMAND_PRESETS) {
  if (p.secret) ok(parseCommandLine(p.line, { secret: true }).ok && reason(p.line) === 'secret_confirm_required', `secret preset: passes only with the confirmation: ${p.line}`, reason(p.line));
  else ok(isWizardArgv(p.line.split(' ')) ? parseCommandLine(p.line, { wizard: true }).ok && !allowed(p.line) : allowed(p.line), `preset passes: ${p.line}`, reason(p.line));
}

// --- 設定ファイル
{
  const f = (p: string) => { const r = validateWorkspaceFile(p); return r.ok ? r.value : r.reason; };
  for (const p of ['docker-compose.yml', 'target/docker/docker-compose.yml', 'compose.yaml', 'docker-compose.override.yml', 'a/compose.prod.yml']) ok(f(p) === 'compose_file_protected', `compose file not editable: ${p}`, f(p));
  ok(f('custom-preset.yml') === 'custom-preset.yml', 'preset still editable');
  ok(f('config.ini') === 'config.ini' && f('a/b/c.yml') === 'a/b/c.yml' && f('./x.JSON') === 'x.JSON', 'workspace file ok');
  for (const p of ['', '.', '..', '../a.ini', '/a.ini', 'tools/a.ini', 'a/node_modules/b.json', '.git/config.ini', 'a/.git/x.ini']) ok(f(p) === 'path_invalid', `workspace file path_invalid: ${p}`, f(p));
  for (const p of ['ca.key.pem', 'x.sh', 'x', 'x.ini.bak', '.env.ini', 'a/.x.yml', 'node.key']) ok(f(p) === 'ext_not_allowed', `workspace file ext_not_allowed: ${p}`, f(p));
}

// --- wizard（対話式）: 画面で有効にしたときだけ通す
{
  ok(reason('symbol-bootstrap wizard') === 'wizard_disabled', 'wizard: refused by default', reason('symbol-bootstrap wizard'));
  ok(!parseCommandLine('symbol-bootstrap wizard', { wizard: false }).ok, 'wizard: refused when explicitly off');
  ok(parseCommandLine('symbol-bootstrap wizard', { wizard: true }).ok, 'wizard: allowed when turned on');
  ok(parseCommandLine('symbol-bootstrap wizard --help', {}).ok === false, 'wizard --help: refused when off too');
  ok(parseCommandLine('symbol-bootstrap config -p testnet --noPassword', { wizard: false }).ok, 'wizard off: other subcommands are unaffected');
  ok(parseCommandLine('shoestring wizard', { wizard: true }).ok, 'wizard on: shoestring wizard is allowed');
  ok(parseCommandLine('shoestring wizard --x', { wizard: true }).ok === false, 'wizard on: shoestring wizard takes no arguments');
  ok(parseCommandLine('symbol-bootstrap wizard --show-private', { wizard: true }).ok === false, 'wizard on: --show-private still needs the secret confirmation');
  ok(isWizardArgv(['symbol-bootstrap', 'wizard']) && !isWizardArgv(['symbol-bootstrap', 'config']) && isWizardArgv(['shoestring', 'wizard']) && !isWizardArgv(['shoestring', 'health']), 'isWizardArgv');
}

console.log(`${checks} checks, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
