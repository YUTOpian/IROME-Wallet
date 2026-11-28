// エージェントの常駐化（systemd / launchd / タスク スケジューラ）と、設定ファイル・トークンのファイル。
// 本物の systemctl などは呼ばず、偽の exec で「何を呼んだか」と「何を書いたか」を確かめる。最後に、本物の run.ts を起動して、
// --config とトークンのファイルで動くこと・トークンがログに出ないことを確かめる。
// 実行: npx tsx dev-tests/node-service.test.ts
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAUNCHD_LABEL, TASK_NAME, configDirOf, installService, launchOf, parseAgentConfig, pathsOf, readTokenFile, renderLaunchdPlist,
  renderSystemdUnit, renderTaskXml, restartService, statusOf, tokenOf, uninstallService, utf16le, validOrigin,
} from '../src/server/node-agent/service';
import type { ExecResult, ServiceHost } from '../src/server/node-agent/service';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const posix = process.platform !== 'win32';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- 場所・設定ファイル
ok(configDirOf('linux', {}, '/home/u') === '/home/u/.config/irome-node-agent', 'linux config dir');
ok(configDirOf('linux', { XDG_CONFIG_HOME: '/x/cfg' }, '/home/u') === '/x/cfg/irome-node-agent', 'linux XDG_CONFIG_HOME');
ok(configDirOf('linux', { XDG_CONFIG_HOME: 'relative' }, '/home/u') === '/home/u/.config/irome-node-agent', 'relative XDG_CONFIG_HOME ignored');
ok(configDirOf('darwin', {}, '/Users/u') === '/Users/u/Library/Application Support/irome-node-agent', 'mac config dir');
ok(/AppData[\\/]Roaming[\\/]irome-node-agent$/.test(configDirOf('win32', {}, 'C:\\Users\\u')), 'win config dir fallback');
ok(configDirOf('win32', { APPDATA: 'C:\\A' }, 'C:\\Users\\u').startsWith('C:\\A'), 'win config dir uses APPDATA');

ok(parseAgentConfig('{"port":7400,"workspace":"/w","origins":["https://a.example"],"tokenFile":"/t"}').ok === true, 'config: full');
ok(parseAgentConfig('{}').ok === true, 'config: empty ok');
for (const [text, why] of [
  ['nope', 'not json'], ['[]', 'array'], ['null', 'null'], ['{"port":80}', 'port too low'], ['{"port":"7391"}', 'port string'], ['{"port":7391.5}', 'port float'],
  ['{"extra":1}', 'unknown key'], ['{"origins":"https://a"}', 'origins string'], ['{"origins":["javascript:alert(1)"]}', 'origin scheme'],
  ['{"origins":["https://a.example/path"]}', 'origin with path'], ['{"workspace":""}', 'empty workspace'], ['{"tokenFile":5}', 'tokenFile number'],
] as const) ok(parseAgentConfig(text).ok === false, `config rejected: ${why}`);
ok(validOrigin('https://example.com') && validOrigin('http://localhost:5173') && !validOrigin('https://example.com/') && !validOrigin('example.com') && !validOrigin('https://a b'), 'validOrigin');

// ---------------------------------------------------------------- トークンのファイル
const tmp = mkdtempSync(join(tmpdir(), 'irome-svc-'));
const tok = 'a'.repeat(64);
const tf = join(tmp, 'tok');
writeFileSync(tf, `${tok}\n`, { mode: 0o600 });
if (posix) chmodSync(tf, 0o600);
{
  const r = readTokenFile(tf);
  ok(r.ok && r.token === tok, 'token file read (trimmed)');
  ok(!readTokenFile(join(tmp, 'missing')).ok, 'missing token file');
  writeFileSync(join(tmp, 'short'), 'abc', { mode: 0o600 });
  ok(!readTokenFile(join(tmp, 'short')).ok, 'short token refused');
  writeFileSync(join(tmp, 'spaced'), `${'a'.repeat(20)} ${'b'.repeat(20)}`, { mode: 0o600 });
  ok(!readTokenFile(join(tmp, 'spaced')).ok, 'token with space refused');
  if (posix) {
    writeFileSync(join(tmp, 'open'), tok, { mode: 0o644 });
    chmodSync(join(tmp, 'open'), 0o644);
    const o = readTokenFile(join(tmp, 'open'));
    ok(!o.ok && /600/.test(o.reason), 'group/other-readable token refused', o);
    ok(!JSON.stringify(o).includes(tok), 'refusal does not echo the token');
    symlinkSync(tf, join(tmp, 'link'));
    ok(!readTokenFile(join(tmp, 'link')).ok, 'symlinked token file refused');
  }
}

