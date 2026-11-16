// 用途を絞って通すようになったコマンド（openssl・復旧用の docker compose -f・irome upgrade shoestring / bootstrap / nodewatch・shoestring wizard）の、許可と拒否、
// そしてエージェントが組む手順（上書きしない・権限 600・tools/venv が無いときは何もしない）を確かめる。
// 実行: npx tsx dev-tests/node-narrow-allow.test.ts
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENSSL_KEY_FILE, isSecretArgv, isWizardArgv, parseCommandLine, resolveCd } from '../src/lib/node/nodeCommands';
import { BOOTSTRAP_REPO, defaultResolve, genpkeySteps, upgradeSteps } from '../src/server/node-agent/agent';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const reason = (line: string, w = false) => { const r = parseCommandLine(line, { wizard: w }); return r.ok ? 'OK' : r.reason; };

// --- openssl: 2 つの形だけ
ok(reason('openssl version') === 'OK', 'openssl version');
ok(reason('openssl genpkey -algorithm ed25519 -out ca.key.pem') === 'OK', 'genpkey ed25519 -> ca.key.pem');
ok(reason('openssl genpkey -algorithm ed25519 -out node-2.key.pem') === 'OK', 'genpkey: another .pem name');
for (const line of [
  'openssl genpkey -algorithm ed25519 -out ../ca.key.pem', 'openssl genpkey -algorithm ed25519 -out /tmp/ca.key.pem', 'openssl genpkey -algorithm ed25519 -out sub/ca.key.pem',
  'openssl genpkey -algorithm ed25519 -out ca.key', 'openssl genpkey -algorithm ed25519 -out -ca.pem', 'openssl genpkey -algorithm ed25519 -out .pem',
  'openssl genpkey -algorithm rsa -out ca.key.pem', 'openssl genpkey -algorithm ed25519 -out ca.key.pem -pass pass:x', 'openssl genpkey -algorithm ed25519',
  'openssl genpkey -out ca.key.pem -algorithm ed25519', 'openssl x509 -in a.pem -text', 'openssl s_client -connect a:1', 'openssl enc -d -in a', 'openssl', 'openssl version -a',
  'openssl rand -out a.pem 8', 'openssl req -x509 -out a.pem',
]) ok(reason(line) === 'openssl_usage' || reason(line) !== 'OK', `openssl refused: ${line}`, reason(line));
for (const line of ['openssl genpkey -algorithm ed25519 -out ../ca.key.pem', 'openssl x509 -in a.pem -text', 'openssl rand -out a.pem 8']) ok(reason(line) === 'openssl_usage', `openssl_usage: ${line}`);
ok(OPENSSL_KEY_FILE.test('a.pem') && OPENSSL_KEY_FILE.test('ca.key.pem'), 'key file regex: plain .pem names');
ok(!OPENSSL_KEY_FILE.test('a/b.pem') && !OPENSSL_KEY_FILE.test('-a.pem') && !OPENSSL_KEY_FILE.test('a.pem\n'), 'key file regex: no slash / leading dash / newline');

// --- docker compose -f: 復旧用の 1 つだけ
ok(reason('docker compose -f docker-compose-recovery.yaml up --abort-on-container-exit') === 'OK', 'recovery compose');
ok(reason('docker compose --file docker-compose-recovery.yaml up --abort-on-container-exit') === 'OK', 'recovery compose (--file)');
ok(reason('docker compose -f docker-compose-recovery.yaml up') === 'OK', 'recovery compose without flags');
for (const [line, why] of [
  ['docker compose -f docker-compose.yaml up', 'docker_compose_file'], ['docker compose -f /tmp/evil.yml up', 'docker_compose_file'], ['docker compose -f ../docker-compose-recovery.yaml up', 'docker_compose_file'],
  ['docker compose -f ./docker-compose-recovery.yaml up', 'docker_compose_file'], ['docker compose -f docker-compose-recovery.yaml down', 'docker_compose_file'], ['docker compose -f docker-compose-recovery.yaml logs', 'docker_compose_file'],
  ['docker compose -f docker-compose-recovery.yaml', 'docker_compose_file'], ['docker compose -f', 'docker_compose_file'], ['docker compose -f docker-compose-recovery.yaml up -v', 'docker_flag'],
  ['docker compose -f docker-compose-recovery.yaml up --build', 'docker_flag'], ['docker compose up -f docker-compose-recovery.yaml', 'docker_flag'], ['docker compose --project-directory / up', 'docker_compose_subcommand'],
  ['docker compose -f docker-compose-recovery.yaml -f evil.yml up', 'docker_compose_file'], ['docker compose -f=docker-compose-recovery.yaml up', 'docker_compose_subcommand'],
] as const) ok(reason(line) === why, `compose refused: ${line}`, reason(line));
ok(reason('docker compose up -d --abort-on-container-exit') === 'OK', '--abort-on-container-exit is accepted on up');

