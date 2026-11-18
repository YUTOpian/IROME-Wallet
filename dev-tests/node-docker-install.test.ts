// ノード構築エージェント: Docker を入れる手順（sudo を 1 回だけ使う）の確認。
// - 許可リスト: `irome install docker` は通る。`irome uninstall docker`・`irome upgrade docker`・画面から打つ `sudo …` は通さない。
// - 手順: Linux の Ubuntu / Debian 系だけ。入っていれば sudo を使わない。sudo に渡すのは、固定のスクリプトと、確かめ済みの 5 つの値だけ。
// - 鍵の取得先は download.docker.com だけ（Node.js・Python の取得先には足していない）。
// - sudo の中のスクリプトを、本物の sh で動かす（apt-get・usermod・id は偽物に差し替え、gpg は本物）。指紋が合わない・鍵が 2 つ・値が不正なときは、何も足さずに止まる。
// - Mac: sudo を使わずに、Docker Desktop（Docker.app）を置く。取得先は desktop.docker.com の dmg だけ。Apple の署名（開発元・識別子・公証）が合わなければ、何も置かずに止まる。
//   hdiutil・codesign・spctl・ditto・open は偽物に差し替える（実物の Mac での実行は、この試験では確かめない）。
// - Windows: エージェントは昇格しない。取得先は desktop.docker.com のインストーラーだけ。Authenticode の署名（有効・発行元 Docker Inc）が合わなければ、UAC の前に止まる。
//   確認のあとにファイルが差し替わったら、起動しない。UAC で「いいえ」なら、何も入らない。PowerShell（絶対パス・固定のスクリプト）は偽物に差し替える（実物の Windows での実行は、この試験では確かめない）。
// 外部には繋がない。root も要らない。
// 実行: npx tsx dev-tests/node-docker-install.test.ts
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTALL_TARGETS, UNINSTALL_TARGETS, parseCommandLine } from '../src/lib/node/nodeCommands';
import { DOWNLOAD_HOSTS, download, downloadToFile, hostAllowed, sweepTmp } from '../src/server/node-agent/provision';
import { childEnv, dockerDesktopBinDirs } from '../src/server/node-agent/platform';
import { installSteps, uninstallSteps } from '../src/server/node-agent/agent';
import { DOCKER_DESKTOP_BUNDLE_ID, DOCKER_DESKTOP_HOSTS, DOCKER_DESKTOP_TEAM_ID, DOCKER_DESKTOP_WIN_ARGS, DOCKER_DESKTOP_WIN_SIGNERS, DOCKER_KEY_FINGERPRINT, DOCKER_KEY_HOSTS, DOCKER_PACKAGES, MAC_BIN, SUDO_SCRIPT, WIN_INSTALL_SCRIPT, WIN_VERIFY_SCRIPT, buildSudoArgs, dockerDesktopUrl, dockerDesktopWinUrl, parseAuthenticodeInfo, parseCodesignInfo, parseOsRelease, psEncode, validateKeyText, winPowerShell, winPowerShellArgs } from '../src/server/node-agent/dockerInstall';
import type { RunResult } from '../src/server/node-agent/dockerInstall';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const reason = (line: string) => { const r = parseCommandLine(line); return r.ok ? 'OK' : r.reason; };

const tmp = mkdtempSync(join(tmpdir(), 'irome-docker-'));

// ---- 1. 許可リスト
ok(reason('irome install docker') === 'OK', 'irome install docker is accepted');
ok(INSTALL_TARGETS.includes('docker') && !UNINSTALL_TARGETS.includes('docker'), 'docker is an install target but not an uninstall target');
for (const line of ['irome uninstall docker', 'irome upgrade docker', 'irome install docker extra', 'irome install Docker', 'irome install docker;id'])
  ok(reason(line) !== 'OK', `refused: ${line}`, reason(line));
ok(reason('irome uninstall node') === 'OK' && reason('irome upgrade shoestring') === 'OK', 'other irome recipes are unchanged');
for (const line of ['sudo apt-get install docker-ce', 'sudo -n true', 'sudo', 'sudo irome install docker', '/usr/bin/sudo id', 'su -c id', 'sh -c id', 'apt-get install docker-ce', 'usermod -aG docker me', 'systemctl start docker'])
  ok(reason(line) === 'tool_not_allowed' || reason(line) !== 'OK', `sudo and friends are not typable: ${line}`, reason(line));
ok(reason('sudo apt-get install docker-ce') === 'tool_not_allowed', 'sudo is tool_not_allowed');

// ---- 2. /etc/os-release の読み取り
const osr = (body: string) => parseOsRelease(body);
ok(JSON.stringify(osr('ID=ubuntu\nID_LIKE=debian\nVERSION_CODENAME=jammy\nUBUNTU_CODENAME=jammy\n')) === JSON.stringify({ base: 'ubuntu', codename: 'jammy', derived: false }), 'ubuntu');
ok(JSON.stringify(osr('ID=debian\nVERSION_CODENAME=bookworm\n')) === JSON.stringify({ base: 'debian', codename: 'bookworm', derived: false }), 'debian');
ok(JSON.stringify(osr('ID="debian"\nVERSION_CODENAME="bookworm"\n')) === JSON.stringify({ base: 'debian', codename: 'bookworm', derived: false }), 'quoted values');
ok(JSON.stringify(osr('ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_CODENAME=virginia\nUBUNTU_CODENAME=jammy\n')) === JSON.stringify({ base: 'ubuntu', codename: 'jammy', derived: true }), 'linux mint -> ubuntu codename');
ok(JSON.stringify(osr('ID=raspbian\nID_LIKE=debian\nVERSION_CODENAME=bookworm\n')) === JSON.stringify({ base: 'debian', codename: 'bookworm', derived: true }), 'debian derivative');
for (const [body, why] of [
  ['ID=fedora\nVERSION_CODENAME=\n', 'fedora'], ['ID=arch\n', 'arch'], ['ID=debian\n', 'debian without codename (testing / sid)'], ['ID=kali\nID_LIKE=debian\nVERSION_CODENAME=kali-rolling\n', 'hyphenated codename'],
  ['ID=ubuntu\nVERSION_CODENAME=jammy;id\n', 'codename with shell chars'], ['ID=ubuntu\nVERSION_CODENAME=$(id)\n', 'codename with substitution'], ['', 'empty'],
] as const) ok(osr(body) === null, `os-release refused: ${why}`);

// ---- 3. 鍵の形
const KEY = '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQINBFit2ioBEADhWpZ8/wvZ6hUTiXOwQHXMAlaFHcPH9hAtr4F1y2+OYdbtMuth\n=abcd\n-----END PGP PUBLIC KEY BLOCK-----\n';
ok(validateKeyText(KEY) === KEY.trim(), 'key: accepted (trimmed)');
ok(validateKeyText(KEY.replace(/\n/g, '\r\n')) === KEY.trim(), 'key: CRLF normalised');
for (const [text, why] of [
  ['hello', 'not a key'], ['', 'empty'], [KEY + KEY, 'two key blocks'], [KEY.replace('PUBLIC', 'PRIVATE'), 'private key block'], [`x\n${KEY}`, 'junk before'],
  [KEY.replace('mQIN', 'mQ\u00e9N'), 'non-ascii'], [KEY.replace('mQIN', 'mQ\u0000N'), 'control char'], [KEY.replace('\n=abcd', '\n$(id)'), 'dollar sign passes only as data (see below)'],
  ['-----BEGIN PGP PUBLIC KEY BLOCK-----\n' + 'A'.repeat(40_000) + '\n-----END PGP PUBLIC KEY BLOCK-----', 'too large'],
] as const) {
  if (why.startsWith('dollar')) { ok(validateKeyText(text) !== null, 'key: printable characters such as $ are data, never evaluated'); continue; }
  ok(validateKeyText(text) === null, `key refused: ${why}`);
}

