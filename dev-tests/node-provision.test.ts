// ノード構築エージェント: Node.js・Python を tools/ に入れる／消す手順の確認。
// 外部（nodejs.org・GitHub）には繋がない。fetch を偽物に差し替え、本物の `tar` で展開する。
// 実行: npx tsx dev-tests/node-provision.test.ts
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOWNLOAD_HOSTS, download, findSum, hostAllowed, installNode, installPython, nodeTarget, pythonTriple, removeTool, sha256 } from '../src/server/node-agent/provision';
import { installSteps, uninstallSteps } from '../src/server/node-agent/agent';
import { parseCommandLine } from '../src/lib/node/nodeCommands';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const tmp = mkdtempSync(join(tmpdir(), 'irome-prov-'));
const newWs = (name: string) => { const d = join(tmp, name); mkdirSync(d, { recursive: true }); return d; };
const collect = () => { const lines: string[] = []; return { out: (t: string) => { lines.push(t); }, text: () => lines.join('') }; };

/** 中身 files（パス → 内容）の tar.gz を、トップに top/ を付けて作る（配布物と同じ形）。 */
function makeTarGz(top: string, files: Record<string, string>, exec: string[]): Buffer {
  const src = mkdtempSync(join(tmp, 'src-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(src, top, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
    if (exec.includes(rel)) chmodSync(full, 0o755);
  }
  const out = join(src, 'a.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', src, top]);
  return Buffer.from(execFileSync('cat', [out]));
}

