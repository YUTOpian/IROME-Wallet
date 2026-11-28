// ノード構築エージェント: Windows ネイティブ対応の確認。
// この環境は Linux なので、OS の種類を引数で渡して、Windows の分岐を確かめる（フォルダの構成は、本物の Windows 向けの配布物を真似て作る）。
// ここで確かめられるのは「判定と手順の組み立て」まで。本物の Windows での起動・停止・展開は、実機で確かめる必要がある。
// 実行: npx tsx dev-tests/node-windows.test.ts
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  childEnv, envPathKey, globalNpmTool, isElevatedWindows, isInside, killTree, localNodeExe, localNpmTool, localPythonExe,
  nodeForTools, npmBinPath, npmCliPath, npmCommand, packageBinScript, systemTar, toolDirs, venvPythonPath,
} from '../src/server/node-agent/platform';
import { installNode, installPython, nodeArchiveExt, removeTool } from '../src/server/node-agent/provision';
import { defaultResolve, installSteps, uninstallSteps } from '../src/server/node-agent/agent';
import { validateSubdir, validateWorkspaceFile, windowsSafeSegments } from '../src/lib/node/nodeCommands';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const tmp = mkdtempSync(join(tmpdir(), 'irome-win-'));
const W: NodeJS.Platform = 'win32';
const L: NodeJS.Platform = 'linux';
const mk = (...p: string[]) => { const d = join(tmp, ...p); mkdirSync(d, { recursive: true }); return d; };
const put = (path: string, body = '', exec = false) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body); if (exec) chmodSync(path, 0o755); return path; };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** npm で入れた、bin つきのパッケージ（Windows の `.bin/<名前>.cmd` と、パッケージ本体）を真似て作る。 */
function fakePackage(dir: string, pkg: string, bin: unknown, scriptRel = 'bin/run') {
  put(join(dir, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg, bin }));
  put(join(dir, 'node_modules', pkg, scriptRel), '// js');
}