// --- irome upgrade: shoestring と bootstrap だけ
ok(reason('irome upgrade shoestring') === 'OK', 'irome upgrade shoestring');
ok(reason('irome upgrade bootstrap') === 'OK', 'irome upgrade bootstrap');
for (const l of ['irome upgrade bootstrap extra', 'irome upgrade bootstrap@1.1.13', 'irome upgrade bootstrap --latest', 'irome upgrade symbol-bootstrap', 'irome upgrade bootstrap https://example.com/x.git']) ok(reason(l) === 'irome_usage', `refused: ${l}`, reason(l));
ok(reason('irome upgrade nodewatch') === 'OK', 'irome upgrade nodewatch');
for (const t of ['node', 'python']) ok(reason(`irome upgrade ${t}`) === 'irome_usage', `irome upgrade ${t} refused`);
ok(reason('irome upgrade') === 'irome_usage' && reason('irome upgrade shoestring extra') === 'irome_usage' && reason('irome install shoestring') === 'OK' && reason('irome uninstall node') === 'OK', 'irome other forms unchanged');

// --- shoestring wizard
ok(reason('shoestring wizard') === 'wizard_disabled', 'shoestring wizard off by default');
ok(reason('shoestring wizard', true) === 'OK' && reason('shoestring wizard --x', true) === 'too_many_args', 'shoestring wizard on: no extra args');
ok(isWizardArgv(['shoestring', 'wizard']), 'isWizardArgv(shoestring wizard)');
ok(reason('shoestring health') === 'OK' && reason('shoestring init --package sai config.ini') === 'OK', 'other shoestring subcommands unaffected');
ok(reason('python3 -m shoestring.wizard') === 'tool_not_allowed' && reason('python3 -m pip install requests') === 'pip_usage', 'other python / pip still refused');
ok(reason('shoestring pemview --input ca.key.pem --show-private') === 'secret_confirm_required', '--show-private needs the secret confirmation');