type Route = (url: string) => { status?: number; headers?: Record<string, string>; body?: Buffer | string } | undefined;
function fakeFetch(route: Route, seen?: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen?.push(url);
    const r = route(url);
    if (!r) return new Response('not found', { status: 404 });
    const body = typeof r.body === 'string' ? Buffer.from(r.body) : r.body;
    return new Response(body ? new Uint8Array(body) : null, { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
}
const ctxOf = (ws: string, f: typeof fetch, extra: { platform?: NodeJS.Platform; arch?: string } = {}) => {
  const c = collect();
  return { c, ctx: { ws, out: c.out, stopped: () => false, fetchImpl: f, platform: extra.platform ?? ('linux' as NodeJS.Platform), arch: extra.arch ?? 'x64' } };
};

async function main() {
  // --- 取得先の決まり
  ok(hostAllowed('https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt'), 'nodejs.org allowed');
  ok(hostAllowed('https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest'), 'api.github.com allowed');
  ok(hostAllowed('https://objects.githubusercontent.com/x'), 'objects.githubusercontent.com allowed');
  for (const u of ['http://nodejs.org/x', 'https://evil.example/x', 'https://nodejs.org.evil.example/x', 'https://user:pw@nodejs.org/x', 'https://nodejs.org:8443/x', 'ftp://nodejs.org/x', 'file:///etc/passwd', 'not a url', 'https://127.0.0.1/x'])
    ok(!hostAllowed(u), `host rejected: ${u}`);
  ok(DOWNLOAD_HOSTS.length === 5, 'host list is small and fixed');

  // --- ハッシュの一覧
  {
    const h = 'a'.repeat(64), g = 'b'.repeat(64);
    const list = `${h}  node-v22.1.0-linux-x64.tar.gz\n${g} *node-v22.1.0-darwin-arm64.tar.gz\nbad line\n`;
    ok(findSum(list, 'node-v22.1.0-linux-x64.tar.gz') === h, 'findSum plain');
    ok(findSum(list, 'node-v22.1.0-darwin-arm64.tar.gz') === g, 'findSum binary-mode star');
    ok(findSum(list, 'node-v22.1.0-linux-arm64.tar.gz') === null, 'findSum missing');
    ok(findSum(`${h.slice(1)}  x`, 'x') === null, 'findSum rejects short hash');
  }
  ok(nodeTarget('linux', 'x64') === 'linux-x64' && nodeTarget('darwin', 'arm64') === 'darwin-arm64', 'nodeTarget');
  ok(nodeTarget('win32', 'x64') === 'win-x64' && nodeTarget('win32', 'arm64') === 'win-arm64', 'nodeTarget windows');
  ok(nodeTarget('linux', 'ia32') === null && nodeTarget('win32', 'ia32') === null && nodeTarget('freebsd', 'x64') === null, 'nodeTarget unsupported');
  ok(pythonTriple('linux', 'x64') === 'x86_64-unknown-linux-gnu' && pythonTriple('darwin', 'arm64') === 'aarch64-apple-darwin', 'pythonTriple');
  ok(pythonTriple('win32', 'x64') === 'x86_64-pc-windows-msvc' && pythonTriple('win32', 'arm64') === 'aarch64-pc-windows-msvc', 'pythonTriple windows');
  ok(pythonTriple('win32', 'ia32') === null && pythonTriple('freebsd', 'x64') === null, 'pythonTriple unsupported');

  // --- ダウンロード: リダイレクトの検査・サイズ上限・HTTP エラー
  {
    const ws = newWs('dl');
    const seen: string[] = [];
    const f = fakeFetch((u) => {
      if (u === 'https://github.com/a') return { status: 302, headers: { location: 'https://objects.githubusercontent.com/b' } };
      if (u === 'https://objects.githubusercontent.com/b') return { body: 'hello' };
      if (u === 'https://github.com/evil') return { status: 302, headers: { location: 'https://evil.example/x' } };
      if (u === 'https://github.com/downgrade') return { status: 302, headers: { location: 'http://github.com/x' } };
      if (u === 'https://github.com/loop') return { status: 302, headers: { location: 'https://github.com/loop' } };
      if (u === 'https://github.com/big') return { body: 'x'.repeat(100) };
      if (u === 'https://github.com/rel') return { status: 301, headers: { location: '/c' } };
      if (u === 'https://github.com/c') return { body: 'rel-ok' };
      return undefined;
    }, seen);
    const { ctx } = ctxOf(ws, f);
    ok((await download('https://github.com/a', ctx, 1000)).toString() === 'hello', 'follows allowed redirect');
    ok((await download('https://github.com/rel', ctx, 1000)).toString() === 'rel-ok', 'relative redirect resolved');
    for (const [u, why] of [['https://github.com/evil', 'redirect to foreign host'], ['https://github.com/downgrade', 'redirect to http'], ['https://github.com/loop', 'redirect loop'], ['https://github.com/big', 'size cap'], ['https://github.com/missing', 'http 404'], ['https://evil.example/x', 'foreign start']] as const) {
      let threw = false;
      try { await download(u, ctx, 50); } catch { threw = true; }
      ok(threw, `download refused: ${why}`);
    }
    ok(!seen.includes('https://evil.example/x'), 'foreign host is never contacted');
    ok(!seen.includes('http://github.com/x'), 'http is never contacted');
    let stopped = false;
    try { await download('https://github.com/a', { ...ctx, stopped: () => true }, 1000); } catch { stopped = true; }
    ok(stopped, 'download honours stop');
  }

  // --- Node.js を入れる
  {
    const ws = newWs('node-ok');
    const ver = '22.99.1';
    const name = `node-v${ver}-linux-x64.tar.gz`;
    const tgz = makeTarGz(`node-v${ver}-linux-x64`, { 'bin/node': `#!/bin/sh\necho v${ver}\n`, 'LICENSE': 'x' }, ['bin/node']);
    const base = 'https://nodejs.org/dist/latest-v22.x';
    const seen: string[] = [];
    const f = fakeFetch((u) => {
      if (u === `${base}/SHASUMS256.txt`) return { body: `${'0'.repeat(64)}  node-v22.99.1-darwin-arm64.tar.gz\n${sha256(tgz)}  ${name}\n` };
      if (u === `${base}/${name}`) return { body: tgz };
      return undefined;
    }, seen);
    const { c, ctx } = ctxOf(ws, f);
    const code = await installNode(ctx);
    ok(code === 0, 'installNode exit 0', c.text());
    ok(existsSync(join(ws, 'tools', 'node', 'bin', 'node')), 'tools/node/bin/node exists');
    ok(!existsSync(join(ws, 'tools', 'node', 'node-v22.99.1-linux-x64')), 'top directory stripped');
    ok(/SHA-256 が一致/.test(c.text()), 'reports checksum match');
    ok(!readdirSync(join(ws, 'tools')).some((e) => e.startsWith('.node-tmp-')), 'no temp dir left');
    ok(seen.every((u) => hostAllowed(u)), 'only allowed URLs fetched', seen);
    // 入れ直し（上書き）
    const again = ctxOf(ws, f);
    ok((await installNode(again.ctx)) === 0, 'reinstall over existing works');
    // 削除
    const r = collect();
    ok(removeTool(ws, 'node', r.out) === 0 && !existsSync(join(ws, 'tools', 'node')), 'removeTool node');
    ok(removeTool(ws, 'node', r.out) === 0, 'removeTool node twice is fine');
  }
  {
    // ハッシュ不一致 → 入れない（既存のものも壊さない）
    const ws = newWs('node-bad');
    mkdirSync(join(ws, 'tools', 'node', 'bin'), { recursive: true });
    writeFileSync(join(ws, 'tools', 'node', 'KEEP'), 'old');
    const tgz = makeTarGz('node-v22.9.9-linux-x64', { 'bin/node': '#!/bin/sh\necho v22.9.9\n' }, ['bin/node']);
    const f = fakeFetch((u) => {
      if (u.endsWith('/SHASUMS256.txt')) return { body: `${'f'.repeat(64)}  node-v22.9.9-linux-x64.tar.gz\n` };
      if (u.endsWith('.tar.gz')) return { body: tgz };
      return undefined;
    });
    const { c, ctx } = ctxOf(ws, f);
    ok((await installNode(ctx)) === 1, 'checksum mismatch → exit 1');
    ok(/一致しません/.test(c.text()), 'mismatch is reported', c.text());
    ok(existsSync(join(ws, 'tools', 'node', 'KEEP')), 'existing tools/node is untouched');
    ok(!readdirSync(join(ws, 'tools')).some((e) => e.startsWith('.node-tmp-')), 'no temp dir left after mismatch');
  }
  {
    // 壊れた tar.gz（ハッシュは合う）→ 展開失敗で入れない
    const ws = newWs('node-corrupt');
    const junk = Buffer.from('this is not a tarball');
    const f = fakeFetch((u) => {
      if (u.endsWith('/SHASUMS256.txt')) return { body: `${sha256(junk)}  node-v22.8.0-linux-x64.tar.gz\n` };
      if (u.endsWith('.tar.gz')) return { body: junk };
      return undefined;
    });
    const { c, ctx } = ctxOf(ws, f);
    ok((await installNode(ctx)) === 1 && /展開に失敗/.test(c.text()), 'corrupt archive → exit 1', c.text());
    ok(!existsSync(join(ws, 'tools', 'node')), 'nothing installed from a corrupt archive');
    ok(!readdirSync(join(ws, 'tools')).some((e) => e.startsWith('.node-tmp-')), 'no temp dir left after corrupt');
  }
  {
    const ws = newWs('node-os');
    const { c, ctx } = ctxOf(ws, fakeFetch(() => undefined), { platform: 'freebsd', arch: 'x64' });
    ok((await installNode(ctx)) === 1 && /Linux \/ macOS \/ Windows/.test(c.text()), 'unsupported OS refused with the supported list');
    const n = ctxOf(ws, fakeFetch(() => undefined));
    ok((await installNode(n.ctx)) === 1, 'network failure → exit 1 (no throw)');
  }

  // --- Python を入れる
  {
    const ws = newWs('py-ok');
    const triple = 'x86_64-unknown-linux-gnu';
    const mk = (patch: number) => `cpython-3.12.${patch}+20990101-${triple}-install_only.tar.gz`;
    const script = '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Python 3.12.9"; exit 0; fi\nif [ "$1" = "-c" ]; then exit 0; fi\nexit 0\n';
    const tgz = makeTarGz('python', { 'bin/python3': script, 'lib/x': '1' }, ['bin/python3']);
    const other = Buffer.from('other');
    const assets = [
      { name: mk(3), browser_download_url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20990101/old' },
      { name: mk(9), browser_download_url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20990101/new' },
      { name: `cpython-3.13.1+20990101-${triple}-install_only.tar.gz`, browser_download_url: 'https://github.com/x/13' },
      { name: `cpython-3.12.9+20990101-aarch64-apple-darwin-install_only.tar.gz`, browser_download_url: 'https://github.com/x/mac' },
      { name: `cpython-3.12.9+20990101-${triple}-debug-full.tar.zst`, browser_download_url: 'https://github.com/x/zst' },
      { name: 'SHA256SUMS', browser_download_url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20990101/SHA256SUMS' },
    ];
    const sums = `${sha256(other)}  ${mk(3)}\n${sha256(tgz)}  ${mk(9)}\n`;
    const seen: string[] = [];
    const f = fakeFetch((u) => {
      if (u === 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest') return { body: JSON.stringify({ assets }) };
      if (u.endsWith('/SHA256SUMS')) return { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/sums' } };
      if (u === 'https://release-assets.githubusercontent.com/sums') return { body: sums };
      if (u.endsWith('/new')) return { body: tgz };
      return undefined;
    }, seen);
    const { c, ctx } = ctxOf(ws, f);
    ok((await installPython(ctx)) === 0, 'installPython exit 0', c.text());
    ok(existsSync(join(ws, 'tools', 'python', 'bin', 'python3')), 'tools/python/bin/python3 exists');
    ok(seen.some((u) => u.endsWith('/new')) && !seen.some((u) => u.endsWith('/old')), 'picks the newest patch of 3.12 only');
    ok(!readdirSync(join(ws, 'tools')).some((e) => e.startsWith('.python-tmp-')), 'no temp dir left');

    // venv があるあいだは、Python を消さない
    mkdirSync(join(ws, 'tools', 'venv'), { recursive: true });
    const r = collect();
    ok(removeTool(ws, 'python', r.out) === 1 && existsSync(join(ws, 'tools', 'python')) && /Shoestring/.test(r.text()), 'python removal refused while tools/venv exists', r.text());
    rmSync(join(ws, 'tools', 'venv'), { recursive: true });
    ok(removeTool(ws, 'python', r.out) === 0 && !existsSync(join(ws, 'tools', 'python')), 'python removed once venv is gone');
  }
  {
    const ws = newWs('py-nosums');
    const f = fakeFetch((u) => u.includes('api.github.com') ? { body: JSON.stringify({ assets: [{ name: 'cpython-3.12.1+1-x86_64-unknown-linux-gnu-install_only.tar.gz', browser_download_url: 'https://github.com/x/a' }] }) } : { body: 'zzz' });
    const { c, ctx } = ctxOf(ws, f);
    ok((await installPython(ctx)) === 1 && /SHA256SUMS/.test(c.text()), 'no SHA256SUMS → refuse', c.text());
    ok(!existsSync(join(ws, 'tools', 'python')), 'nothing installed without a checksum list');
  }
  {
    const ws = newWs('py-badjson');
    const { c, ctx } = ctxOf(ws, fakeFetch(() => ({ body: 'not json' })));
    ok((await installPython(ctx)) === 1 && /入れられませんでした/.test(c.text()), 'bad release JSON → exit 1');
    const w2 = ctxOf(ws, fakeFetch(() => undefined), { platform: 'freebsd' });
    ok((await installPython(w2.ctx)) === 1, 'python on an unsupported OS refused');
  }

  // --- 削除の安全
  {
    const ws = newWs('rm-safe');
    const outside = newWs('rm-outside');
    writeFileSync(join(outside, 'precious.txt'), 'keep');
    mkdirSync(join(ws, 'tools'), { recursive: true });
    symlinkSync(outside, join(ws, 'tools', 'node'));
    const r = collect();
    ok(removeTool(ws, 'node', r.out) === 1 && existsSync(join(outside, 'precious.txt')), 'symlinked tools/node is not followed', r.text());
    ok(existsSync(join(ws, 'tools', 'node')), 'symlink itself is left alone');
  }

  // --- 手順（installSteps / uninstallSteps）と、許可リスト
  {
    for (const line of ['irome install node', 'irome install python', 'irome uninstall node', 'irome uninstall python']) ok(parseCommandLine(line).ok, `allowed: ${line}`);
    for (const line of ['irome install docker', 'irome install node extra', 'irome install ../node', 'irome install', 'irome install node; ls']) ok(!parseCommandLine(line).ok, `rejected: ${line}`);

    const ws = newWs('steps');
    const tgz = makeTarGz('node-v22.5.0-linux-x64', { 'bin/node': '#!/bin/sh\necho v22.5.0\n' }, ['bin/node']);
    const f = fakeFetch((u) => {
      if (u.endsWith('/SHASUMS256.txt')) return { body: `${sha256(tgz)}  node-v22.5.0-linux-x64.tar.gz\n` };
      if (u.endsWith('.tar.gz')) return { body: tgz };
      return undefined;
    });
    const steps = installSteps('node', ws, { fetch: f, platform: 'linux', arch: 'x64' });
    ok(steps.length === 1 && typeof steps[0].run === 'function' && steps[0].cmd === '', 'install node is a single in-process step (no shell, no cmd)');
    const c = collect();
    ok((await steps[0].run!(c.out, { stopped: () => false })) === 0 && existsSync(join(ws, 'tools', 'node', 'bin', 'node')), 'install step runs', c.text());
    const un = uninstallSteps('node', ws);
    ok((await un[0].run!(c.out, { stopped: () => false })) === 0 && !existsSync(join(ws, 'tools', 'node')), 'uninstall step runs');
    ok(uninstallSteps('python', ws).length === 1, 'uninstall python step exists');
  }

  rmSync(tmp, { recursive: true, force: true });
  console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
  process.exit(fails === 0 ? 0 : 1);
}
void main();