// ---- 4. sudo に渡すもの
const plan = { base: 'ubuntu' as const, codename: 'jammy', arch: 'amd64', user: 'alice', derived: false };
const args = buildSudoArgs(plan, KEY.trim());
ok(args.length === 10 && args[0] === '--' && args[1] === '/bin/sh' && args[2] === '-c' && args[3] === SUDO_SCRIPT, 'sudo args: fixed shell + fixed script');
ok(args.slice(4).join('|') === ['irome-docker-install', 'ubuntu', 'jammy', 'amd64', 'alice', KEY.trim()].join('|'), 'sudo args: only the five checked values follow');
ok(!SUDO_SCRIPT.includes('alice') && !SUDO_SCRIPT.includes('jammy'), 'script text holds no per-run values');
ok(SUDO_SCRIPT.includes(DOCKER_KEY_FINGERPRINT) && /^[0-9A-F]{40}$/.test(DOCKER_KEY_FINGERPRINT), 'script pins the official fingerprint');
ok(DOCKER_KEY_FINGERPRINT === '9DC858229FC7DD38854AE2D88D81803C0EBFCD88', 'fingerprint is the one Docker documents (9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88)');
ok(SUDO_SCRIPT.includes(`apt-get install -y ${DOCKER_PACKAGES.join(' ')}\n`) && DOCKER_PACKAGES.length === 5, 'script installs exactly the five Docker packages');
for (const bad of ['curl', 'wget', 'eval', '| sh', '| bash', 'chmod', 'chown', 'sudoers', 'passwd', 'visudo', 'docker run', 'ssh', '/dev/tcp'])
  ok(!SUDO_SCRIPT.includes(bad), `script does not contain: ${bad}`);