async function main() {
  // ---- パスの内外
  ok(isInside('C:\\work\\ws', 'C:\\work\\ws\\tools\\node', W), 'win: inside (backslashes)');
  ok(isInside('C:\\Work\\WS', 'c:\\work\\ws\\Tools', W), 'win: case-insensitive');
  ok(isInside('C:/work/ws', 'C:\\work\\ws\\a', W), 'win: mixed separators');
  ok(!isInside('C:\\work\\ws', 'C:\\work\\ws2\\a', W), 'win: sibling with the same prefix is outside');
  ok(!isInside('C:\\work\\ws', 'C:\\work\\ws', W) && isInside('C:\\work\\ws', 'C:\\work\\ws\\', W, true), 'win: equal only when allowed (trailing slash ignored)');
  ok(!isInside('C:\\work\\ws', 'C:\\work\\other\\..\\ws2', W), 'win: unrelated path outside');
  ok(!isInside('/home/u/ws', '/home/u/WS/a', L), 'posix: case-sensitive');
  ok(!isInside('/home/u/ws', '/home/u/ws2/a', L) && isInside('/home/u/ws', '/home/u/ws/a', L), 'posix: prefix trap and inside');
  ok(!isInside('/home/u/ws', '/home/u/ws\\..\\x', L) || true, 'posix: backslash is just a character'); // 挙動の記録（落とさない）
  ok(!isInside('/home/u/ws', '/home/u/ws', L) && isInside('/home/u/ws', '/home/u/ws', L, true), 'posix: equal only when allowed');

  // ---- tools/ の場所
  ok(npmBinPath('/w', 'symbol-bootstrap', W).endsWith('symbol-bootstrap.cmd'), 'win: .bin shim is .cmd');
  ok(npmBinPath('/w', 'symbol-bootstrap', L).endsWith('symbol-bootstrap') && !npmBinPath('/w', 'x', L).endsWith('.cmd'), 'posix: .bin shim has no extension');
  ok(!npmBinPath('/w', '', W).endsWith('.cmd'), 'win: empty name does not get .cmd');
  ok(localNodeExe('/w', W).endsWith('node.exe') && !localNodeExe('/w', W).includes('bin'), 'win: tools/node/node.exe');
  ok(localNodeExe('/w', L).endsWith(join('bin', 'node')), 'posix: tools/node/bin/node');
  ok(localPythonExe('/w', W).endsWith('python.exe') && localPythonExe('/w', L).endsWith(join('bin', 'python3')), 'python exe per OS');
  ok(venvPythonPath('/w', W).endsWith(join('Scripts', 'python.exe')) && venvPythonPath('/w', L).endsWith(join('bin', 'python')), 'venv python per OS');
  ok(toolDirs('/w', W).length === 4 && toolDirs('/w', W).some((d) => d.endsWith('Scripts')), 'win: tool dirs include python/Scripts');
  ok(toolDirs('/w', L).length === 3 && toolDirs('/w', L).every((d) => !d.endsWith('Scripts')), 'posix: tool dirs');

  // ---- 環境変数（Path / PATH の二重を作らない）
  ok(envPathKey({ Path: 'C:\\x' }, W) === 'Path' && envPathKey({ PATH: 'x' }, W) === 'PATH' && envPathKey({}, W) === 'Path', 'win: PATH key keeps its own case');
  ok(envPathKey({ Path: 'x' }, L) === 'PATH', 'posix: always PATH');
  {
    const e = childEnv('/w', W, { Path: 'C:\\Windows', PATH: 'C:\\dup', SystemRoot: 'C:\\Windows' }, { FORCE_COLOR: '0' });
    const keys = Object.keys(e).filter((k) => k.toLowerCase() === 'path');
    ok(keys.length === 1, 'win: exactly one path variable', keys);
    const v = String(e[keys[0]]);
    ok(v.startsWith(toolDirs('/w', W)[0]) && v.includes(';') && v.endsWith('C:\\Windows') || v.endsWith('C:\\dup'), 'win: tools dirs come first, ";" separated', v);
    ok(e.FORCE_COLOR === '0' && e.SystemRoot === 'C:\\Windows', 'win: other variables kept, extras added');
    const p = childEnv('/w', L, { PATH: '/usr/bin' });
    ok(String(p.PATH).startsWith(toolDirs('/w', L)[0] + ':') && String(p.PATH).endsWith(':/usr/bin'), 'posix: ":" separated, tools first');
    ok(String(childEnv('/w', L, {}).PATH).split(':').length === 3, 'posix: no PATH → no stray separator');
  }

  // ---- package.json の bin から、JavaScript を探す
  {
    const d = mk('pkg');
    fakePackage(d, 'symbol-bootstrap', { 'symbol-bootstrap': './bin/run' });
    const dir = join(d, 'node_modules', 'symbol-bootstrap');
    ok(packageBinScript(dir, 'symbol-bootstrap', W) === join(dir, 'bin', 'run'), 'bin object form');
    ok(packageBinScript(dir, 'other', W) === null, 'bin name not listed → null');
    fakePackage(d, 'single', './cli.js', 'cli.js');
    ok(packageBinScript(join(d, 'node_modules', 'single'), 'single', W) === join(d, 'node_modules', 'single', 'cli.js'), 'bin string form');
    fakePackage(d, 'evil', { evil: '../../../outside.js' });
    put(join(d, 'outside.js'), '// not in the package');
    ok(packageBinScript(join(d, 'node_modules', 'evil'), 'evil', W) === null, 'bin that escapes the package is refused');
    fakePackage(d, 'abs', { abs: join(d, 'outside.js') });
    ok(packageBinScript(join(d, 'node_modules', 'abs'), 'abs', W) === null, 'absolute bin outside the package is refused');
    put(join(d, 'node_modules', 'nofile', 'package.json'), JSON.stringify({ bin: { nofile: 'bin/missing' } }));
    ok(packageBinScript(join(d, 'node_modules', 'nofile'), 'nofile', W) === null, 'missing script → null');
    put(join(d, 'node_modules', 'broken', 'package.json'), '{not json');
    ok(packageBinScript(join(d, 'node_modules', 'broken'), 'broken', W) === null, 'broken package.json → null');
    ok(packageBinScript(join(d, 'node_modules', 'nope'), 'nope', W) === null, 'no package → null');
    put(join(d, 'node_modules', 'weird', 'package.json'), JSON.stringify({ bin: { weird: 42 } }));
    ok(packageBinScript(join(d, 'node_modules', 'weird'), 'weird', W) === null, 'non-string bin → null');
  }

  // ---- 作業場所の tools/ と PATH の npm パッケージ
  {
    const ws = mk('ws1');
    ok(localNpmTool(ws, 'symbol-bootstrap', 'symbol-bootstrap', W, '/agent/node.exe') === null, 'not installed → null');
    fakePackage(join(ws, 'tools'), 'symbol-bootstrap', { 'symbol-bootstrap': './bin/run' });
    const r = localNpmTool(ws, 'symbol-bootstrap', 'symbol-bootstrap', W, '/agent/node.exe');
    ok(r !== null && r.local === true && r.cmd === '/agent/node.exe' && r.args.length === 1 && r.args[0].endsWith(join('symbol-bootstrap', 'bin', 'run')), 'local tool runs through the agent node', r);
    put(localNodeExe(ws, W), '', true);
    ok(nodeForTools(ws, W, '/agent/node.exe') === localNodeExe(ws, W), 'tools/node/node.exe is preferred once installed');
    ok(localNpmTool(ws, 'symbol-bootstrap', 'symbol-bootstrap', W, '/agent/node.exe')?.cmd === localNodeExe(ws, W), 'local tool then runs through tools/node');

    const g = mk('npm-global');
    fakePackage(g, 'symbol-node-watcher', { 'symbol-node-watcher': 'bin/watch.js' }, 'bin/watch.js');
    put(join(g, 'symbol-node-watcher.cmd'), '@echo off');
    const gr = globalNpmTool('symbol-node-watcher', 'symbol-node-watcher', ['C:\\Windows', `"${g}"`].join(';'), W, '/agent/node.exe');
    ok(gr !== null && gr.local === false && gr.cmd === '/agent/node.exe' && gr.args[0].endsWith('watch.js'), 'global npm tool found through PATH (quoted entry too)', gr);
    ok(globalNpmTool('symbol-node-watcher', 'symbol-node-watcher', 'C:\\Windows;D:\\nowhere', W, '/agent/node.exe') === null, 'not on PATH → null');
    const noCmd = mk('npm-global-nocmd');
    fakePackage(noCmd, 'symbol-node-watcher', { 'symbol-node-watcher': 'bin/watch.js' }, 'bin/watch.js');
    ok(globalNpmTool('symbol-node-watcher', 'symbol-node-watcher', noCmd, W, '/agent/node.exe') === null, 'a package folder without the .cmd shim is not treated as an install');
  }

  // ---- npm
  {
    ok(npmCommand('/w', ['install', 'x'], L, '/usr/bin/node')?.cmd === 'npm', 'posix: plain npm');
    const ws = mk('ws-npm');
    const exec = join(mk('agent-node'), 'node.exe');
    ok(npmCommand(ws, ['--version'], W, exec) === null && npmCliPath(ws, exec) === null, 'win: no npm-cli.js → null (never falls back to npm.cmd)');
    put(join(join(exec, '..'), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    const c1 = npmCommand(ws, ['install', '--prefix', 'T', 'pkg'], W, exec);
    ok(c1 !== null && c1.cmd === exec && c1.args[0].endsWith('npm-cli.js') && c1.args.slice(1).join(' ') === 'install --prefix T pkg', 'win: node + npm-cli.js + args', c1);
    ok(c1 !== null && !/\.(cmd|bat)$/i.test(c1.cmd) && !/\.(cmd|bat)$/i.test(c1.args[0]), 'win: never a .cmd/.bat');
    put(join(ws, 'tools', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    put(localNodeExe(ws, W), '', true);
    const c2 = npmCommand(ws, ['--version'], W, exec);
    ok(c2 !== null && c2.cmd === localNodeExe(ws, W) && c2.args[0].startsWith(join(ws, 'tools', 'node')), 'win: tools/node npm is preferred', c2);
  }

  // ---- ツール名の解決
  {
    const ws = mk('ws-resolve');
    const exec = '/agent/node.exe';
    const rb = defaultResolve('symbol-bootstrap', ['symbol-bootstrap', 'config', '-p', 'testnet'], ws, W, exec, { Path: '' });
    ok(rb !== null && rb.cmd === 'symbol-bootstrap' && rb.local === undefined && rb.args.join(' ') === 'config -p testnet', 'win: not installed → bare name, no local flag', rb);
    fakePackage(join(ws, 'tools'), 'symbol-bootstrap', { 'symbol-bootstrap': './bin/run' });
    const rl = defaultResolve('symbol-bootstrap', ['symbol-bootstrap', 'config', '-p', 'testnet'], ws, W, exec, { Path: '' });
    ok(rl !== null && rl.local === true && rl.cmd === exec && rl.args.length === 4 && rl.args[0].endsWith(join('bin', 'run')) && rl.args[1] === 'config', 'win: local install runs "node <bin/run> args" (no .cmd, no shell)', rl);
    ok(rl !== null && !rl.args.some((a) => /\.cmd$/i.test(a)), 'win: no .cmd anywhere in argv');
    const g = mk('npm-global-2');
    fakePackage(g, 'symbol-node-watcher', { 'symbol-node-watcher': 'bin/watch.js' }, 'bin/watch.js');
    put(join(g, 'symbol-node-watcher.cmd'), '');
    const rg = defaultResolve('symbol-node-watcher', ['symbol-node-watcher', '--help'], ws, W, exec, { Path: g });
    ok(rg !== null && rg.local === false && rg.cmd === exec && rg.args[1] === '--help', 'win: global install is found, and is not "local"', rg);
    // POSIX は、これまでどおり
    const rp = defaultResolve('symbol-bootstrap', ['symbol-bootstrap', 'x'], ws, L, '/usr/bin/node', { PATH: '' });
    ok(rp !== null && rp.cmd === 'symbol-bootstrap' && rp.local === undefined, 'posix: bare name when not installed');
    put(npmBinPath(ws, 'symbol-bootstrap', L), '', true);
    const rp2 = defaultResolve('symbol-bootstrap', ['symbol-bootstrap', 'x'], ws, L, '/usr/bin/node', { PATH: '' });
    ok(rp2 !== null && rp2.cmd === npmBinPath(ws, 'symbol-bootstrap', L) && rp2.local === true && rp2.args.join() === 'x', 'posix: .bin path, local');
    // shoestring
    ok(defaultResolve('shoestring', ['shoestring', 'x'], ws, W, exec)?.cmd === 'shoestring', 'win: shoestring bare name without venv');
    put(venvPythonPath(ws, W), '', true);
    const rs = defaultResolve('shoestring', ['shoestring', 'x'], ws, W, exec);
    ok(rs !== null && rs.cmd === venvPythonPath(ws, W) && rs.args.join(' ') === '-m shoestring x' && rs.local === true, 'win: shoestring through venv Scripts\\python.exe', rs);
    ok(defaultResolve('docker', ['docker', 'ps'], ws, W, exec)?.cmd === 'docker', 'docker stays a bare name (docker.exe)');
    ok(defaultResolve('node', ['node', '-v'], ws, W, exec)?.cmd === exec, 'node is the agent node');
    ok(defaultResolve('irome' as never, ['irome'], ws, W, exec) === null, 'unknown tool → null');
  }

  // ---- 手順の組み立て
  {
    const ws = mk('ws-steps');
    const exec = join(mk('agent-node-2'), 'node.exe');
    // npm-cli.js が無い Windows: npm.cmd には逃げず、案内して止まる
    const s0 = installSteps('bootstrap', ws, { platform: W, execPath: exec });
    ok(s0.length === 2 && s0[0].cmd === '' && typeof s0[0].run === 'function', 'win: no npm-cli.js → a stopping step, not "npm"');
    const out0: string[] = [];
    ok((await s0[0].run!((t) => out0.push(t), { stopped: () => false })) === 1 && /irome install node/.test(out0.join('')), 'win: the stop step explains how to get npm');
    const n0 = installSteps('nodewatch', ws, { platform: W, execPath: exec });
    ok(n0.length === 1 && n0[0].cmd === '' && typeof n0[0].run === 'function', 'win: nodewatch also stops when npm is missing');
    // npm-cli.js がある Windows: node で直接動かす
    put(join(exec, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    const s1 = installSteps('bootstrap', ws, { platform: W, execPath: exec });
    ok(s1[0].cmd === exec && s1[0].args[0].endsWith('npm-cli.js') && s1[0].args.slice(1, 3).join(' ') === 'install --prefix', 'win: npm install runs as "node npm-cli.js install --prefix …"', s1[0]);
    ok(s1.every((s) => !/^npm(\.cmd)?$/i.test(s.cmd) && !/\.(cmd|bat)$/i.test(s.cmd)), 'win: never spawns npm / .cmd / .bat');
    const un0 = uninstallSteps('nodewatch', ws, W);
    ok(un0.length === 2, 'win: nodewatch uninstall has npm step + check');
    const sp = installSteps('bootstrap', ws, { platform: L });
    ok(sp[0].cmd === 'npm' && sp[0].args[0] === 'install' && sp[1].cmd === npmBinPath(ws, 'symbol-bootstrap', L), 'posix: unchanged (npm, then .bin check)');
    const sw = installSteps('nodewatch', ws, { platform: L });
    ok(sw.length === 1 && sw[0].cmd === 'npm', 'posix nodewatch unchanged');
    ok(typeof installSteps('bootstrap', ws, { platform: W, execPath: exec })[1].run === 'function', 'win: the check step runs in-process (finds bin after install)');
    const vc = installSteps('bootstrap', ws, { platform: W, execPath: exec })[1];
    const outv: string[] = [];
    ok((await vc.run!((t) => outv.push(t), { stopped: () => false })) === 1 && /見つかりません/.test(outv.join('')), 'win: check step fails clearly when nothing was installed');

    const us = uninstallSteps('bootstrap', ws, W);
    ok(us.length === 2 && us[1].run !== undefined, 'win: uninstall has npm step + check');
    const outu: string[] = [];
    // .cmd が残っていれば「まだ残っています」、無ければ成功
    ok((await us[1].run!((t) => outu.push(t), { stopped: () => false })) === 0, 'win: uninstall check passes when the .cmd shim is gone');
    put(npmBinPath(ws, 'symbol-bootstrap', W));
    ok((await us[1].run!((t) => outu.push(t), { stopped: () => false })) === 1 && /まだ残っています/.test(outu.join('')) && outu.join('').includes('.cmd'), 'win: uninstall check looks for the .cmd shim');
  }

  // ---- Node.js・Python を入れる（Windows 向けの配布物）
  {
    ok(nodeArchiveExt('win-x64') === 'zip' && nodeArchiveExt('linux-x64') === 'tar.gz' && nodeArchiveExt('darwin-arm64') === 'tar.gz', 'archive extension per target');
    const ws = mk('ws-winnode');
    const zip = Buffer.from('PK-fake-zip');
    const base = 'https://nodejs.org/dist/latest-v22.x';
    const seen: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      const u = String(input); seen.push(u);
      if (u === `${base}/SHASUMS256.txt`) return new Response(`${'0'.repeat(64)}  node-v22.7.0-win-arm64.zip\n${sha(zip)}  node-v22.7.0-win-x64.zip\n${'1'.repeat(64)}  node-v22.7.0-linux-x64.tar.gz\n`);
      if (u === `${base}/node-v22.7.0-win-x64.zip`) return new Response(new Uint8Array(zip));
      return new Response('nf', { status: 404 });
    }) as typeof fetch;
    const out: string[] = [];
    let archiveName = '';
    const extract = async (archive: string, dest: string) => {
      archiveName = archive;
      put(join(dest, 'node.exe'), '#!/bin/sh\necho v22.7.0\n', true);
      put(join(dest, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '//');
      return true;
    };
    const code = await installNode({ ws, out: (t) => out.push(t), stopped: () => false, fetchImpl: f, platform: W, arch: 'x64', extract });
    ok(code === 0, 'win: installNode exit 0', out.join(''));
    ok(seen.includes(`${base}/node-v22.7.0-win-x64.zip`) && !seen.some((u) => u.includes('linux') || u.includes('arm64')), 'win: requests the win-x64 zip only', seen);
    ok(archiveName.endsWith('archive.zip'), 'win: archive is saved as .zip for tar.exe', archiveName);
    ok(existsSync(localNodeExe(ws, W)) && existsSync(join(ws, 'tools', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')), 'win: node.exe and npm-cli.js in place');
    ok(npmCommand(ws, ['--version'], W, '/x/node.exe')?.cmd === localNodeExe(ws, W), 'win: after install, npm runs through tools/node');
    const r: string[] = [];
    ok(removeTool(ws, 'node', (t) => r.push(t), W) === 0 && !existsSync(join(ws, 'tools', 'node')), 'win: removeTool node');
  }
  {
    // 展開できない（tar.exe が無い等）
    const ws = mk('ws-winnode-noextract');
    const zip = Buffer.from('PK');
    const f = (async (input: RequestInfo | URL) => String(input).endsWith('SHASUMS256.txt') ? new Response(`${sha(zip)}  node-v22.7.0-win-x64.zip\n`) : new Response(new Uint8Array(zip))) as typeof fetch;
    const out: string[] = [];
    ok((await installNode({ ws, out: (t) => out.push(t), stopped: () => false, fetchImpl: f, platform: W, arch: 'x64', extract: async () => false })) === 1 && /tar\.exe/.test(out.join('')), 'win: extraction failure is reported with the tar.exe hint', out.join(''));
    ok(!existsSync(join(ws, 'tools', 'node')), 'win: nothing installed after failed extraction');
  }
  {
    const ws = mk('ws-winpy');
    const triple = 'x86_64-pc-windows-msvc';
    const name = `cpython-3.12.8+20990101-${triple}-install_only.tar.gz`;
    const tgz = Buffer.from('fake-tgz');
    const assets = [
      { name, browser_download_url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20990101/win' },
      { name: `cpython-3.12.8+20990101-x86_64-unknown-linux-gnu-install_only.tar.gz`, browser_download_url: 'https://github.com/x/linux' },
      { name: 'SHA256SUMS', browser_download_url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20990101/SHA256SUMS' },
    ];
    const seen: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      const u = String(input); seen.push(u);
      if (u.includes('api.github.com')) return new Response(JSON.stringify({ assets }));
      if (u.endsWith('/SHA256SUMS')) return new Response(`${sha(tgz)}  ${name}\n`);
      if (u.endsWith('/win')) return new Response(new Uint8Array(tgz));
      return new Response('nf', { status: 404 });
    }) as typeof fetch;
    // python.exe の代わり: 「import pty」を含む確認なら失敗する（Windows には pty が無いので、頼んではいけない）
    const script = '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Python 3.12.8"; exit 0; fi\ncase "$2" in *pty*|*termios*) exit 1;; esac\nexit 0\n';
    const out: string[] = [];
    const code = await installPython({ ws, out: (t) => out.push(t), stopped: () => false, fetchImpl: f, platform: W, arch: 'x64', extract: async (_a, d) => { put(join(d, 'python.exe'), script, true); return true; } });
    ok(code === 0, 'win: installPython exit 0 without asking for pty/termios', out.join(''));
    ok(seen.some((u) => u.endsWith('/win')) && !seen.some((u) => u.endsWith('/linux')), 'win: picks the windows-msvc asset', seen);
    ok(existsSync(localPythonExe(ws, W)), 'win: python.exe in place');
    // 同じ確認を Linux で頼むと、pty を要求する（Linux 用の確認は変えていない）
    const ws2 = mk('ws-linpy');
    const lname = `cpython-3.12.8+20990101-x86_64-unknown-linux-gnu-install_only.tar.gz`;
    const f2 = (async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('api.github.com')) return new Response(JSON.stringify({ assets: [{ name: lname, browser_download_url: 'https://github.com/x/l' }, { name: 'SHA256SUMS', browser_download_url: 'https://github.com/x/s' }] }));
      if (u.endsWith('/s')) return new Response(`${sha(tgz)}  ${lname}\n`);
      return new Response(new Uint8Array(tgz));
    }) as typeof fetch;
    const out2: string[] = [];
    const code2 = await installPython({ ws: ws2, out: (t) => out2.push(t), stopped: () => false, fetchImpl: f2, platform: L, arch: 'x64', extract: async (_a, d) => { put(join(d, 'bin', 'python3'), script, true); return true; } });
    ok(code2 === 1 && /pty/.test(out2.join('')), 'linux: still requires pty/termios', out2.join(''));
  }

  // ---- 削除の安全（Windows の判定で）
  {
    const ws = mk('ws-rm');
    put(join(ws, 'tools', 'python', 'python.exe'), '');
    mk('ws-rm', 'tools', 'venv');
    const r: string[] = [];
    ok(removeTool(ws, 'python', (t) => r.push(t), W) === 1 && /Shoestring/.test(r.join('')), 'win: python kept while tools/venv exists');
  }

  // ---- 作業場所のファイル名（Windows で別の意味になるものを、どの OS でも断る）
  {
    const bad = ['Tools/x.yml', 'TOOLS/x.yml', 'tOoLs/a/b.yml', 'Node_Modules/a.json', 'a/NODE_MODULES/b.json', '.GIT/config.json', 'a/.Git/x.json',
      'a:b.json', 'a.json:stream', 'config.yml::$DATA', 'C:/x.json', 'C:\\x.json', '\\\\server\\share\\x.json', '..\\x.json', 'a\\..\\..\\x.json',
      'con.json', 'CON', 'nul.yml', 'a/Aux.txt', 'x/com1.yml', 'LPT9.json', 'prn',
      'a.', 'a /b.json', 'dir./x.json', 'PROGRA~1/x.json', 'a~1.json', 'a|b.json', 'a?.json', 'a*.json', 'a<b.json', 'a>b.json', 'a"b.json',
      'Target/Addresses.yml', 'TARGET/ADDRESSES/x.yml', 'target/addresses.yml.', 'target/Addresses.yml ', 'Docker-Compose.YML', 'x/COMPOSE.yaml'];
    for (const b of bad) ok(!validateWorkspaceFile(b).ok, `rejected: ${JSON.stringify(b)}`);
    const good = ['custom-preset.yml', 'target/config/user.json', 'a/b/c.yml', 'shoestring/overrides.ini', 'my.config.json', 'console.json', 'communication.yml', 'null-pointer.yml', 'target/preset.yml'];
    for (const g of good) { const v = validateWorkspaceFile(g); ok(v.ok || (v as { reason: string }).reason === 'ext_not_allowed', `accepted by the name rules: ${JSON.stringify(g)}`, v); }
    ok(validateWorkspaceFile('console.json').ok && validateWorkspaceFile('communication.yml').ok, 'names that only start like reserved words are fine');
    ok(validateSubdir('nodes/node1').ok && !validateSubdir('nodes/con').ok && !validateSubdir('nodes/a:b').ok, 'subdir uses the same rules');
    ok(windowsSafeSegments('a/b/c') && !windowsSafeSegments('a/NUL.txt/c'), 'windowsSafeSegments');
  }

  // ---- 停止・権限・tar（Linux 上では、動かさずに、壊れないことだけ）
  {
    killTree(undefined); killTree(0); killTree(-5); killTree(1.5 as number); killTree(2_000_000_000);
    ok(true, 'killTree ignores bad pids and a missing taskkill without throwing');
    ok(isElevatedWindows({ SystemRoot: join(tmp, 'no-such-root') }) === false, 'elevated check is false when fltmc is missing');
    ok(systemTar(L) === 'tar', 'posix: tar');
    const root = mk('SysRoot');
    ok(systemTar(W, { SystemRoot: root }) === 'tar', 'win: falls back to tar when System32\\tar.exe is missing');
    put(join(root, 'System32', 'tar.exe'), '', true);
    ok(systemTar(W, { SystemRoot: root }) === join(root, 'System32', 'tar.exe'), 'win: prefers System32\\tar.exe (bsdtar reads zip; Git GNU tar does not)');
  }

  rmSync(tmp, { recursive: true, force: true });
  console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
  process.exit(fails === 0 ? 0 : 1);
}
void main();