// --- 秘密鍵が出る形: 確認（secret: true）を通したときだけ通る
{
  const sec = (line: string) => { const r = parseCommandLine(line, { secret: true }); return r.ok ? 'OK' : r.reason; };
  for (const line of ['openssl pkey -in ca.key.pem -text', 'openssl pkey -in ca.key.pem -text -noout', 'openssl pkey -in node-2.key.pem -text']) {
    ok(reason(line) === 'secret_confirm_required' && sec(line) === 'OK', `pkey: needs the confirmation: ${line}`, [reason(line), sec(line)]);
  }
  for (const line of ['shoestring pemview --input ca.key.pem --show-private', 'shoestring pemview --input ca.key.pem --show-private=1', 'python3 -m shoestring pemview --input ca.key.pem --network mainnet --show-private', 'symbol-bootstrap config --show-private']) {
    ok(reason(line) === 'secret_confirm_required' && sec(line) === 'OK', `--show-private: needs the confirmation: ${line}`, [reason(line), sec(line)]);
  }
  // 形が許されないものは、確認があっても通らない。確認を求める前に、形の理由で断る
  for (const line of ['openssl pkey -in ../ca.key.pem -text', 'openssl pkey -in /etc/ca.pem -text', 'openssl pkey -in sub/ca.pem -text', 'openssl pkey -in ca.key -text', 'openssl pkey -in -ca.pem -text', 'openssl pkey -in ca.key.pem',
    'openssl pkey -text -in ca.key.pem', 'openssl pkey -in ca.key.pem -text -noout -out x.pem', 'openssl pkey -in ca.key.pem -text -passin pass:x', 'openssl pkey -in ca.key.pem -pubout', 'openssl pkey -in ca.key.pem -text -out leak.pem', 'openssl pkey', 'openssl pkey -in ca.key.pem -text extra', 'openssl pkeyutl -in ca.pem -text', 'openssl rsa -in ca.key.pem -text']) {
    ok(reason(line) === 'openssl_usage' && sec(line) === 'openssl_usage', `pkey: bad form refused (with or without the confirmation): ${line}`, [reason(line), sec(line)]);
  }
  ok(isSecretArgv(['openssl', 'pkey', '-in', 'a.pem', '-text']) && isSecretArgv(['shoestring', 'pemview', '--show-private']) && isSecretArgv(['x', '--show-private=1']), 'isSecretArgv: true for the key-printing forms');
  ok(!isSecretArgv(['openssl', 'version']) && !isSecretArgv(['openssl', 'genpkey', '-algorithm', 'ed25519', '-out', 'ca.key.pem']) && !isSecretArgv(['shoestring', 'pemview', '--input', 'ca.key.pem']) && !isSecretArgv(['docker', 'ps']), 'isSecretArgv: false for the others');
  ok(sec('docker ps --show-private') === 'docker_flag' && sec('node --show-private') === 'node_only_version', '--show-private with the confirmation does not widen other tools');
}

// --- mkdir / cd
{
  ok(reason('mkdir symbol-node') === 'OK' && reason('mkdir -p a/b/c') === 'OK' && reason('mkdir ./sub/') === 'OK', 'mkdir: allowed forms');
  const mk = parseCommandLine('mkdir ./sub/');
  ok(mk.ok && mk.argv.join(' ') === 'mkdir sub', 'mkdir: the name is normalised', mk);
  for (const line of ['mkdir', 'mkdir -p', 'mkdir ..', 'mkdir ../x', 'mkdir a/../../x', 'mkdir /tmp/x', 'mkdir C:x', 'mkdir C:/x', 'mkdir a b', 'mkdir -m 777 a', 'mkdir -v a', 'mkdir .', 'mkdir CON', 'mkdir a:b', 'mkdir PROGRA~1', 'mkdir a/']) {
    // 末尾の `/` だけは、本物の mkdir と同じに許す
    if (line === 'mkdir a/') { ok(reason(line) === 'OK', `mkdir: trailing slash is fine`); continue; }
    ok(reason(line) === 'mkdir_usage', `mkdir refused: ${line}`, reason(line));
  }
  ok(reason('cd') === 'OK' && reason('cd ..') === 'OK' && reason('cd symbol-node') === 'OK' && reason('cd ~') === 'OK' && reason('cd a/b/..') === 'OK', 'cd: allowed forms');
  for (const line of ['cd /', 'cd /etc', 'cd C:x', 'cd a b', 'cd ../../../../../../../../..', 'cd ~root', 'cd -']) ok(reason(line) === 'cd_usage' || reason(line) === 'OK' && line === 'cd -', `cd refused or harmless: ${line}`, reason(line));
  // resolveCd: 今の作業フォルダからの行き先
  const rc = (cur: string, a?: string) => { const r = resolveCd(cur, a); return r.ok ? r.value : `NG:${r.reason}`; };
  ok(rc('', undefined) === '' && rc('a/b', undefined) === '' && rc('a/b', '~') === '' , 'cd: no argument / ~ goes to the workspace root');
  ok(rc('', 'symbol-node') === 'symbol-node' && rc('a', 'b') === 'a/b' && rc('a', 'b/c') === 'a/b/c' && rc('a', './b') === 'a/b', 'cd: into a folder');
  ok(rc('a/b', '..') === 'a' && rc('a', '..') === '' && rc('a/b', '../c') === 'a/c' && rc('a/b', '../..') === '' && rc('a', 'b/../c') === 'a/c', 'cd: up and sideways');
  for (const [cur, a] of [['', '..'], ['a', '../..'], ['', '../x'], ['a', '/etc'], ['a', 'C:x'], ['a', '~x'], ['', 'a/../..'], ['', 'con'], ['', 'a:b'], ['', 'x'.repeat(201)]] as const) ok(rc(cur, a).startsWith('NG:'), `cd refused: ${JSON.stringify([cur, a])}`, rc(cur, a));
  ok(rc('a', '..\\b') === 'b' || rc('a', '..\\b').startsWith('NG:'), 'cd: backslashes are treated as separators or refused');
  ok(rc('', 'a\\b') === 'a/b', 'cd: backslash separators are normalised');
}