// ---------------------------------------------------------------- 登録ファイルの中身
const L = launchOf('/opt/my repo/IROME', '/usr/bin/node', '/home/u/.config/irome-node-agent/agent.json');
{
  const unit = renderSystemdUnit(L, '/usr/local/bin:/usr/bin');
  ok(/^ExecStart="\/usr\/bin\/node" "\/opt\/my repo\/IROME\/node_modules\/tsx\/dist\/cli\.mjs" "\/opt\/my repo\/IROME\/src\/server\/node-agent\/run\.ts" "--config" "\/home\/u\/\.config\/irome-node-agent\/agent\.json"$/m.test(unit), 'systemd: ExecStart quotes every word', unit);
  ok(/^WorkingDirectory=\/opt\/my repo\/IROME$/m.test(unit), 'systemd: WorkingDirectory');
  ok(unit.includes('Environment="PATH=/usr/local/bin:/usr/bin"'), 'systemd: PATH');
  ok(/Restart=on-failure/.test(unit) && /WantedBy=default\.target/.test(unit), 'systemd: restart + install target');
  ok(!/TOKEN/i.test(unit), 'systemd: no token anywhere');
  const odd = renderSystemdUnit(launchOf('/opt/100%/$HOME/"q"', '/usr/bin/node', '/c/agent.json'), undefined);
  ok(odd.includes('100%%') && odd.includes('$$HOME') && odd.includes('\\"q\\"'), 'systemd: % $ " are escaped', odd);
  ok(!/Environment=/.test(odd), 'systemd: no PATH line when PATH is unset');

  const plist = renderLaunchdPlist(launchOf('/Users/a&b/<IROME>', '/usr/local/bin/node', '/c/agent.json'), '/usr/bin', '/c/agent.log');
  ok(plist.includes(`<string>${LAUNCHD_LABEL}</string>`) && plist.includes('/Users/a&amp;b/&lt;IROME&gt;'), 'plist: label + xml escaped', plist);
  ok(/<key>RunAtLoad<\/key><true\/>/.test(plist) && /<key>SuccessfulExit<\/key><false\/>/.test(plist), 'plist: run at load, restart on failure only');
  ok(!/TOKEN/i.test(plist), 'plist: no token');

  const WL = launchOf('C:\\repo', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\u\\AppData\\Roaming\\irome-node-agent\\agent.json');
  const xml = renderTaskXml(WL, 'PC\\u');
  ok(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>'), 'task xml: UTF-16 declaration');
  ok(xml.includes('<Command>C:\\Program Files\\nodejs\\node.exe</Command>'), 'task xml: command');
  ok(xml.includes(`<Arguments>&quot;${WL.cli}&quot; &quot;${WL.script}&quot; &quot;--config&quot; &quot;${WL.configFile}&quot;</Arguments>`), 'task xml: every argument quoted', xml);
  ok(xml.includes('<RunLevel>LeastPrivilege</RunLevel>') && xml.includes('<LogonTrigger>') && xml.includes('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>'), 'task xml: least privilege, logon trigger, no time limit');
  const bytes = utf16le('<a/>');
  ok(bytes[0] === 0xff && bytes[1] === 0xfe && bytes.length === 2 + 8, 'utf16le: BOM + 2 bytes per char');
}

// ---------------------------------------------------------------- 偽のホストで、登録・解除
interface Fake { host: ServiceHost; calls: string[]; out: () => string; home: string; repo: string }
function fake(plat: NodeJS.Platform, over: Partial<ServiceHost> = {}, linger = 'Linger=no\n'): Fake {
  const home = mkdtempSync(join(tmpdir(), 'irome-svc-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'irome-svc-repo-'));
  mkdirSync(join(repo, 'node_modules', 'tsx', 'dist'), { recursive: true });
  mkdirSync(join(repo, 'src', 'server', 'node-agent'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
  writeFileSync(join(repo, 'src', 'server', 'node-agent', 'run.ts'), '');
  const calls: string[] = [];
  let out = '';
  const registeredWin = { v: false };
  const host: ServiceHost = {
    plat, home, env: { PATH: '/bin:/usr/bin', USER: 'u', USERDOMAIN: 'PC', USERNAME: 'u' }, uid: plat === 'win32' ? null : 1000, user: 'u', repoRoot: repo, nodeExe: '/usr/bin/node',
    exec: (cmd, args): ExecResult => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'loginctl') return { status: 0, stdout: linger, stderr: '' };
      if (cmd === 'schtasks' && args[0] === '/Create') registeredWin.v = true;
      if (cmd === 'schtasks' && args[0] === '/Delete') registeredWin.v = false;
      if (cmd === 'schtasks' && args[0] === '/Query') return { status: registeredWin.v ? 0 : 1, stdout: '', stderr: '' };
      if (cmd === 'systemctl' && args[1] === 'is-active') return { status: 0, stdout: 'active\n', stderr: '' };
      if (cmd === 'systemctl' && args[1] === 'is-enabled') return { status: 0, stdout: 'enabled\n', stderr: '' };
      if (cmd === 'launchctl' && args[0] === 'print') return { status: 0, stdout: '  state = running\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    probe: async () => 'ok',
    out: (t) => { out += t; },
    ...over,
  };
  return { host, calls, out: () => out, home, repo };
}
const mode = (p: string) => statSync(p).mode & 0o777;

// --- Linux
{
  const f = fake('linux');
  const r = installService(f.host, { port: 7400, workspace: '/data/node', origins: ['https://wallet.example'] });
  ok(r.ok, 'linux: install ok', r);
  const p = pathsOf(f.host);
  ok(existsSync(p.unit as string) && readFileSync(p.unit as string, 'utf8').includes('ExecStart='), 'linux: unit written');
  ok(f.calls[0] === 'systemctl --user --version' && f.calls.slice(1, 4).join('|') === 'systemctl --user daemon-reload|systemctl --user enable irome-node-agent.service|systemctl --user restart irome-node-agent.service', 'linux: systemctl order', f.calls);
  const cfg = JSON.parse(readFileSync(p.configFile, 'utf8'));
  ok(cfg.port === 7400 && cfg.workspace === '/data/node' && cfg.origins[0] === 'https://wallet.example' && cfg.tokenFile === p.tokenFile, 'linux: agent.json content', cfg);
  const token1 = readFileSync(p.tokenFile, 'utf8').trim();
  ok(/^[0-9a-f]{64}$/.test(token1), 'linux: token is 64 hex chars');
  if (posix) ok(mode(p.tokenFile) === 0o600 && mode(p.configFile) === 0o600 && mode(p.dir) === 0o700, 'linux: token/config 600, folder 700', [mode(p.tokenFile), mode(p.configFile), mode(p.dir)]);
  ok(!f.out().includes(token1) && !readFileSync(p.unit as string, 'utf8').includes(token1) && !JSON.stringify(cfg).includes(token1), 'linux: token is never printed or written into unit/config');
  ok(/enable-linger u/.test(f.out()), 'linux: tells how to survive logout when Linger=no', f.out());
  ok(f.out().includes('http://127.0.0.1:7400'), 'linux: prints the URL');

  // もう一度: トークンは同じ、指定の無い項目は引き継ぐ、--port だけ変える
  const f2out = f.out().length;
  ok(installService(f.host, { port: 7500 }).ok, 'linux: reinstall ok');
  const cfg2 = JSON.parse(readFileSync(p.configFile, 'utf8'));
  ok(cfg2.port === 7500 && cfg2.workspace === '/data/node' && cfg2.origins?.[0] === 'https://wallet.example', 'linux: reinstall keeps unspecified settings', cfg2);
  ok(readFileSync(p.tokenFile, 'utf8').trim() === token1, 'linux: reinstall keeps the token');
  ok(f.out().length > f2out, 'linux: reinstall prints again');

  const st = await statusOf(f.host);
  ok(st.registered && st.port === 7500 && st.tokenOk && st.configOk && st.reachable === 'ok' && /active: active/.test(st.detail), 'linux: status', st);

  // トークンの表示・作り直し
  const t1 = tokenOf(f.host, false);
  ok(t1.ok && t1.token === token1 && !t1.restarted, 'token: shows the stored token');
  const before = f.calls.length;
  const t2 = tokenOf(f.host, true);
  ok(t2.ok && t2.token !== token1 && t2.restarted && readFileSync(p.tokenFile, 'utf8').trim() === t2.token, 'token --rotate: new token, restarted', t2);
  ok(f.calls.slice(before).some((c) => c === 'systemctl --user restart irome-node-agent.service'), 'token --rotate: service restarted', f.calls.slice(before));
  if (posix) ok(mode(p.tokenFile) === 0o600, 'token --rotate: still 600');
  ok(restartService(f.host).ok, 'restart: ok when registered');

  // 解除
  ok(uninstallService(f.host, false).ok && !existsSync(p.unit as string) && existsSync(p.tokenFile), 'uninstall: unit removed, token kept');
  ok(f.calls.some((c) => c === 'systemctl --user disable --now irome-node-agent.service'), 'uninstall: disable --now');
  ok(!restartService(f.host).ok, 'restart: refused when not registered');
  ok(uninstallService(f.host, true).ok && !existsSync(p.tokenFile) && !existsSync(p.configFile), 'uninstall --purge: config and token removed');
  ok(!tokenOf(f.host, false).ok, 'token: gone after purge');
  rmSync(f.home, { recursive: true, force: true }); rmSync(f.repo, { recursive: true, force: true });
}
// --- Linux: Linger=yes のときは案内しない / systemd が無いとき / 権限
{
  const f = fake('linux', {}, 'Linger=yes\n');
  ok(installService(f.host, {}).ok && !/enable-linger/.test(f.out()), 'linux: no linger note when Linger=yes');
  const g = fake('linux', { exec: (c, a) => ({ status: c === 'systemctl' && a[1] === '--version' ? 1 : 0, stdout: '', stderr: '' }) });
  const r = installService(g.host, {});
  ok(!r.ok && /systemd/.test((r as { message: string }).message), 'linux: no systemd → clear error', r);
  const h = fake('linux', { uid: 0 });
  ok(!installService(h.host, {}).ok && !existsSync(pathsOf(h.host).configFile), 'refuses root, writes nothing');
  const i = fake('linux');
  rmSync(join(i.repo, 'node_modules'), { recursive: true });
  const ri = installService(i.host, {});
  ok(!ri.ok && /npm ci/.test((ri as { message: string }).message) && !existsSync(pathsOf(i.host).configFile), 'missing tsx → tells to npm ci, writes nothing', ri);
  const j = fake('linux');
  j.host.env.PATH = '/bin\nExecStartPost=/bin/evil';
  ok(!installService(j.host, {}).ok && !existsSync(pathsOf(j.host).unit as string), 'newline in PATH refused (no injected unit lines)');
  const k = fake('linux');
  ok(!installService(k.host, { port: 80 }).ok && !installService(k.host, { origins: ['nope'] }).ok, 'bad --port / --origin refused');
  const m = fake('linux');
  const pm = pathsOf(m.host);
  mkdirSync(pm.dir, { recursive: true });
  writeFileSync(pm.tokenFile, 'x'.repeat(40), { mode: 0o644 });
  if (posix) { chmodSync(pm.tokenFile, 0o644); ok(!installService(m.host, {}).ok, 'existing loose-permission token file is refused, not reused'); }
  for (const d of [f, g, h, i, j, k, m]) { rmSync(d.home, { recursive: true, force: true }); rmSync(d.repo, { recursive: true, force: true }); }
}
// --- macOS
{
  const f = fake('darwin');
  ok(installService(f.host, {}).ok, 'mac: install ok');
  const p = pathsOf(f.host);
  ok(existsSync(p.plist as string) && (p.plist as string).endsWith(`${LAUNCHD_LABEL}.plist`), 'mac: plist written under LaunchAgents');
  ok(f.calls.some((c) => c === `launchctl bootout gui/1000/${LAUNCHD_LABEL}`) && f.calls.some((c) => c === `launchctl bootstrap gui/1000 ${p.plist}`) && f.calls.some((c) => c === `launchctl kickstart -k gui/1000/${LAUNCHD_LABEL}`), 'mac: bootout → bootstrap → kickstart', f.calls);
  const st = await statusOf(f.host);
  ok(st.registered && /state = running/.test(st.detail), 'mac: status', st);
  ok(uninstallService(f.host, false).ok && !existsSync(p.plist as string) && f.calls.some((c) => c === `launchctl bootout gui/1000/${LAUNCHD_LABEL}`), 'mac: uninstall');
  const g = fake('darwin', { exec: (c, a) => ({ status: c === 'launchctl' && a[0] === 'bootstrap' ? 5 : 0, stdout: '', stderr: 'Bootstrap failed' }) });
  const r = installService(g.host, {});
  ok(!r.ok && /launchctl bootstrap/.test((r as { message: string }).message), 'mac: bootstrap failure is reported', r);
  for (const d of [f, g]) { rmSync(d.home, { recursive: true, force: true }); rmSync(d.repo, { recursive: true, force: true }); }
}
// --- Windows
{
  const f = fake('win32');
  const r = installService(f.host, {});
  ok(r.ok, 'win: install ok', r);
  const p = pathsOf(f.host);
  const raw = readFileSync(p.taskXml as string);
  ok(raw[0] === 0xff && raw[1] === 0xfe && raw.subarray(2).toString('utf16le').includes('<Command>/usr/bin/node</Command>'), 'win: task.xml is UTF-16 LE with BOM');
  const seq = f.calls.filter((c) => c.startsWith('schtasks')).map((c) => c.split(' ').slice(0, 3).join(' '));
  ok(seq[0] === `schtasks /Create /TN` && f.calls.some((c) => c === `schtasks /Create /TN ${TASK_NAME} /XML ${p.taskXml} /F`) && f.calls.some((c) => c === `schtasks /Run /TN ${TASK_NAME}`), 'win: schtasks /Create then /Run', f.calls);
  ok((await statusOf(f.host)).registered, 'win: status registered');
  ok(uninstallService(f.host, true).ok && f.calls.some((c) => c === `schtasks /Delete /TN ${TASK_NAME} /F`) && !existsSync(p.taskXml as string), 'win: uninstall --purge');
  ok(!(await statusOf(f.host)).registered, 'win: status after uninstall');
  const g = fake('win32');
  g.host.nodeExe = 'C:\\Program "Files"\\node.exe';
  ok(!installService(g.host, {}).ok, 'win: quote in path refused');
  const h = fake('freebsd' as NodeJS.Platform);
  ok(!installService(h.host, {}).ok && !uninstallService(h.host, false).ok && !restartService(h.host).ok, 'unsupported OS refused');
  for (const d of [f, g, h]) { rmSync(d.home, { recursive: true, force: true }); rmSync(d.repo, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- 本物の run.ts を、--config とトークンのファイルで起動する
const freePort = (): Promise<number> => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
interface Run { code: number | null; out: string }
function runAgent(args: string[], env: Record<string, string>, until: RegExp | null, then?: (out: string) => Promise<void>): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/server/node-agent/run.ts'), ...args], { cwd: root, env: { ...process.env, IROME_NODE_AGENT_TOKEN: '', IROME_NODE_AGENT_ALLOW_ROOT: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let acted = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    const onData = (b: Buffer) => {
      out += b.toString();
      if (until !== null && !acted && until.test(out)) { acted = true; void (async () => { try { await then?.(out); } finally { child.kill('SIGTERM'); } })(); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('close', (code) => { clearTimeout(timer); done({ code, out }); });
  });
}
{
  const ws = mkdtempSync(join(tmpdir(), 'irome-svc-ws-'));
  const dir = mkdtempSync(join(tmpdir(), 'irome-svc-cfg-'));
  const token = 'f'.repeat(64);
  const tokenPath = join(dir, 'agent-token');
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  if (posix) chmodSync(tokenPath, 0o600);
  const port = await freePort();
  const cfgPath = join(dir, 'agent.json');
  writeFileSync(cfgPath, JSON.stringify({ port, workspace: ws, tokenFile: tokenPath, origins: ['https://wallet.example'] }));

  const seen: { noTok?: number; withTok?: number; badTok?: number; origin?: number } = {};
  const r = await runAgent(['--config', cfgPath], {}, /止めるときは/, async () => {
    const url = `http://127.0.0.1:${port}/v1/files`;
    seen.noTok = (await fetch(url)).status;
    seen.badTok = (await fetch(url, { headers: { Authorization: `Bearer ${'0'.repeat(64)}` } })).status;
    seen.withTok = (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status;
    seen.origin = (await fetch(url, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://wallet.example' } })).status;
  });
  ok(seen.noTok === 401 && seen.badTok === 401 && seen.withTok === 200, 'run.ts --config: token from the file is required and works', seen);
  ok(seen.origin === 200, 'run.ts --config: origins from the file are allowed', seen);
  ok(!r.out.includes(token), 'run.ts: the token from the file is not printed', r.out);
  ok(r.out.includes(`http://127.0.0.1:${port}`) && r.out.includes(ws), 'run.ts: port and workspace come from the config', r.out);
  ok(/ファイルから読みました/.test(r.out), 'run.ts: says the token came from a file');

  // 環境変数が優先（ポート・トークン）
  const port2 = await freePort();
  const envTok = 'e'.repeat(40);
  const seen2: { env?: number; file?: number } = {};
  const r2 = await runAgent(['--config', cfgPath], { IROME_NODE_AGENT_PORT: String(port2), IROME_NODE_AGENT_TOKEN: envTok }, /止めるときは/, async () => {
    const url = `http://127.0.0.1:${port2}/v1/files`;
    seen2.env = (await fetch(url, { headers: { Authorization: `Bearer ${envTok}` } })).status;
    seen2.file = (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status;
  });
  ok(seen2.env === 200 && seen2.file === 401, 'run.ts: env token and port win over the config file', { seen2, out: r2.out });

  // 権限が広いトークンのファイルでは、起動しない
  if (posix) {
    const loose = join(dir, 'loose');
    writeFileSync(loose, token, { mode: 0o644 });
    chmodSync(loose, 0o644);
    const cfgLoose = join(dir, 'loose.json');
    writeFileSync(cfgLoose, JSON.stringify({ port: await freePort(), workspace: ws, tokenFile: loose }));
    const r3 = await runAgent(['--config', cfgLoose], {}, null);
    ok(r3.code === 1 && /600/.test(r3.out) && !r3.out.includes(token), 'run.ts: loose token-file permissions → refuses to start, no token in output', r3);
  }
  // 壊れた設定・知らない引数
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{"port":80}');
  const r4 = await runAgent(['--config', bad], {}, null);
  ok(r4.code === 1 && /port/.test(r4.out), 'run.ts: invalid config → exit 1', r4);
  const r5 = await runAgent(['--bogus'], {}, null);
  ok(r5.code === 1, 'run.ts: unknown argument → exit 1', r5);
  const r6 = await runAgent(['--config', join(dir, 'nope.json')], {}, null);
  ok(r6.code === 1, 'run.ts: missing config file → exit 1', r6);
  rmSync(ws, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
}

rmSync(tmp, { recursive: true, force: true });
console.log(`${checks - fails}/${checks} checks passed`);
if (fails > 0) process.exit(1);