ok(SUDO_SCRIPT.split('\n').filter((l) => /\brm\b/.test(l)).join('|') === `trap 'rm -rf "$TMPD"' EXIT`, 'script removes only its own temporary folder');
ok(SUDO_SCRIPT.startsWith('set -eu\n') && SUDO_SCRIPT.includes('PATH=/usr/sbin:/usr/bin:/sbin:/bin\nexport PATH'), 'script stops on error and fixes PATH first');
const rootOps = SUDO_SCRIPT.split('\n').filter((l) => /^(apt-get|systemctl|usermod|install|printf '%s\\n' "Types)/.test(l));
ok(rootOps.length === 8, 'root operations are the expected 8 lines', rootOps);
for (const sh of ['sh', 'dash']) {
  const f = join(tmp, `script-${sh}.sh`);
  writeFileSync(f, SUDO_SCRIPT);
  const r = spawnSync(sh, ['-n', f], { encoding: 'utf8' });
  ok(r.status === 0, `script passes ${sh} -n`, r.stderr);
}

// ---- 5. 鍵の取得先
{
  ok(DOCKER_KEY_HOSTS.length === 1 && DOCKER_KEY_HOSTS[0] === 'download.docker.com', 'key host list has exactly one host');
  ok(!DOWNLOAD_HOSTS.includes('download.docker.com') && DOWNLOAD_HOSTS.length === 5, 'Node.js / Python host list is unchanged (no docker host added)');
  ok(hostAllowed('https://download.docker.com/linux/ubuntu/gpg', DOCKER_KEY_HOSTS), 'docker host allowed for the key');
  ok(!hostAllowed('https://nodejs.org/x', DOCKER_KEY_HOSTS) && !hostAllowed('https://github.com/x', DOCKER_KEY_HOSTS), 'other hosts are refused for the key');
  ok(!hostAllowed('https://download.docker.com/x'), 'docker host is refused for the default (Node.js / Python) fetches');
  for (const u of ['http://download.docker.com/x', 'https://download.docker.com.evil.example/x', 'https://user@download.docker.com/x', 'https://download.docker.com:444/x'])
    ok(!hostAllowed(u, DOCKER_KEY_HOSTS), `docker host: refused ${u}`);
  // 取得の関数そのものも、渡された取得先の外には出ない（リダイレクトも）。外のホストには、通信しない。
  const contacted: string[] = [];
  const spy = (async (input: RequestInfo | URL) => {
    contacted.push(String(input));
    return String(input).endsWith('/redir') ? new Response(null, { status: 302, headers: { location: 'https://evil.example/k' } }) : new Response('ok');
  }) as typeof fetch;
  const dctx = { ws: tmp, out: () => undefined, stopped: () => false, fetchImpl: spy, allowedHosts: DOCKER_KEY_HOSTS };
  let threw = 0;
  for (const u of ['https://nodejs.org/x', 'https://github.com/x', 'https://download.docker.com/redir']) { try { await download(u, dctx, 1000); } catch { threw++; } }
  ok(threw === 3, 'download with the docker host list refuses other hosts and a redirect away');
  ok(contacted.join('|') === 'https://download.docker.com/redir', 'only the docker host was contacted', contacted);
  let threw2 = false;
  try { await download('https://download.docker.com/x', { ...dctx, allowedHosts: undefined }, 1000); } catch { threw2 = true; }
  ok(threw2, 'without the docker host list, download.docker.com is refused');
}

// ---- 6. 手順（偽物の取得・偽物の OS 情報）
const ws = join(tmp, 'ws');
mkdirSync(ws, { recursive: true });
const collect = () => { const lines: string[] = []; return { out: (t: string) => { lines.push(t); }, text: () => lines.join('') }; };
const ctl = { stopped: () => false };
const keyFetch = (seen: string[], body = KEY): typeof fetch => (async (input: RequestInfo | URL) => {
  seen.push(String(input));
  return String(input) === 'https://download.docker.com/linux/ubuntu/gpg' ? new Response(body) : new Response('nf', { status: 404 });
}) as typeof fetch;
const hooks = (over: Record<string, unknown> = {}) => {
  // docker は、最初（確認のとき）は無く、sudo のあと（最後の確認のとき）には、ある
  let n = 0;
  return {
  osRelease: () => 'ID=ubuntu\nVERSION_CODENAME=jammy\nUBUNTU_CODENAME=jammy\n',
  sudoPath: () => '/usr/bin/sudo',
  dpkgArch: async () => 'amd64',
  dockerVersion: async () => (n++ === 0 ? null : 'Docker version 27.0.0') as string | null,
  dockerCompose: async () => 'Docker Compose version v2.0.0',
  dockerInfo: async () => 'Server: ok' as string | null,
  userName: () => 'alice',
  uid: () => 1000 as number | undefined,
  ...over,
  };
};
const stepsOf = (platform: NodeJS.Platform, h: ReturnType<typeof hooks>, seen: string[] = []) => installSteps('docker', ws, { platform, fetch: keyFetch(seen), docker: h });

{
  const seen: string[] = [];
  const steps = stepsOf('linux', hooks(), seen);
  ok(steps.length === 4, 'four steps: check / key / sudo / verify');
  ok(steps[2].pty === true && steps[2].cmd === '/usr/bin/sudo' && steps[2].prepare !== undefined, 'the sudo step is the third, uses the absolute sudo path and a terminal');
  ok(steps.filter((s) => s.cmd !== '').length === 1, 'sudo is the only step that starts a program');
  const c1 = collect();
  ok((await steps[0].run?.(c1.out, ctl)) === 0, 'check passes on ubuntu');
  ok(c1.text().includes('sudo で 1 回だけ') && c1.text().includes('usermod -aG docker alice') && c1.text().includes(DOCKER_KEY_FINGERPRINT), 'check lists everything sudo will do, including the group');
  ok(seen.length === 0, 'check fetches nothing');
  const c2 = collect();
  ok((await steps[1].run?.(c2.out, ctl)) === 0, 'key fetched');
  ok(seen.length === 1 && seen[0] === 'https://download.docker.com/linux/ubuntu/gpg', 'only the key URL was contacted', seen);
  const c3 = collect();
  const prepared = await steps[2].prepare?.(c3.out, ctl);
  ok(Array.isArray(prepared) && prepared.join('\u0000') === buildSudoArgs(plan, KEY.trim()).join('\u0000'), 'prepare returns exactly the fixed args');
  const c4 = collect();
  ok((await steps[3].run?.(c4.out, ctl)) === 0, 'verify passes');
}
{
  // すでに入っている: sudo を使わない
  const steps = stepsOf('linux', hooks({ dockerVersion: async () => 'Docker version 27.0.0' }));
  const c = collect();
  ok((await steps[0].run?.(c.out, ctl)) === 0 && c.text().includes('もう入っています'), 'already installed: finishes');
  ok((await steps[1].run?.(() => undefined, ctl)) === 0, 'already installed: key step is a no-op');
  ok((await steps[2].prepare?.(() => undefined, ctl)) === 'skip', 'already installed: sudo is skipped');
  ok((await steps[3].run?.(() => undefined, ctl)) === 0, 'already installed: verify is a no-op');
}
for (const [what, plat, over, text] of [
  ['root', 'linux', { uid: () => 0 }, 'root'],
  ['fedora', 'linux', { osRelease: () => 'ID=fedora\n' }, 'Ubuntu・Debian'], ['no sudo', 'linux', { sudoPath: () => null }, 'sudo'],
  ['odd cpu', 'linux', { dpkgArch: async () => 'riscv64' }, 'CPU'], ['no cpu', 'linux', { dpkgArch: async () => null }, 'CPU'],
  ['bad user', 'linux', { userName: () => 'a b;id' }, 'ユーザー名'], ['root user', 'linux', { userName: () => 'root' }, 'ユーザー名'],
] as const) {
  const steps = stepsOf(plat as NodeJS.Platform, hooks(over as Record<string, unknown>));
  const c = collect();
  ok((await steps[0].run?.(c.out, ctl)) === 1 && c.text().includes(text), `check stops: ${what}`, c.text());
  ok((await steps[2].prepare?.(() => undefined, ctl)) === null, `sudo never starts: ${what}`);
}
{
  // 鍵: 形が違う・取得できない → 止まる。sudo は始まらない
  const steps = stepsOf('linux', hooks());
  await steps[0].run?.(() => undefined, ctl);
  const bad = installSteps('docker', ws, { platform: 'linux', fetch: keyFetch([], 'not a key'), docker: hooks() });
  await bad[0].run?.(() => undefined, ctl);
  const c = collect();
  ok((await bad[1].run?.(c.out, ctl)) === 1 && c.text().includes('公開鍵の形ではありません'), 'a non-key download stops the install');
  ok((await bad[2].prepare?.(() => undefined, ctl)) === null, 'sudo does not start without a checked key');
  const nf = installSteps('docker', ws, { platform: 'linux', fetch: (async () => new Response('nf', { status: 404 })) as typeof fetch, docker: hooks() });
  await nf[0].run?.(() => undefined, ctl);
  ok((await nf[1].run?.(() => undefined, ctl)) === 1 && (await nf[2].prepare?.(() => undefined, ctl)) === null, 'a failed download stops the install');
  const skipKey = installSteps('docker', ws, { platform: 'linux', fetch: keyFetch([]), docker: hooks() });
  ok((await skipKey[2].prepare?.(() => undefined, ctl)) === null, 'sudo does not start if the check never ran');
}
{
  // verify: デーモンに繋がらないときは、ログインし直しを案内する（失敗にはしない）
  const steps = stepsOf('linux', hooks({ dockerInfo: async () => null }));
  await steps[0].run?.(() => undefined, ctl);
  const c = collect();
  ok((await steps[3].run?.(c.out, ctl)) === 0 && c.text().includes('ログインし直して'), 'verify: tells to log in again when the daemon is not reachable yet');
  const none = stepsOf('linux', hooks({ dockerVersion: async () => null }));
  await none[0].run?.(() => undefined, ctl);
  ok((await none[3].run?.(() => undefined, ctl)) === 1, 'verify: fails when docker is still missing');
}
{
  const un = uninstallSteps('docker', ws);
  const c = collect();
  ok(un.length === 1 && (await un[0].run?.(c.out, ctl)) === 1 && c.text().includes('削除しません'), 'uninstall docker: only a refusal message (defence in depth)');
}

// ---- 6b. Mac（Docker Desktop。sudo は使わない）
ok(dockerDesktopUrl('arm64') === 'https://desktop.docker.com/mac/main/arm64/Docker.dmg', 'mac url: Apple silicon -> arm64');
ok(dockerDesktopUrl('x64') === 'https://desktop.docker.com/mac/main/amd64/Docker.dmg', 'mac url: Intel -> amd64');
ok(dockerDesktopUrl('ia32') === null && dockerDesktopUrl('ppc') === null && dockerDesktopUrl('') === null, 'mac url: other CPUs -> null');
ok(DOCKER_DESKTOP_HOSTS.length === 1 && DOCKER_DESKTOP_HOSTS[0] === 'desktop.docker.com', 'mac download host list is only desktop.docker.com');
ok(!DOWNLOAD_HOSTS.includes('desktop.docker.com') && !DOCKER_KEY_HOSTS.includes('desktop.docker.com'), 'desktop.docker.com is not added to the Node/Python or Linux-key host lists');
ok(hostAllowed('https://desktop.docker.com/mac/main/arm64/Docker.dmg', DOCKER_DESKTOP_HOSTS) && !hostAllowed('https://download.docker.com/mac/x', DOCKER_DESKTOP_HOSTS) && !hostAllowed('http://desktop.docker.com/x', DOCKER_DESKTOP_HOSTS), 'mac host list: https + exact host only');
ok(DOCKER_DESKTOP_TEAM_ID === '9BNSXJN65R' && DOCKER_DESKTOP_BUNDLE_ID === 'com.docker.docker', 'mac pins the developer Team ID and bundle id');
ok(Object.values(MAC_BIN).every((b) => b.startsWith('/')), 'mac external commands are absolute paths');
{
  const i = parseCodesignInfo('Executable=/x/Docker\nIdentifier=com.docker.docker\nTeamIdentifier=9BNSXJN65R\nAuthority=Developer ID Application: Docker Inc (9BNSXJN65R)\n');
  ok(i.identifier === 'com.docker.docker' && i.teamId === '9BNSXJN65R', 'codesign info: reads identifier and team id');
  const none = parseCodesignInfo('Identifier=a\nTeamIdentifier=not set\nTeamIdentifier=X\n');
  ok(none.identifier === 'a' && none.teamId === null, 'codesign info: two TeamIdentifier lines -> null');
  ok(parseCodesignInfo('').teamId === null && parseCodesignInfo('').identifier === null, 'codesign info: empty -> null');
}
{
  const home = join(tmp, 'home');
  const bin = join(home, 'Applications', 'Docker.app', 'Contents', 'Resources', 'bin');
  mkdirSync(bin, { recursive: true });
  ok(dockerDesktopBinDirs('darwin', home).includes(bin), 'mac PATH: ~/Applications Docker.app bin is found');
  ok(dockerDesktopBinDirs('linux', home).length === 0 && dockerDesktopBinDirs('win32', home).length === 0, 'mac PATH: nothing added on Linux / Windows');
  const e = childEnv(ws0(), 'darwin', { PATH: '/usr/bin:/bin' });
  ok(String(e.PATH).startsWith(join(ws0(), 'tools', 'node_modules', '.bin')) && String(e.PATH).includes('/usr/bin:/bin'), 'mac PATH: tools/ stays first, the original PATH is kept');
  function ws0() { return join(tmp, 'ws'); }
}

const mws = join(tmp, 'mws');
mkdirSync(mws, { recursive: true });
const tmpLeft = () => (existsSync(join(mws, 'tools')) ? readdirSync(join(mws, 'tools')).filter((n) => n.startsWith('.docker-tmp-')) : []);
const dmgFetch = (seen: string[], over?: (url: string) => Response | null): typeof fetch => (async (input: RequestInfo | URL) => {
  const url = String(input);
  seen.push(url);
  const o = over?.(url);
  if (o) return o;
  return /^https:\/\/desktop\.docker\.com\/mac\/main\/(arm64|amd64)\/Docker\.dmg$/.test(url) ? new Response('FAKE-DMG-BYTES', { headers: { 'content-length': '14' } }) : new Response('nf', { status: 404 });
}) as typeof fetch;
type Call = [string, string[]];
const macRun = (log: Call[], over: Record<string, RunResult> = {}) => {
  const counts: Record<string, number> = {};
  return async (cmd: string, args: string[]): Promise<RunResult> => {
    log.push([cmd, args]);
    const base = cmd.split('/').pop() as string;
    const key = base === 'hdiutil' ? `hdiutil:${args[0]}` : base === 'codesign' ? (args[0] === '--verify' ? 'codesign:verify' : 'codesign:info') : base;
    counts[key] = (counts[key] ?? 0) + 1;
    const hit = over[`${key}#${counts[key]}`] ?? over[key];
    if (hit) return hit;
    if (key === 'hdiutil:attach') {
      const mnt = args[args.indexOf('-mountpoint') + 1];
      mkdirSync(join(mnt, 'Docker.app', 'Contents'), { recursive: true });
      writeFileSync(join(mnt, 'Docker.app', 'Contents', 'marker'), 'x');
    }
    if (key === 'ditto') cpSync(args[0], args[1], { recursive: true });
    if (key === 'codesign:info') return { code: 0, text: `Executable=/x/Docker\nIdentifier=${DOCKER_DESKTOP_BUNDLE_ID}\nTeamIdentifier=${DOCKER_DESKTOP_TEAM_ID}\n` };
    return { code: 0, text: '' };
  };
};
const macSteps = (apps: string, o: { arch?: string; log?: Call[]; seen?: string[]; over?: Record<string, RunResult>; fetchOver?: (u: string) => Response | null; hooks?: Record<string, unknown> } = {}) => {
  const log = o.log ?? [];
  let n = 0;
  return installSteps('docker', mws, {
    platform: 'darwin',
    fetch: dmgFetch(o.seen ?? [], o.fetchOver),
    docker: {
      uid: () => 1000, arch: () => o.arch ?? 'arm64', appPaths: () => [], applicationsDir: () => apps, run: macRun(log, o.over),
      // docker は、最初（確認のとき）は無く、入れたあと（最後の確認のとき）には、ある
      dockerVersion: async () => (n++ === 0 ? null : 'Docker version 27.0.0'), dockerInfo: async () => null,
      ...(o.hooks ?? {}),
    } as never,
  });
};
const runAll = async (steps: ReturnType<typeof macSteps>) => {
  const c = collect();
  const codes: number[] = [];
  for (const st of steps) { const r = await st.run?.(c.out, ctl); codes.push(r ?? -1); if (r !== 0) break; }
  return { codes, text: c.text() };
};

{
  // 正常: Apple シリコン
  const apps = join(tmp, 'apps1'); mkdirSync(apps);
  const log: Call[] = []; const seen: string[] = [];
  const steps = macSteps(apps, { log, seen });
  ok(steps.length === 5 && steps.every((st) => st.cmd === '' && st.pty !== true && st.prepare === undefined), 'mac: five steps, none starts a program directly, none uses a terminal or sudo');
  const r = await runAll(steps);
  ok(r.codes.join(',') === '0,0,0,0,0', 'mac: all five steps succeed', r);
  ok(seen.length === 1 && seen[0] === 'https://desktop.docker.com/mac/main/arm64/Docker.dmg', 'mac: only the arm64 dmg URL was contacted', seen);
  ok(existsSync(join(apps, 'Docker.app', 'Contents', 'marker')), 'mac: Docker.app was placed');
  ok(!existsSync(join(apps, '.Docker-irome-tmp.app')), 'mac: no half-copied folder is left');
  ok(tmpLeft().length === 0, 'mac: the temporary download folder is removed', tmpLeft());
  const names = log.map(([c]) => c);
  ok(names.every((c) => (Object.values(MAC_BIN) as string[]).includes(c)), 'mac: only the five absolute-path commands are ever run', names);
  ok(!names.some((c) => /sudo|\/sh$|bash|osascript/.test(c)) && !log.some(([, a]) => a.includes('-c')), 'mac: no sudo, no shell, no osascript');
  const order = names.map((c) => c.split('/').pop());
  ok(order[0] === 'hdiutil' && order.indexOf('codesign') < order.indexOf('ditto') && order.indexOf('spctl') < order.indexOf('ditto'), 'mac: the signature is checked before anything is copied');
  ok(order.indexOf('ditto') < order.indexOf('open') && order.lastIndexOf('hdiutil') > order.indexOf('ditto') && order.lastIndexOf('hdiutil') < order.indexOf('open'), 'mac: copy, then the image is closed, then Docker is opened');
  const at = log.find(([c, a]) => c === MAC_BIN.hdiutil && a[0] === 'attach')![1];
  ok(at.includes('-readonly') && at.includes('-nobrowse') && at.includes('-noautoopen') && !at.includes('-noverify'), 'mac: the image is opened read-only, hidden, without skipping verification', at);
  const sp = log.find(([c]) => c === MAC_BIN.spctl)![1];
  ok(sp.join(' ').startsWith('--assess --type execute'), 'mac: Gatekeeper assessment is requested', sp);
  const op = log.find(([c]) => c === MAC_BIN.open)!;
  ok(op[1].length === 1 && op[1][0] === join(apps, 'Docker.app'), 'mac: open is given only the placed Docker.app path', op);
  ok(r.text.includes('パスワード') && r.text.includes('Docker Desktop を起動しました') && r.text.includes('まだ動いていません'), 'mac: tells about the first-run dialogs and the daemon not running yet', r.text);
  ok(!r.text.includes('usermod') && !r.text.includes('docker グループ'), 'mac: does not mention the docker group (not used on Mac)');
  // 手順 1 の説明に、することの全部が出る
  const c0 = collect();
  const again = macSteps(join(tmp, 'apps1b'), {});
  mkdirSync(join(tmp, 'apps1b'));
  await again[0].run?.(c0.out, ctl);
  ok(c0.text().includes('sudo・パスワード') && c0.text().includes(DOCKER_DESKTOP_TEAM_ID) && c0.text().includes('Apple の公証') && c0.text().includes('desktop.docker.com'), 'mac: check lists what will happen, and says no administrator rights are used');
}
{
  // Intel
  const apps = join(tmp, 'apps2'); mkdirSync(apps);
  const seen: string[] = [];
  const r = await runAll(macSteps(apps, { arch: 'x64', seen }));
  ok(r.codes.join(',') === '0,0,0,0,0' && seen[0] === 'https://desktop.docker.com/mac/main/amd64/Docker.dmg', 'mac: Intel uses the amd64 dmg', seen);
}
{
  // すでに docker が使える: 何もしない
  const apps = join(tmp, 'apps3'); mkdirSync(apps);
  const log: Call[] = []; const seen: string[] = [];
  const r = await runAll(macSteps(apps, { log, seen, hooks: { dockerVersion: async () => 'Docker version 27.0.0' } }));
  ok(r.codes.join(',') === '0,0,0,0,0' && log.length === 0 && seen.length === 0 && r.text.includes('もう入っています'), 'mac: docker already works -> nothing is downloaded, run or opened', { log, seen });
  ok(readdirSync(apps).length === 0, 'mac: docker already works -> nothing is placed');
}
{
  // Docker.app はあるが docker コマンドは無い: 上書きせず、起動だけ
  const apps = join(tmp, 'apps4'); mkdirSync(join(apps, 'Docker.app'), { recursive: true });
  const log: Call[] = []; const seen: string[] = [];
  const r = await runAll(macSteps(apps, { log, seen, hooks: { appPaths: () => [join(apps, 'Docker.app')] } }));
  ok(r.codes.join(',') === '0,0,0,0,0' && seen.length === 0, 'mac: existing Docker.app -> nothing downloaded', { seen, codes: r.codes });
  ok(log.length === 1 && log[0][0] === MAC_BIN.open && log[0][1][0] === join(apps, 'Docker.app'), 'mac: existing Docker.app -> only opened, never copied or replaced', log);
}
for (const [what, over, text] of [
  ['codesign --verify fails', { 'codesign:verify': { code: 1, text: 'a sealed resource is missing or invalid' } }, '署名の検証に失敗'],
  ['wrong team id', { 'codesign:info': { code: 0, text: 'Identifier=com.docker.docker\nTeamIdentifier=ABCDE12345\n' } }, '一致しません'],
  ['wrong bundle id', { 'codesign:info': { code: 0, text: `Identifier=com.evil.app\nTeamIdentifier=${DOCKER_DESKTOP_TEAM_ID}\n` } }, '一致しません'],
  ['no team id', { 'codesign:info': { code: 0, text: 'Identifier=com.docker.docker\nTeamIdentifier=not set\n' } }, '一致しません'],
  ['codesign -dv fails', { 'codesign:info': { code: 1, text: 'code object is not signed at all' } }, '一致しません'],
  ['gatekeeper rejects', { spctl: { code: 3, text: 'rejected' } }, 'Gatekeeper'],
] as const) {
  const apps = join(tmp, `apps-bad-${what.replace(/\W+/g, '')}`); mkdirSync(apps);
  const log: Call[] = [];
  const r = await runAll(macSteps(apps, { log, over: over as Record<string, RunResult> }));
  ok(r.codes.length === 3 && r.codes[2] === 1 && r.text.includes(text), `mac refuses: ${what}`, r.text);
  ok(!log.some(([c]) => c === MAC_BIN.ditto || c === MAC_BIN.open), `mac refuses: ${what} -> nothing is copied or opened`);
  ok(readdirSync(apps).length === 0, `mac refuses: ${what} -> nothing is placed`, readdirSync(apps));
  ok(log.some(([c, a]) => c === MAC_BIN.hdiutil && a[0] === 'detach'), `mac refuses: ${what} -> the image is closed again`);
  ok(tmpLeft().length === 0, `mac refuses: ${what} -> the temporary folder is removed`, tmpLeft());
}
{
  // コピーの確認で壊れていた: 名前を付け替えない・残さない
  const apps = join(tmp, 'apps5'); mkdirSync(apps);
  const r = await runAll(macSteps(apps, { over: { 'codesign:verify#2': { code: 1, text: 'broken copy' } } }));
  ok(r.codes[2] === 1 && readdirSync(apps).length === 0 && tmpLeft().length === 0, 'mac: a copy that fails verification is removed and never renamed to Docker.app', readdirSync(apps));
}
{
  // ditto が失敗した
  const apps = join(tmp, 'apps6'); mkdirSync(apps);
  const r = await runAll(macSteps(apps, { over: { ditto: { code: 1, text: 'No space left on device' } } }));
  ok(r.codes[2] === 1 && r.text.includes('コピーできませんでした') && readdirSync(apps).length === 0, 'mac: copy failure leaves nothing behind', r.text);
}
{
  // ディスクイメージを開けない
  const apps = join(tmp, 'apps7'); mkdirSync(apps);
  const log: Call[] = [];
  const r = await runAll(macSteps(apps, { log, over: { 'hdiutil:attach': { code: 1, text: 'hdiutil: attach failed' } } }));
  ok(r.codes[2] === 1 && r.text.includes('開けませんでした') && !log.some(([c, a]) => c === MAC_BIN.hdiutil && a[0] === 'detach') && tmpLeft().length === 0, 'mac: image cannot be opened -> stops, no detach needed, temp removed', r.text);
}
{
  // 閉じられない: 開いたままのものは消さない（読み取り専用の中身にも触らない）
  const apps = join(tmp, 'apps8'); mkdirSync(apps);
  const r = await runAll(macSteps(apps, { over: { 'hdiutil:detach': { code: 16, text: 'busy' }, 'codesign:info': { code: 0, text: 'Identifier=x\nTeamIdentifier=Y\n' } } }));
  ok(r.codes[2] === 1 && r.text.includes('閉じられませんでした') && tmpLeft().length === 1, 'mac: if the image cannot be closed, the temp folder is left alone and the user is told', { t: r.text, left: tmpLeft() });
  sweepTmp(mws);
  rmSync(join(mws, 'tools'), { recursive: true, force: true });
}
{
  // ダウンロード: 別ホストへのリダイレクトは断る。404 も止まる。停止も止まる
  const apps = join(tmp, 'apps9'); mkdirSync(apps);
  const log: Call[] = []; const seen: string[] = [];
  const redirect = await runAll(macSteps(apps, { log, seen, fetchOver: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/Docker.dmg' } }) }));
  ok(redirect.codes[1] === 1 && redirect.text.includes('許可していない取得先') && !seen.some((u) => u.includes('evil')) && log.length === 0 && tmpLeft().length === 0, 'mac: a redirect to another host is refused, nothing is run, temp removed', redirect.text);
  const nf = await runAll(macSteps(apps, { log, fetchOver: () => new Response('nf', { status: 404 }) }));
  ok(nf.codes[1] === 1 && log.length === 0 && tmpLeft().length === 0, 'mac: HTTP 404 stops the install');
  const stopSteps = macSteps(apps, { log });
  await stopSteps[0].run?.(() => undefined, ctl);
  const stopped = await stopSteps[1].run?.(() => undefined, { stopped: () => true });
  ok(stopped === 1 && tmpLeft().length === 0 && log.length === 0, 'mac: stopping during the download stops and cleans up');
}
for (const [what, o, text] of [
  ['odd CPU', { arch: 'ia32' }, 'CPU'], ['root', { hooks: { uid: () => 0 } }, 'root'],
  ['no place to put it', { hooks: { applicationsDir: () => { throw new Error('read-only'); } } }, '置く場所'],
] as const) {
  const steps = macSteps(join(tmp, 'apps10'), o as never);
  const c = collect();
  ok((await steps[0].run?.(c.out, ctl)) === 1 && c.text().includes(text), `mac check stops: ${what}`, c.text());
  ok((await steps[1].run?.(() => undefined, ctl)) === 1 && (await steps[2].run?.(() => undefined, ctl)) === 1, `mac check stops: ${what} -> download and install never start`);
}
{
  // 確認: Docker Desktop の初回の起動が終わるまで、docker コマンドが見えなくても、失敗にしない
  const apps = join(tmp, 'apps11'); mkdirSync(apps);
  const steps = macSteps(apps, { hooks: { dockerVersion: async () => null } });
  const r = await runAll(steps);
  ok(r.codes.join(',') === '0,0,0,0,0' && r.text.includes('初回の起動'), 'mac: docker command not visible yet is explained, not a failure', r.text);
}
{
  // downloadToFile: 上限・ハッシュ・書きかけの掃除
  const f = join(tmp, 'dl.bin');
  const ctx = { ws, out: () => undefined, stopped: () => false, fetchImpl: (async () => new Response('hello', { headers: { 'content-length': '5' } })) as typeof fetch, allowedHosts: ['desktop.docker.com'] as readonly string[] };
  const r = await downloadToFile('https://desktop.docker.com/x', f, ctx, 100);
  ok(r.bytes === 5 && r.sha256 === '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' && readFileSync(f, 'utf8') === 'hello', 'downloadToFile: writes the file and returns its size and SHA-256');
  const g = join(tmp, 'dl-big.bin');
  let threw = false;
  try { await downloadToFile('https://desktop.docker.com/x', g, { ...ctx, fetchImpl: (async () => new Response('x'.repeat(50))) as typeof fetch }, 10); } catch { threw = true; }
  ok(threw && !existsSync(g), 'downloadToFile: over the limit -> error and no partial file');
  const h2 = join(tmp, 'dl-host.bin');
  let threw2 = false;
  try { await downloadToFile('https://evil.example/x', h2, ctx, 100); } catch { threw2 = true; }
  ok(threw2 && !existsSync(h2), 'downloadToFile: host not on the list -> error and no file');
  let threw3 = false;
  try { await downloadToFile('https://desktop.docker.com/x', f, ctx, 100); } catch { threw3 = true; }
  ok(threw3, 'downloadToFile: never overwrites an existing file');
}

// ---- 6c. Windows（Docker Desktop。エージェントは昇格しない。UAC は、ご自身が押す）
ok(dockerDesktopWinUrl('x64') === 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe', 'win url: x64 -> amd64');
ok(dockerDesktopWinUrl('arm64') === 'https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe', 'win url: arm64 -> arm64');
ok(dockerDesktopWinUrl('ia32') === null && dockerDesktopWinUrl('') === null, 'win url: other CPUs -> null');
ok(hostAllowed(dockerDesktopWinUrl('x64') as string, DOCKER_DESKTOP_HOSTS) && !hostAllowed('https://example.com/Docker%20Desktop%20Installer.exe', DOCKER_DESKTOP_HOSTS), 'win download host list is only desktop.docker.com');
ok(DOCKER_DESKTOP_WIN_ARGS.join(' ') === 'install --quiet', 'win: the installer gets only "install --quiet"');
ok(DOCKER_DESKTOP_WIN_SIGNERS.includes('Docker Inc'), 'win pins the publisher name');
ok(/^C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/.test(winPowerShell({})) && winPowerShell({ SystemRoot: 'D:\\WIN' }) === 'D:\\WIN\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win: PowerShell is an absolute System32 path');
ok(Buffer.from(psEncode(WIN_INSTALL_SCRIPT), 'base64').toString('utf16le') === WIN_INSTALL_SCRIPT && winPowerShellArgs('x').includes('-EncodedCommand') && winPowerShellArgs('x').includes('-NonInteractive') && winPowerShellArgs('x').includes('-NoProfile'), 'win: scripts are passed as -EncodedCommand, non-interactive, no profile');
for (const [name, sc] of [['verify', WIN_VERIFY_SCRIPT], ['install', WIN_INSTALL_SCRIPT]] as const) {
  ok(sc.includes('$env:IROME_FILE') && !/Invoke-Expression|\biex\b|DownloadString|-Command|\bcmd\b/i.test(sc), `win ${name} script: the file path comes from the environment; no eval / download / cmd`);
}
ok(WIN_INSTALL_SCRIPT.includes("-ArgumentList 'install','--quiet'") && WIN_INSTALL_SCRIPT.includes('-Verb RunAs') && !WIN_INSTALL_SCRIPT.includes('--accept-license'), 'win install script: fixed arguments, elevation only through the Windows UAC prompt');
{
  const a = parseAuthenticodeInfo('STATUS=Valid\r\nSIGNER=Docker Inc\r\nTHUMBPRINT=AB12\r\n');
  ok(a.status === 'Valid' && a.signer === 'Docker Inc' && a.thumbprint === 'AB12', 'authenticode info: reads status, signer, thumbprint (CRLF ok)');
  ok(parseAuthenticodeInfo('STATUS=Valid\nSTATUS=Valid\nSIGNER=Docker Inc\n').status === null, 'authenticode info: a repeated STATUS line -> null');
  ok(parseAuthenticodeInfo('STATUS=NotSigned\nSIGNER=\nTHUMBPRINT=\n').signer === null, 'authenticode info: empty signer -> null');
  ok(parseAuthenticodeInfo('').status === null, 'authenticode info: empty -> null');
}
{
  const pf = join(tmp, 'pf');
  const bin = join(pf, 'Docker', 'Docker', 'resources', 'bin');
  mkdirSync(bin, { recursive: true });
  ok(dockerDesktopBinDirs('win32', join(tmp, 'h'), { ProgramFiles: pf }).includes(bin), 'win PATH: Program Files Docker resources\\bin is found');
  ok(dockerDesktopBinDirs('darwin', join(tmp, 'h'), { ProgramFiles: pf }).length === 0 && dockerDesktopBinDirs('linux', join(tmp, 'h'), { ProgramFiles: pf }).length === 0, 'win PATH: nothing added on Mac / Linux');
}

const wws = join(tmp, 'wws');
mkdirSync(wws, { recursive: true });
const wTmpLeft = () => (existsSync(join(wws, 'tools')) ? readdirSync(join(wws, 'tools')).filter((n) => n.startsWith('.docker-tmp-')) : []);
const winFetch = (seen: string[]): typeof fetch => (async (input: RequestInfo | URL) => {
  const url = String(input);
  seen.push(url);
  return /^https:\/\/desktop\.docker\.com\/win\/main\/(arm64|amd64)\/Docker%20Desktop%20Installer\.exe$/.test(url) ? new Response('FAKE-EXE-BYTES', { headers: { 'content-length': '14' } }) : new Response('nf', { status: 404 });
}) as typeof fetch;
type WinCall = { cmd: string; script: string; env: Record<string, string> | undefined };
const psScript = (args: string[]) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
const winRun = (log: WinCall[], o: { sig?: string; sigCode?: number; install?: RunResult; tamper?: boolean } = {}) => async (cmd: string, args: string[], _t?: number, env?: Record<string, string>): Promise<RunResult> => {
  const script = psScript(args);
  log.push({ cmd, script, env });
  if (script === WIN_VERIFY_SCRIPT) {
    if (o.tamper && env?.IROME_FILE) writeFileSync(env.IROME_FILE, 'SWAPPED-AFTER-CHECK');
    return { code: o.sigCode ?? 0, text: o.sig ?? 'STATUS=Valid\nSIGNER=Docker Inc\nTHUMBPRINT=0123456789ABCDEF' };
  }
  if (script === WIN_INSTALL_SCRIPT) return o.install ?? { code: 0, text: '' };
  return { code: 99, text: 'unexpected script' };
};
const winSteps = (o: { arch?: string; log?: WinCall[]; seen?: string[]; run?: ReturnType<typeof winRun>; hooks?: Record<string, unknown>; fetchOver?: typeof fetch } = {}) => {
  const log = o.log ?? [];
  let n = 0;
  return installSteps('docker', wws, {
    platform: 'win32',
    fetch: o.fetchOver ?? winFetch(o.seen ?? []),
    docker: {
      arch: () => o.arch ?? 'x64', appPaths: () => [], run: o.run ?? winRun(log),
      // docker は、最初（確認のとき）は無く、入れたあと（最後の確認のとき）には、ある
      dockerVersion: async () => (n++ === 0 ? null : 'Docker version 27.0.0'), dockerInfo: async () => null,
      ...o.hooks,
    } as never,
  });
};

{
  // 正常
  const log: WinCall[] = []; const seen: string[] = [];
  const steps = winSteps({ log, seen });
  ok(steps.length === 5 && steps.every((st) => st.cmd === '' && st.pty !== true && st.prepare === undefined), 'win: five steps, none starts a program directly, none uses a terminal or sudo');
  const r = await runAll(steps);
  ok(r.codes.join(',') === '0,0,0,0,0', 'win: all five steps succeed', r);
  ok(seen.length === 1 && seen[0] === 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe', 'win: only the amd64 installer URL was contacted', seen);
  ok(log.length === 2 && log.every((c) => c.cmd === winPowerShell()), 'win: only PowerShell (absolute path) is run, exactly twice (verify, install)', log.map((l) => l.cmd));
  ok(log[0].script === WIN_VERIFY_SCRIPT && log[1].script === WIN_INSTALL_SCRIPT, 'win: the signature is checked before the installer is started');
  const f = log[1].env?.IROME_FILE ?? '';
  ok(f === log[0].env?.IROME_FILE && f.includes('.docker-tmp-') && f.endsWith('DockerDesktopInstaller.exe'), 'win: the same file under the tools/ temporary folder is verified and started', f);
  ok(wTmpLeft().length === 0, 'win: the temporary download folder is removed', wTmpLeft());
  ok(r.text.includes('UAC') && r.text.includes('署名を確かめました') && r.text.includes('Docker Inc') && r.text.includes('まだ動いていません'), 'win: tells about UAC, the signature, and the daemon not running yet', r.text);
  ok(!r.text.includes('usermod') && !r.text.includes('docker グループ') && !r.text.includes('sudo で'), 'win: no sudo, no docker group');
  const c0 = collect();
  await winSteps()[0].run?.(c0.out, ctl);
  ok(c0.text().includes('昇格しません') && c0.text().includes('UAC') && c0.text().includes('install --quiet') && c0.text().includes('desktop.docker.com') && c0.text().includes('Authenticode'), 'win: check lists everything that will happen and says the agent does not elevate', c0.text());
}
{
  const seen: string[] = [];
  const r = await runAll(winSteps({ arch: 'arm64', seen }));
  ok(r.codes.join(',') === '0,0,0,0,0' && seen[0] === 'https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe', 'win: ARM64 uses the arm64 installer', seen);
}
{
  // すでに docker が使える・Docker Desktop が入っている: 何もしない
  const log: WinCall[] = []; const seen: string[] = [];
  const r1 = await runAll(winSteps({ log, seen, hooks: { dockerVersion: async () => 'Docker version 27.0.0' } }));
  ok(r1.codes.join(',') === '0,0,0,0,0' && log.length === 0 && seen.length === 0 && r1.text.includes('もう入っています'), 'win: docker already works -> nothing is downloaded or run', { log, seen });
  const r2 = await runAll(winSteps({ log, seen, hooks: { dockerVersion: async () => null, appPaths: () => ['C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'] } }));
  ok(r2.codes.join(',') === '0,0,0,0,0' && log.length === 0 && seen.length === 0 && r2.text.includes('入れ直さず'), 'win: Docker Desktop already installed -> not reinstalled', { log, seen });
}
{
  // 署名が合わない: UAC の前に止まり、インストーラーは起動しない。一時フォルダは消える
  const bad: Array<[string, { sig?: string; sigCode?: number }, string]> = [
    ['not signed', { sig: 'STATUS=NotSigned\nSIGNER=\nTHUMBPRINT=' }, '有効ではありません'],
    ['hash mismatch', { sig: 'STATUS=HashMismatch\nSIGNER=Docker Inc\nTHUMBPRINT=AA' }, '有効ではありません'],
    ['not trusted', { sig: 'STATUS=NotTrusted\nSIGNER=Docker Inc\nTHUMBPRINT=AA' }, '有効ではありません'],
    ['other publisher', { sig: 'STATUS=Valid\nSIGNER=Evil Corp\nTHUMBPRINT=AA' }, '一致しません'],
    ['lookalike publisher', { sig: 'STATUS=Valid\nSIGNER=Docker Inc Ltd\nTHUMBPRINT=AA' }, '一致しません'],
    ['duplicated status', { sig: 'STATUS=Valid\nSTATUS=Valid\nSIGNER=Docker Inc\nTHUMBPRINT=AA' }, '確かめられませんでした'],
    ['powershell failed', { sigCode: 1, sig: 'boom' }, '確かめられませんでした'],
  ];
  for (const [what, o, text] of bad) {
    const log: WinCall[] = [];
    const r = await runAll(winSteps({ log, run: winRun(log, o) }));
    ok(r.codes.join(',') === '0,0,1' && r.text.includes(text), `win: ${what} -> stops at the signature step`, r);
    ok(log.length === 1 && log[0].script === WIN_VERIFY_SCRIPT, `win: ${what} -> the installer is never started`, log.map((l) => l.script.slice(0, 30)));
    ok(wTmpLeft().length === 0, `win: ${what} -> temporary folder removed`, wTmpLeft());
  }
}
{
  // 確認のあとで、ファイルが差し替わった: 起動しない
  const log: WinCall[] = [];
  const r = await runAll(winSteps({ log, run: winRun(log, { tamper: true }) }));
  ok(r.codes.join(',') === '0,0,0,1' && r.text.includes('書き換わりました'), 'win: a file swapped after the signature check is refused', r);
  ok(log.length === 1 && wTmpLeft().length === 0, 'win: swapped file -> the installer is never started, folder removed', log.length);
}
{
  // UAC で「いいえ」
  const log: WinCall[] = [];
  const r = await runAll(winSteps({ log, run: winRun(log, { install: { code: 1223, text: 'IROME_UAC_CANCELED' } }) }));
  ok(r.codes.join(',') === '0,0,0,1' && r.text.includes('何も入れていません'), 'win: pressing No in UAC -> nothing installed, clear message', r);
  ok(wTmpLeft().length === 0, 'win: UAC declined -> temporary folder removed');
}
{
  // 起動できない・インストーラーの失敗・再起動が必要
  const a = await runAll(winSteps({ run: winRun([], { install: { code: 1, text: 'IROME_START_FAILED=disk' } }) }));
  ok(a.codes.join(',') === '0,0,0,1' && a.text.includes('起動できませんでした'), 'win: start failure is reported', a);
  const b = await runAll(winSteps({ run: winRun([], { install: { code: 5, text: '' } }) }));
  ok(b.codes.join(',') === '0,0,0,1' && b.text.includes('終了コード 5'), 'win: installer failure is reported with its exit code', b);
  const c = await runAll(winSteps({ run: winRun([], { install: { code: 3010, text: '' } }) }));
  ok(c.codes.join(',') === '0,0,0,0,0' && c.text.includes('再起動'), 'win: exit 3010 -> installed, asks for a restart', c);
  ok(wTmpLeft().length === 0, 'win: temporary folder removed in all cases');
}
{
  // 取得の失敗・CPU・停止
  const r1 = await runAll(winSteps({ fetchOver: (async () => new Response('nf', { status: 404 })) as typeof fetch }));
  ok(r1.codes.join(',') === '0,1' && wTmpLeft().length === 0, 'win: download failure stops and leaves no folder', r1);
  const r2 = await runAll(winSteps({ arch: 'ia32' }));
  ok(r2.codes.join(',') === '1' && r2.text.includes('CPU'), 'win: unsupported CPU stops at the check', r2);
  const log: WinCall[] = [];
  const steps = winSteps({ log });
  const c = collect();
  await steps[0].run?.(c.out, ctl); await steps[1].run?.(c.out, ctl);
  ok((await steps[2].run?.(c.out, { stopped: () => true })) === 130 && log.length === 0 && wTmpLeft().length === 0, 'win: stop requested before the signature check -> 130, nothing run, folder removed');
}
{
  // Linux・Mac の手順は、変わらない
  const steps = stepsOf('linux', hooks());
  ok(steps.length === 4 && steps[2].pty === true, 'linux steps are unchanged');
  const other = stepsOf('freebsd' as NodeJS.Platform, hooks());
  const c = collect();
  ok(other.length === 4 && (await other[0].run?.(c.out, ctl)) === 1 && c.text().includes('freebsd'), 'other OS is still guidance only');
}

// ---- 7. sudo の中のスクリプトを、本物の sh で動かす（apt-get・usermod・systemctl・id は偽物。gpg・install・awk・grep は本物）
{
  const gpgOk = spawnSync('gpg', ['--version']).status === 0;
  ok(gpgOk, 'gpg is available for the script test (install gnupg to run this part)');
  if (gpgOk) {
    const gh = join(tmp, 'gh');
    mkdirSync(gh, { mode: 0o700 });
    const genKey = (name: string): { fpr: string; armor: string } => {
      const env = { ...process.env, GNUPGHOME: gh };
      const quiet = { env, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
      execFileSync('gpg', ['--batch', '--passphrase', '', '--quick-generate-key', `${name} <${name}@example.com>`, 'ed25519', 'sign', 'never'], quiet);
      const colons = execFileSync('gpg', ['--batch', '--with-colons', '--fingerprint', `${name}@example.com`], quiet);
      const fpr = /^fpr:+([0-9A-F]{40}):/m.exec(colons)![1];
      return { fpr, armor: execFileSync('gpg', ['--batch', '--armor', '--export', fpr], quiet).trim() };
    };
    const k1 = genKey('one');
    const k2 = genKey('two');
    const stub = join(tmp, 'stub');
    mkdirSync(stub);
    for (const name of ['apt-get', 'usermod', 'systemctl']) writeFileSync(join(stub, name), `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n`, { mode: 0o755 });
    writeFileSync(join(stub, 'id'), '#!/bin/sh\necho "id $*" >> "$STUB_LOG"\nexit 0\n', { mode: 0o755 });
    for (const name of ['apt-get', 'usermod', 'systemctl', 'id']) chmodSync(join(stub, name), 0o755);

    /** 試験用に、PATH・置き場所・指紋だけを差し替えたスクリプト（それ以外は、本物のまま）。 */
    const runScript = (fpr: string, argv: string[]) => {
      const dir = mkdtempSync(join(tmp, 'run-'));
      const log = join(dir, 'log');
      writeFileSync(log, '');
      const keyrings = join(dir, 'keyrings');
      const sources = join(dir, 'docker.sources');
      const script = SUDO_SCRIPT
        .replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin', `PATH=${stub}:/usr/bin:/bin`)
        .split('/etc/apt/keyrings').join(keyrings)
        .replace('/etc/apt/sources.list.d/docker.sources', sources)
        .replace(DOCKER_KEY_FINGERPRINT, fpr);
      ok(script !== SUDO_SCRIPT && script.includes(keyrings) && script.includes(sources), 'test harness really rewrote the paths');
      const r = spawnSync('/bin/sh', ['-c', script, 'irome-docker-install', ...argv], { encoding: 'utf8', env: { ...process.env, STUB_LOG: log, PATH: '/usr/bin:/bin' } });
      return { r, log: readFileSync(log, 'utf8'), keyrings, sources, dir };
    };

    // 指紋が合う・鍵が 1 つ → 最後まで進む
    {
      const x = runScript(k1.fpr, ['ubuntu', 'jammy', 'amd64', 'alice', k1.armor]);
      ok(x.r.status === 0, 'script: succeeds with a matching fingerprint', x.r.stderr);
      ok(existsSync(join(x.keyrings, 'docker.asc')) && readFileSync(join(x.keyrings, 'docker.asc'), 'utf8').trim() === k1.armor, 'script: key placed after the check');
      ok(readFileSync(x.sources, 'utf8') === 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: jammy\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n'.replace('/etc/apt/keyrings', x.keyrings), 'script: repository file content', readFileSync(x.sources, 'utf8'));
      const calls = x.log.trim().split('\n');
      ok(calls.join('|') === ['id -u alice', 'apt-get update', 'apt-get install -y --no-install-recommends ca-certificates gnupg', 'apt-get update', `apt-get install -y ${DOCKER_PACKAGES.join(' ')}`, 'usermod -aG docker alice'].join('|')
        || calls.join('|') === ['id -u alice', 'apt-get update', 'apt-get install -y --no-install-recommends ca-certificates gnupg', 'apt-get update', `apt-get install -y ${DOCKER_PACKAGES.join(' ')}`, 'systemctl enable --now docker', 'usermod -aG docker alice'].join('|'),
      'script: the only privileged programs called, in order', calls);
      ok(!x.log.includes('docker run') && !x.log.includes('remove') && !x.log.includes('purge'), 'script: removes nothing');
    }
    // 指紋が合わない（本物の指紋のまま、試験用の鍵を渡す）→ 何も足さずに止まる
    {
      const x = runScript(DOCKER_KEY_FINGERPRINT, ['ubuntu', 'jammy', 'amd64', 'alice', k1.armor]);
      ok(x.r.status === 3 && x.r.stderr.includes('一致しません'), 'script: stops (3) on a fingerprint mismatch', { s: x.r.status, e: x.r.stderr });
      ok(!existsSync(join(x.keyrings, 'docker.asc')) && !existsSync(x.sources), 'script: mismatch -> no key, no repository file');
      ok(!x.log.includes('usermod') && !x.log.includes('docker-ce'), 'script: mismatch -> no Docker packages, no group change', x.log);
    }
    // 鍵が 2 つ（片方は正しい指紋）→ 止まる（余計な鍵を、apt に信用させない）
    {
      const x = runScript(k1.fpr, ['ubuntu', 'jammy', 'amd64', 'alice', `${k1.armor}\n${k2.armor}`]);
      ok(x.r.status === 3, 'script: stops (3) when the file holds a second key', x.r.stderr);
      ok(!existsSync(join(x.keyrings, 'docker.asc')) && !x.log.includes('usermod') && !x.log.includes('docker-ce'), 'script: two keys -> nothing added');
    }
    // 鍵でないもの → 止まる
    {
      const x = runScript(k1.fpr, ['ubuntu', 'jammy', 'amd64', 'alice', 'not a key']);
      ok(x.r.status !== 0 && !existsSync(join(x.keyrings, 'docker.asc')) && !x.log.includes('usermod'), 'script: garbage instead of a key -> nothing added');
    }
    // 不正な値 → 何も呼ばずに止まる（2）
    for (const [what, argv] of [
      ['base', ['fedora', 'jammy', 'amd64', 'alice']], ['base with shell chars', ['ubuntu;id', 'jammy', 'amd64', 'alice']], ['codename', ['ubuntu', 'jammy;id', 'amd64', 'alice']], ['empty codename', ['ubuntu', '', 'amd64', 'alice']],
      ['codename with space', ['ubuntu', 'jammy x', 'amd64', 'alice']], ['arch', ['ubuntu', 'jammy', 'riscv64', 'alice']], ['root user', ['ubuntu', 'jammy', 'amd64', 'root']],
      ['user with option', ['ubuntu', 'jammy', 'amd64', '-R']], ['user with space', ['ubuntu', 'jammy', 'amd64', 'a b']], ['user with substitution', ['ubuntu', 'jammy', 'amd64', '$(id)']], ['empty user', ['ubuntu', 'jammy', 'amd64', '']],
    ] as const) {
      const x = runScript(k1.fpr, [...argv, k1.armor]);
      ok(x.r.status === 2 && x.log === '', `script: refuses before touching anything: ${what}`, { s: x.r.status, log: x.log, e: x.r.stderr });
    }
    // 位置引数が足りない → 止まる
    {
      const x = runScript(k1.fpr, ['ubuntu', 'jammy', 'amd64', 'alice']);
      ok(x.r.status !== 0 && x.log === '', 'script: missing key argument -> stops');
    }
    // 位置引数の中の $ や ` は、評価されない（鍵の本文に仕込まれても）
    {
      const canary = join(tmp, 'canary');
      const x = runScript(k1.fpr, ['ubuntu', 'jammy', 'amd64', 'alice', `${k1.armor.replace(/\n=/, `\n$(touch ${canary})\`touch ${canary}\`\n=`)}`]);
      ok(!existsSync(canary), 'script: shell syntax inside the key text is never evaluated', x.r.stderr);
    }
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(`${checks} checks, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