// --- 解決（エージェント）
const ws = mkdtempSync(join(tmpdir(), 'irome-narrow-'));
try {
  const r1 = defaultResolve('openssl', ['openssl', 'version'], ws);
  ok(r1?.cmd === 'openssl' && r1.args.join(' ') === 'version', 'resolve openssl');
  const w1 = defaultResolve('shoestring', ['shoestring', 'wizard'], ws, 'linux');
  ok(w1?.cmd === 'python3' && w1.args.join(' ') === '-m shoestring.wizard', 'resolve shoestring wizard (no venv): python3 -m shoestring.wizard', w1);
  mkdirSync(join(ws, 'tools', 'venv', 'bin'), { recursive: true });
  writeFileSync(join(ws, 'tools', 'venv', 'bin', 'python'), '');
  const w2 = defaultResolve('shoestring', ['shoestring', 'wizard'], ws, 'linux');
  ok(w2?.cmd === join(ws, 'tools', 'venv', 'bin', 'python') && w2.args.join(' ') === '-m shoestring.wizard', 'resolve shoestring wizard (venv)', w2);
  const h = defaultResolve('shoestring', ['shoestring', 'health', '--config', 'config.ini'], ws, 'linux');
  ok(h?.args.join(' ') === '-m shoestring health --config config.ini', 'resolve other shoestring subcommands unchanged', h);

  // --- `python3 -m shoestring …` は `shoestring …` として通る。ほかの `python3 -m …` は通さないまま
  {
    const a = parseCommandLine('python3 -m shoestring --help');
    ok(a.ok && a.tool === 'shoestring' && a.argv.join(' ') === 'shoestring --help', 'python3 -m shoestring --help -> shoestring --help', a);
    const b = parseCommandLine('python3 -m shoestring upgrade --config config.ini --directory . --overrides overrides.ini');
    ok(b.ok && b.tool === 'shoestring' && b.argv[1] === 'upgrade', 'python3 -m shoestring upgrade …', b);
    const c = parseCommandLine('python -m shoestring health --config config.ini --directory .');
    ok(c.ok && c.argv[0] === 'shoestring', 'python -m shoestring health …', c);
    ok(parseCommandLine('python3 -m shoestring init --help').ok, 'python3 -m shoestring <command> --help');
    for (const l of ['python3 -m shoestring.wizard', 'python3 -m venv x', 'python3', 'python3 -m', 'python3 -c print(1)', 'python3 shoestring --help', 'python3 -m shoestring']) ok(!parseCommandLine(l).ok, `python3 still refused: ${l}`);
    // 公式ドキュメントの pip の 3 つの形は、そのまま通る（argv も、そのまま）。ほかのパッケージ・オプションは通さない
    for (const l of ['python3 -m pip install symbol-shoestring', 'python3 -m pip install --upgrade symbol-shoestring', 'python3 -m pip show symbol-shoestring', 'python -m pip install symbol-shoestring']) {
      const r = parseCommandLine(l);
      ok(r.ok && r.tool === 'pip' && r.argv.join(' ') === l, `pip allowed as written: ${l}`, r);
    }
    for (const l of ['python3 -m pip install requests', 'python3 -m pip install symbol-shoestring requests', 'python3 -m pip install symbol-shoestring==0.2.5', 'python3 -m pip install -r requirements.txt', 'python3 -m pip install --upgrade pip', 'python3 -m pip uninstall symbol-shoestring', 'python3 -m pip show requests', 'python3 -m pip install --user symbol-shoestring', 'python3 -m pip install --upgrade symbol-shoestring --index-url http://x', 'python3 -m pip', 'python3 -m pip install', 'python3 -m pip download symbol-shoestring']) ok(reason(l) === 'pip_usage', `pip refused: ${l}`, reason(l));
    // docker compose logs --tail=50（公式ドキュメントの書き方）
    ok(parseCommandLine('docker compose logs --tail=50').ok && parseCommandLine('docker compose logs -f').ok && parseCommandLine('docker compose ps').ok, 'docs: logs --tail=50 / logs -f / ps');
    ok(!parseCommandLine('docker compose logs --tail=abc/def').ok && !parseCommandLine('docker compose logs --follow=1').ok && !parseCommandLine('docker compose logs --since').ok, 'docker --flag=value: only valid value flags');
    ok(parseCommandLine('python3 -m shoestring pemview --input ca.key.pem --network mainnet --show-private').ok === false, 'python3 -m shoestring: --show-private needs the secret confirmation');
    ok(parseCommandLine('python3 -m shoestring wizard').ok === false && parseCommandLine('python3 -m shoestring wizard', { wizard: true }).ok, 'python3 -m shoestring wizard: only when wizard is turned on');
    ok(parseCommandLine('python3 -m shoestring wizard x', { wizard: true }).ok === false, 'python3 -m shoestring wizard: no arguments');
    ok(parseCommandLine('python3 -m shoestring bogus').ok === false, 'python3 -m shoestring: unknown subcommand refused');
  }

  // --- python3 -m pip …: tools/venv があればその Python の pip、なければ PC の python3 の pip
  {
    const pipArgv = ['python3', '-m', 'pip', 'install', '--upgrade', 'symbol-shoestring'];
    const noVenvPip = defaultResolve('pip', pipArgv, mkdtempSync(join(tmpdir(), 'irome-pip-')), 'linux');
    ok(noVenvPip?.cmd === 'python3' && noVenvPip.args.join(' ') === '-m pip install --upgrade symbol-shoestring', 'pip without venv: python3 -m pip …', noVenvPip);
    ok(defaultResolve('pip', pipArgv, mkdtempSync(join(tmpdir(), 'irome-pip-')), 'win32')?.cmd === 'python', 'pip on Windows without venv: python');
    const venvPy = join(ws, 'tools', 'venv', 'bin', 'python');
    const withVenvPip = defaultResolve('pip', ['python3', '-m', 'pip', 'show', 'symbol-shoestring'], ws, 'linux');
    ok(withVenvPip?.cmd === venvPy && withVenvPip.args.join(' ') === '-m pip show symbol-shoestring', 'pip with venv: the venv python', withVenvPip);
  }

  // --- upgradeSteps
  const up = upgradeSteps('shoestring', ws);
  ok(up.length === 2 && up[0].args.join(' ') === '-m pip install --upgrade symbol-shoestring' && up[1].args.join(' ') === '-m pip show symbol-shoestring', 'upgrade: pip install --upgrade symbol-shoestring (latest, no pin) + show', up.map((s) => s.args));
  const ws2 = mkdtempSync(join(tmpdir(), 'irome-narrow2-'));
  const noVenv = upgradeSteps('shoestring', ws2);
  let msg = ''; const code = await Promise.resolve(noVenv[0].run?.((t) => { msg += t; }, { stopped: () => false }));
  ok(noVenv.length === 1 && code === 1 && msg.includes('irome install shoestring'), 'upgrade without tools/venv: stops and points to install', msg);
  rmSync(ws2, { recursive: true, force: true });
  const other = upgradeSteps('node', ws);
  ok(other.length === 1 && other[0].run !== undefined, 'upgrade of anything else: refused step');

  // --- upgradeSteps('bootstrap'): 公式の手順（git clone → npm install → build → pack → install）を、tools/ の中だけで
  const bsWs = mkdtempSync(join(tmpdir(), 'irome-bs-'));
  const bsTools = join(bsWs, 'tools');
  const bsSrc = join(bsTools, '.upgrade', 'symbol-bootstrap');
  const bsKeep = join(bsTools, 'packages', 'symbol-bootstrap.tgz');
  const noBs = upgradeSteps('bootstrap', bsWs, { platform: 'linux' });
  let bs_m3 = ''; const bs_c3 = await Promise.resolve(noBs[0].run?.((t) => { bs_m3 += t; }, { stopped: () => false }));
  ok(bs_c3 === 1 && bs_m3.includes('irome install bootstrap') && !existsSync(bsSrc), 'bootstrap upgrade without tools/ install: stops and points to install', bs_m3);
  mkdirSync(join(bsTools, 'node_modules', 'symbol-bootstrap'), { recursive: true });
  writeFileSync(join(bsTools, 'node_modules', 'symbol-bootstrap', 'package.json'), JSON.stringify({ name: 'symbol-bootstrap', version: '1.1.7' }));
  const bs = upgradeSteps('bootstrap', bsWs, { platform: 'linux' });
  ok(bs.length === 9, 'bootstrap upgrade: 9 steps', bs.map((x) => x.label));
  ok(BOOTSTRAP_REPO === 'https://github.com/symbol/symbol-bootstrap.git', 'bootstrap upgrade: official repo is fixed');
  ok(bs[1].cmd === 'git' && bs[1].args.join(' ') === `clone --depth 1 ${BOOTSTRAP_REPO} ${bsSrc}`, 'bootstrap upgrade: git clone of the official repo into tools/.upgrade', bs[1]);
  ok(bs[2].cmd === 'npm' && bs[2].args.join(' ') === 'install' && bs[2].cwd === bsSrc, 'bootstrap upgrade: npm install in the clone', bs[2]);
  ok(bs[3].args.join(' ') === 'run build' && bs[3].cwd === bsSrc, 'bootstrap upgrade: npm run build in the clone', bs[3]);
  ok(bs[4].args.join(' ') === 'pack --ignore-scripts' && bs[4].cwd === bsSrc, 'bootstrap upgrade: npm pack --ignore-scripts', bs[4]);
  ok(bs[6].cmd === 'npm' && bs[6].args.join(' ') === `install --prefix ${bsTools} ${bsKeep}` && bs[6].cwd === bsWs, 'bootstrap upgrade: npm install --prefix tools <tgz> (no -g)', bs[6]);
  ok(bs.every((x) => !x.args.includes('-g') && !x.args.includes('--global') && x.cmd !== 'sudo'), 'bootstrap upgrade: no -g, no sudo');
  ok(bs.every((x) => x.cmd === '' || ['git', 'npm'].includes(x.cmd) || x.cmd === join(bsTools, 'node_modules', '.bin', 'symbol-bootstrap')), 'bootstrap upgrade: only git / npm / the installed symbol-bootstrap are run', bs.map((x) => x.cmd));
  // 準備の確認: 入っている版を出す。git が無ければ止まる（git がある環境では、そのまま通る）
  let bs_m4 = ''; const bs_c4 = await Promise.resolve(bs[0].run?.((t) => { bs_m4 += t; }, { stopped: () => false }));
  ok(bs_m4.includes('1.1.7') && (bs_c4 === 0 || (bs_c4 === 1 && bs_m4.includes('git が見つかりません'))), 'bootstrap upgrade: shows the current version; passes or stops for git', bs_m4);
  // .tgz を置く: 1 つだけのときに限る
  const tgzStep = bs[5];
  let bs_m5 = ''; const bs_noTgz = await Promise.resolve(tgzStep.run?.((t) => { bs_m5 += t; }, { stopped: () => false }));
  ok(bs_noTgz === 1 && !existsSync(bsKeep), 'bootstrap upgrade: no .tgz -> stops', bs_m5);
  mkdirSync(bsSrc, { recursive: true });
  writeFileSync(join(bsSrc, 'symbol-bootstrap-1.1.13.tgz'), 'TGZ-A'); writeFileSync(join(bsSrc, 'symbol-bootstrap-1.1.12.tgz'), 'TGZ-B');
  const bs_two = await Promise.resolve(tgzStep.run?.(() => {}, { stopped: () => false }));
  ok(bs_two === 1 && !existsSync(bsKeep), 'bootstrap upgrade: bs_two .tgz -> stops (never guesses)');
  rmSync(join(bsSrc, 'symbol-bootstrap-1.1.12.tgz'));
  let bs_m6 = ''; const bs_one = await Promise.resolve(tgzStep.run?.((t) => { bs_m6 += t; }, { stopped: () => false }));
  ok(bs_one === 0 && readFileSync(bsKeep, 'utf8') === 'TGZ-A' && !existsSync(join(bsSrc, 'symbol-bootstrap-1.1.13.tgz') ) && bs_m6.includes('1.1.13'), 'bootstrap upgrade: the bs_one .tgz is moved to tools/packages/symbol-bootstrap.tgz', bs_m6);
  // 後片付け: 作業用のフォルダだけを消す。tools/packages の .tgz は残す
  const cleanup = bs[8];
  const bs_cc = await Promise.resolve(cleanup.run?.(() => {}, { stopped: () => false }));
  ok(bs_cc === 0 && !existsSync(bsSrc) && existsSync(bsKeep), 'bootstrap upgrade: cleanup removes the work folder, keeps the .tgz');
  // シンボリックリンクは辿らない（tools/ の外のものを消さない）
  const outside = mkdtempSync(join(tmpdir(), 'irome-bs-out-'));
  writeFileSync(join(outside, 'KEEP'), 'x');
  rmSync(join(bsTools, '.upgrade'), { recursive: true, force: true }); mkdirSync(join(bsTools, '.upgrade'), { recursive: true });
  const { symlinkSync: mkLink } = await import('node:fs');
  mkLink(outside, bsSrc);
  let bs_m7 = ''; const bs_c7 = await Promise.resolve(cleanup.run?.((t) => { bs_m7 += t; }, { stopped: () => false }));
  ok(bs_c7 === 1 && existsSync(join(outside, 'KEEP')) && bs_m7.includes('シンボリックリンク'), 'bootstrap upgrade: a symlinked work folder is not followed or deleted', bs_m7);
  rmSync(outside, { recursive: true, force: true }); rmSync(bsWs, { recursive: true, force: true });

  // --- upgradeSteps('nodewatch'): npm の最新版を tools/ に入れ直すだけ
  const nwWs = mkdtempSync(join(tmpdir(), 'irome-nw-'));
  const nwTools = join(nwWs, 'tools');
  const noNw = upgradeSteps('nodewatch', nwWs, { platform: 'linux' });
  let nm1 = ''; const nc1 = await Promise.resolve(noNw[0].run?.((t) => { nm1 += t; }, { stopped: () => false }));
  ok(noNw.length === 3 && nc1 === 1 && nm1.includes('irome install nodewatch'), 'nodewatch upgrade without tools/ install: stops and points to install', nm1);
  mkdirSync(join(nwTools, 'node_modules', 'symbol-node-watcher'), { recursive: true });
  writeFileSync(join(nwTools, 'node_modules', 'symbol-node-watcher', 'package.json'), JSON.stringify({ name: 'symbol-node-watcher', version: '0.1.0' }));
  const nw = upgradeSteps('nodewatch', nwWs, { platform: 'linux' });
  let nm2 = ''; const nc2 = await Promise.resolve(nw[0].run?.((t) => { nm2 += t; }, { stopped: () => false }));
  ok(nc2 === 0 && nm2.includes('0.1.0'), 'nodewatch upgrade: shows the current version', nm2);
  ok(nw[1].cmd === 'npm' && nw[1].args.join(' ') === `install --prefix ${nwTools} symbol-node-watcher@latest` && nw[1].cwd === nwWs, 'nodewatch upgrade: npm install --prefix tools symbol-node-watcher@latest', nw[1]);
  ok(nw.every((x) => !x.args.includes('-g') && !x.args.includes('--global') && x.cmd !== 'sudo' && x.cmd !== 'git'), 'nodewatch upgrade: no -g, no sudo, no git');
  writeFileSync(join(nwTools, 'node_modules', 'symbol-node-watcher', 'package.json'), JSON.stringify({ name: 'symbol-node-watcher', version: '0.2.0' }));
  let nm3 = ''; const nc3 = await Promise.resolve(nw[2].run?.((t) => { nm3 += t; }, { stopped: () => false }));
  ok(nc3 === 0 && nm3.includes('0.2.0'), 'nodewatch upgrade: shows the new version', nm3);
  rmSync(join(nwTools, 'node_modules', 'symbol-node-watcher', 'package.json'));
  const nc4 = await Promise.resolve(nw[2].run?.(() => {}, { stopped: () => false }));
  ok(nc4 === 1, 'nodewatch upgrade: unreadable version -> fails');
  rmSync(nwWs, { recursive: true, force: true });

  // --- genpkeySteps: 上書きしない・権限 600
  const dir = join(ws, 'symbol-node'); mkdirSync(dir, { recursive: true });
  const argv = ['openssl', 'genpkey', '-algorithm', 'ed25519', '-out', 'ca.key.pem'];
  const fresh = genpkeySteps(argv, dir, 'linux');
  ok(fresh.length === 2 && fresh[0].cmd === 'openssl' && fresh[0].args.join(' ') === 'genpkey -algorithm ed25519 -out ca.key.pem' && fresh[0].cwd === dir, 'genpkey: runs openssl in the working folder', fresh[0]);
  ok(genpkeySteps(argv, dir, 'win32').length === 1, 'genpkey on Windows: no chmod step');
  writeFileSync(join(dir, 'ca.key.pem'), 'KEEP-ME');
  const clash = genpkeySteps(argv, dir, 'linux');
  let m2 = ''; const c2 = await Promise.resolve(clash[0].run?.((t) => { m2 += t; }, { stopped: () => false }));
  ok(clash.length === 1 && clash[0].cmd === '' && c2 === 1 && m2.includes('すでにあります'), 'genpkey: existing file -> refuses to overwrite', m2);
  ok(existsSync(join(dir, 'ca.key.pem')), 'existing key file untouched');
  rmSync(join(dir, 'ca.key.pem'));
  // シンボリックリンク（リンク先が無くても）は、あるものとして断る
  const { symlinkSync } = await import('node:fs');
  try { symlinkSync(join(ws, 'nowhere'), join(dir, 'ca.key.pem')); ok(genpkeySteps(argv, dir, 'linux')[0].cmd === '', 'genpkey: dangling symlink counts as existing'); rmSync(join(dir, 'ca.key.pem')); } catch { /* symlink 不可の環境では飛ばす */ }
  // 権限の手順: できたファイルを 600 にする
  writeFileSync(join(dir, 'ca.key.pem'), 'x'); chmodSync(join(dir, 'ca.key.pem'), 0o644);
  const steps = genpkeySteps(['openssl', 'genpkey', '-algorithm', 'ed25519', '-out', 'other.pem'], dir, 'linux');
  writeFileSync(join(dir, 'other.pem'), 'x'); chmodSync(join(dir, 'other.pem'), 0o644);
  const c3 = await Promise.resolve(steps[1].run?.(() => undefined, { stopped: () => false }));
  ok(c3 === 0 && (statSync(join(dir, 'other.pem')).mode & 0o777) === 0o600, 'genpkey: key file permission becomes 600');
} finally { rmSync(ws, { recursive: true, force: true }); }

console.log(`${checks} checks, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
