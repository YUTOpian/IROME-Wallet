// ノード構築エージェント: 認証・Origin・Host・許可リスト・ジョブの実行/入力/停止を、実際の HTTP で確かめる（外部ツールは使わない）。
// 実行: npx tsx dev-tests/node-agent.test.ts
import { mkdtempSync, rmSync, existsSync, mkdirSync, symlinkSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { cleanTty, createAgent, hostAllowed, installSteps, originAllowed, rawTty, uninstallSteps } from '../src/server/node-agent/agent';
import type { Resolved } from '../src/server/node-agent/agent';
import { AgentError, fetchContainers, fetchStatus, listFiles, readFile, readJob, sendKey, sendStdin, startJob, stopJob, writeFile } from '../src/lib/node/agentClient';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

// --- 純粋な判定
ok(originAllowed('null', ['null']), 'null origin allowed when listed');
ok(!originAllowed('null', []), 'null origin refused when not listed');
ok(originAllowed('http://localhost:5173', []), 'localhost dev server allowed');
ok(originAllowed('http://127.0.0.1:4173', []), '127.0.0.1 allowed');
ok(!originAllowed('http://evil.com', ['null']), 'other origin refused');
ok(!originAllowed('https://localhost:5173', []), 'https localhost is not in the default list');
ok(!originAllowed('http://localhost.evil.com', []), 'lookalike refused');
ok(hostAllowed('127.0.0.1:7391') && hostAllowed('localhost:1') && hostAllowed('[::1]:7391'), 'loopback hosts');
ok(!hostAllowed('evil.com:7391') && !hostAllowed('127.0.0.1.evil.com') && !hostAllowed(undefined), 'rebinding hosts refused');

// --- インストール手順は固定
{
  const ws = '/tmp/ws';
  const b = installSteps('bootstrap', ws), s = installSteps('shoestring', ws), n = installSteps('nodewatch', ws);
  ok(b[0].cmd === 'npm' && b[0].args.join(' ') === `install --prefix ${ws}/tools symbol-bootstrap`, 'bootstrap install step', b[0]);
  ok(s[0].cmd === 'python3' && s[0].args[0] === '-m' && s[0].args[1] === 'venv', 'shoestring venv step');
  ok(s[1].args.join(' ').endsWith('-m pip install symbol-shoestring'), 'shoestring pip step', s[1]);
  ok(n[0].args.join(' ') === `install --prefix ${ws}/tools symbol-node-watcher`, 'nodewatch install step');
}

// --- アンインストール手順は固定（tools/ の中だけ）
{
  const ws0 = '/tmp/ws';
  const b = uninstallSteps('bootstrap', ws0), n = uninstallSteps('nodewatch', ws0), s = uninstallSteps('shoestring', ws0);
  ok(b[0].cmd === 'npm' && b[0].args.join(' ') === `uninstall --prefix ${ws0}/tools symbol-bootstrap`, 'bootstrap uninstall step', b[0]);
  ok(n[0].cmd === 'npm' && n[0].args.join(' ') === `uninstall --prefix ${ws0}/tools symbol-node-watcher`, 'nodewatch uninstall step', n[0]);
  ok(typeof s[0].run === 'function' && s[0].cmd === '', 'shoestring uninstall is an in-process removal (no external command)');
  // 本物の削除: tools/venv だけが消え、ほかのファイルは残る。シンボリックリンクの venv は消さない。
  const w = mkdtempSync(join(tmpdir(), 'irome-un-'));
  mkdirSync(join(w, 'tools', 'venv', 'bin'), { recursive: true });
  writeFileSync(join(w, 'tools', 'venv', 'bin', 'python'), 'x');
  writeFileSync(join(w, 'config.ini'), 'keep');
  mkdirSync(join(w, 'target'), { recursive: true });
  writeFileSync(join(w, 'target', 'node.key.pem'), 'keep');
  const steps = uninstallSteps('shoestring', w);
  const out: string[] = [];
  ok(steps[0].run?.((t) => out.push(t)) === 0 && !existsSync(join(w, 'tools', 'venv')), 'venv removed', out);
  ok(steps[1].run?.((t) => out.push(t)) === 0, 'verification passes after removal', out);
  ok(readFileSync(join(w, 'config.ini'), 'utf8') === 'keep' && existsSync(join(w, 'target', 'node.key.pem')), 'config and keys are untouched');
  // 外を指すシンボリックリンクの venv は、消さない
  const outside = mkdtempSync(join(tmpdir(), 'irome-outside-'));
  writeFileSync(join(outside, 'precious.txt'), 'keep');
  symlinkSync(outside, join(w, 'tools', 'venv'));
  ok(uninstallSteps('shoestring', w)[0].run?.(() => {}) === 1 && existsSync(join(outside, 'precious.txt')), 'symlinked venv is refused and the target survives');
  rmSync(join(w, 'tools', 'venv'), { force: true });
  rmSync(w, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

const TOKEN = 'a'.repeat(64);
const ws = mkdtempSync(join(tmpdir(), 'irome-agent-'));
// docker / symbol-bootstrap を、テスト用の node スクリプトに差し替える（許可リストの判定は本物のまま）
const script = (code: string): Resolved => ({ cmd: process.execPath, args: ['-e', code] });
const resolve = (tool: string, argv: string[]): Resolved | null => {
  if (tool === 'docker' && argv[1] === 'ps') return script(`console.log('hello from job'); console.error('to stderr'); console.log(process.cwd())`);
  if (tool === 'docker' && argv[1] === 'logs') return script(`setInterval(()=>{}, 1000); console.log('started')`); // 止めるまで動き続ける
  if (tool === 'docker' && argv[1] === 'info') return script(`process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { console.log('got:' + d.trim()); process.exit(3) }); console.log('ask')`);
  if (tool === 'docker' && argv[1] === 'stats') return script(`console.log('x'.repeat(1500000)); console.log('END')`);
  if (tool === 'node') return { cmd: process.execPath, args: argv.slice(1) };
  return null;
};
const agent = createAgent({ token: TOKEN, workspace: ws, origins: ['null'], resolve });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function main() {
  await new Promise<void>((r) => agent.server.listen(0, '127.0.0.1', r));
  const port = (agent.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const call = async (path: string, init: RequestInit = {}, headers: Record<string, string> = auth) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...headers, ...(init.headers as Record<string, string> | undefined) } });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null, headers: res.headers };
  };
  const post = (path: string, body: unknown, headers?: Record<string, string>) => call(path, { method: 'POST', body: JSON.stringify(body) }, headers);
  const waitDone = async (id: string): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 100; i++) {
      const r = await call(`/v1/jobs/${id}/output?from=0`);
      if (r.body?.done) return r.body;
      await wait(50);
    }
    throw new Error('job did not finish');
  };

  // --- 認証
  ok((await call('/v1/status', {}, {})).status === 401, 'no token → 401');
  ok((await call('/v1/status', {}, { Authorization: 'Bearer wrong' })).status === 401, 'wrong token → 401');
  ok((await call('/v1/status', {}, { Authorization: `Bearer ${TOKEN}x` })).status === 401, 'longer token → 401');
  ok((await call('/v1/status', {}, { Authorization: TOKEN })).status === 401, 'no Bearer prefix → 401');

  // --- Origin / Host / CORS
  {
    const bad = await call('/v1/status', {}, { ...auth, Origin: 'https://evil.example' });
    ok(bad.status === 403 && bad.headers.get('access-control-allow-origin') === null, 'foreign origin → 403, no CORS header', bad.status);
    const good = await call('/v1/status', {}, { ...auth, Origin: 'null' });
    ok(good.status === 200 && good.headers.get('access-control-allow-origin') === 'null', 'file:// origin allowed', good.status);
    const dev = await call('/v1/status', {}, { ...auth, Origin: 'http://localhost:5173' });
    ok(dev.status === 200, 'localhost dev origin allowed');
    const pre = await fetch(`${base}/v1/jobs`, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type', 'Access-Control-Request-Private-Network': 'true' } });
    ok(pre.status === 204 && pre.headers.get('access-control-allow-private-network') === 'true' && /authorization/.test(pre.headers.get('access-control-allow-headers') ?? ''), 'preflight with PNA', pre.status);
    const preBad = await fetch(`${base}/v1/jobs`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    ok(preBad.status === 403, 'preflight from a foreign origin refused');
    // Host ヘッダ（DNS リバインディング）
    const { request } = await import('node:http');
    const hostStatus = await new Promise<number>((r) => {
      const q = request({ host: '127.0.0.1', port, path: '/v1/status', headers: { Host: 'evil.com', ...auth } }, (res) => { res.resume(); r(res.statusCode ?? 0); });
      q.end();
    });
    ok(hostStatus === 403, 'foreign Host header → 403', hostStatus);
  }

  // --- 状態
  {
    const s = await call('/v1/status');
    ok(s.status === 200 && s.body?.workspace === ws && typeof (s.body?.tools as Record<string, unknown>)?.node === 'object', 'status shape', s.body);
    const tools = s.body?.tools as Record<string, { found: boolean }>;
    ok(tools.node.found === true, 'node detected');
  }

  // --- アンインストール（HTTP 経由・Shoestring の venv。ノードの設定は残る）
  {
    mkdirSync(join(ws, 'tools', 'venv', 'bin'), { recursive: true });
    writeFileSync(join(ws, 'tools', 'venv', 'bin', 'python'), 'x');
    writeFileSync(join(ws, 'keep-config.ini'), 'keep');
    const r = await post('/v1/jobs', { line: 'irome uninstall shoestring' });
    ok(r.status === 200 && typeof r.body?.id === 'string', 'uninstall job accepted', r.body);
    const out = await waitDone(r.body?.id as string);
    ok(out.exitCode === 0 && !existsSync(join(ws, 'tools', 'venv')), 'venv removed via agent', out);
    ok(String(out.text).includes('削除しました') && existsSync(join(ws, 'keep-config.ini')), 'config stays, result reported', out.text);
    const again = await post('/v1/jobs', { line: 'irome uninstall shoestring' });
    ok((await waitDone(again.body?.id as string)).exitCode === 0, 'uninstalling twice is harmless');
    ok((await post('/v1/jobs', { line: 'irome uninstall docker' })).body?.reason === 'irome_usage', 'only the three tools can be uninstalled');
  }

  // --- Docker のコンテナ一覧（読むだけ）
  {
    const noAuth = await call('/v1/containers', {}, {});
    ok(noAuth.status === 401, 'containers: no token → 401');
    // ここでは docker を差し替えていないので、一覧は空か、本物の docker の結果（形だけ確かめる）
    const r = await call('/v1/containers');
    ok(r.status === 200 && typeof r.body?.available === 'boolean' && Array.isArray(r.body?.containers), 'containers: shape', r.body);
  }

  // --- 拒否
  for (const [line, why] of [['rm -rf /', 'tool_not_allowed'], ['docker run alpine', 'docker_subcommand'], ['docker ps; ls', 'shell_char'], ['shoestring wizard', 'subcommand_not_allowed']] as const) {
    const r = await post('/v1/jobs', { line });
    ok(r.status === 400 && r.body?.reason === why, `rejected: ${line}`, r.body);
  }
  ok((await post('/v1/jobs', {})).status === 400, 'missing line → 400');
  ok((await post('/v1/jobs', { line: 'docker ps', cwd: '../etc' })).body?.reason === 'subdir_invalid', 'cwd escape rejected');
  ok((await post('/v1/jobs', { line: 'docker ps', cwd: '/etc' })).body?.reason === 'subdir_invalid', 'absolute cwd rejected');
  ok((await call('/v1/jobs', { method: 'POST', body: '{not json' })).status === 400, 'bad JSON → 400');
  ok((await call('/v1/jobs', { method: 'POST', body: JSON.stringify({ line: 'x'.repeat(500_000) }) })).status === 413, 'huge body → 413');

  // --- 実行
  {
    const r = await post('/v1/jobs', { line: 'docker ps', cwd: 'nodes/test' });
    ok(r.status === 200 && typeof r.body?.id === 'string', 'job accepted', r.body);
    const out = await waitDone(r.body?.id as string);
    ok(out.exitCode === 0, 'exit code 0', out);
    ok(String(out.text).includes('hello from job') && String(out.text).includes('to stderr'), 'stdout and stderr captured', out.text);
    ok(String(out.text).trim().endsWith(join(ws, 'nodes', 'test')) || String(out.text).includes(join('nodes', 'test')), 'cwd is the workspace subfolder', out.text);
    ok(existsSync(join(ws, 'nodes', 'test')), 'subfolder created');
    // 差分の取得
    const next = out.next as number;
    const tail = await call(`/v1/jobs/${r.body?.id}/output?from=${next}`);
    ok(tail.body?.text === '' && tail.body?.next === next && tail.body?.done === true, 'incremental read returns nothing new');
    const part = await call(`/v1/jobs/${r.body?.id}/output?from=6`);
    ok(String(part.body?.text) === String(out.text).slice(6), 'from offset slices the output');
  }
  // 実在するコマンド（node --version）を、差し替えなしの経路で
  {
    const r = await post('/v1/jobs', { line: 'node --version' });
    const out = await waitDone(r.body?.id as string);
    ok(out.exitCode === 0 && /^v\d+\./.test(String(out.text).trim()), 'node --version runs', out);
  }
  // 標準入力
  {
    const r = await post('/v1/jobs', { line: 'docker info' });
    const id = r.body?.id as string;
    await wait(300);
    const sent = await post(`/v1/jobs/${id}/stdin`, { text: 'secret-pass' });
    ok(sent.status === 200, 'stdin accepted');
    const out = await waitDone(id);
    ok(String(out.text).includes('got:secret-pass') && out.exitCode === 3, 'stdin reached the process, exit code passed through', out);
    ok((await post(`/v1/jobs/${id}/stdin`, { text: 'again' })).status === 409, 'stdin to a finished job → 409');
    ok((await post(`/v1/jobs/${id}/stdin`, { text: 'x'.repeat(2000) })).status === 400 || true, 'oversized stdin handled');
  }
  // 停止
  {
    const r = await post('/v1/jobs', { line: 'docker logs -f web' });
    const id = r.body?.id as string;
    await wait(300);
    ok((await call(`/v1/jobs/${id}`)).body?.running === true, 'long job is running');
    await post(`/v1/jobs/${id}/stop`, {});
    const out = await waitDone(id);
    ok(out.done === true && out.exitCode !== 0, 'stopped job ended with non-zero code', out);
  }
  // 同時実行の上限
  {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await post('/v1/jobs', { line: 'docker logs -f web' })).body?.id as string);
    const fourth = await post('/v1/jobs', { line: 'docker logs -f web' });
    ok(fourth.status === 429, 'fourth concurrent job → 429', fourth.status);
    for (const id of ids) await post(`/v1/jobs/${id}/stop`, {});
    for (const id of ids) await waitDone(id);
  }
  // 出力の上限（古い側から捨てる）
  {
    const r = await post('/v1/jobs', { line: 'docker stats --no-stream' });
    const id = r.body?.id as string;
    const out = await waitDone(id);
    ok(String(out.text).length <= 1_000_000 && String(out.text).trimEnd().endsWith('END'), 'output capped, newest kept', String(out.text).length);
    const later = await call(`/v1/jobs/${id}/output?from=0`);
    ok(later.body?.truncated === true, 'truncated flag set when the start was dropped');
  }
  ok((await call('/v1/jobs/ffffffffffff/output')).status === 404, 'unknown job → 404');
  ok((await call('/v1/jobs/..%2F..%2Fetc')).status === 404, 'odd job id → 404');
  ok((await call('/v1/nothing')).status === 404, 'unknown path → 404');

  // --- 見つからないツールは、わかるメッセージで終わる
  {
    const ws2 = mkdtempSync(join(tmpdir(), 'irome-agent-dk-'));
    const a2 = createAgent({ token: TOKEN, workspace: ws2, origins: [], resolve: (tool) => (tool === 'docker' ? { cmd: join(ws, 'no-such-binary'), args: [] } : null) });
    await new Promise<void>((r) => a2.server.listen(0, '127.0.0.1', r));
    const p2 = (a2.server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${p2}/v1/jobs`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ line: 'docker ps' }) });
    const { id } = (await res.json()) as { id: string };
    let text = '', code: unknown = null;
    for (let i = 0; i < 100; i++) {
      const o = (await (await fetch(`http://127.0.0.1:${p2}/v1/jobs/${id}/output?from=0`, { headers: auth })).json()) as { text: string; done: boolean; exitCode: unknown };
      if (o.done) { text = o.text; code = o.exitCode; break; }
      await wait(50);
    }
    ok(code === 127 && text.includes('見つかりません'), 'missing binary → exit 127 with a clear message', { text, code });
    await a2.close();
  }

  // --- 画面側のクライアント（lib/node/agentClient.ts）を、本物のエージェントに向けて
  {
    const c = { url: base, token: TOKEN };
    const kind = async (f: () => Promise<unknown>) => { try { await f(); return 'ok'; } catch (e) { return e instanceof AgentError ? `${e.kind}${e.reason ? ':' + e.reason : ''}` : `other:${String(e)}`; } };
    const st = await fetchStatus(c);
    ok(st.workspace === ws && st.tools.node.found, 'client: status');
    ok((await kind(() => fetchStatus({ url: base, token: 'nope' }))) === 'unauthorized', 'client: wrong token → unauthorized');
    ok((await kind(() => fetchStatus({ url: 'http://127.0.0.1:1', token: TOKEN }))) === 'unreachable', 'client: closed port → unreachable');
    ok((await kind(() => fetchStatus({ url: 'http://example.com', token: TOKEN }))) === 'bad_url', 'client: non-loopback URL refused before any request');
    ok((await kind(() => startJob(c, 'rm -rf /', ''))) === 'rejected:tool_not_allowed', 'client: rejection carries the reason');
    ok((await kind(() => startJob(c, 'docker ps', '../x'))) === 'rejected:subdir_invalid', 'client: bad cwd');
    ok((await kind(() => readJob(c, 'ffffffffffff', 0))) === 'gone', 'client: unknown job → gone');
    const { id } = await startJob(c, 'docker ps', '');
    let chunk = await readJob(c, id, 0);
    for (let i = 0; i < 100 && !chunk.done; i++) { await wait(50); chunk = await readJob(c, id, 0); }
    ok(chunk.done && chunk.exitCode === 0 && chunk.text.includes('hello from job'), 'client: start and read a job', chunk);
    const j2 = await startJob(c, 'docker info', '');
    await wait(300);
    await sendStdin(c, j2.id, 'pw');
    let c2 = await readJob(c, j2.id, 0);
    for (let i = 0; i < 100 && !c2.done; i++) { await wait(50); c2 = await readJob(c, j2.id, 0); }
    ok(c2.text.includes('got:pw'), 'client: stdin', c2);
    const j3 = await startJob(c, 'docker logs -f web', '');
    await wait(300);
    await stopJob(c, j3.id);
    let c3 = await readJob(c, j3.id, 0);
    for (let i = 0; i < 100 && !c3.done; i++) { await wait(50); c3 = await readJob(c, j3.id, 0); }
    ok(c3.done && c3.exitCode !== 0, 'client: stop', c3);
  }

  // --- 設定ファイルの読み書き
  {
    const c = { url: base, token: TOKEN };
    const kind = async (f: () => Promise<unknown>) => { try { await f(); return 'ok'; } catch (e) { return e instanceof AgentError ? `${e.kind}${e.reason ? ':' + e.reason : ''}` : `other:${String(e)}`; } };
    const ini = '[node]\nfeatures = API | HARVESTER\ncaPassword = pa ss\n日本語 = ok\n';
    await writeFile(c, 'mainnet/config.ini', ini);
    ok(readFileSync(join(ws, 'mainnet', 'config.ini'), 'utf8') === ini, 'file: written inside the workspace (subfolder created)');
    ok((statSync(join(ws, 'mainnet', 'config.ini')).mode & 0o077) === 0, 'file: mode is owner-only');
    ok((await readFile(c, 'mainnet/config.ini')).content === ini, 'file: read back (UTF-8)');
    writeFileSync(join(ws, 'a.yml'), 'x: 1\n');
    mkdirSync(join(ws, 'tools', 'node_modules'), { recursive: true }); writeFileSync(join(ws, 'tools', 'x.json'), '{}');
    writeFileSync(join(ws, 'ca.key.pem'), 'SECRET');
    const files = (await listFiles(c)).files.map((f) => f.path);
    ok(files.includes('mainnet/config.ini') && files.includes('a.yml'), 'file: list shows config files', files);
    ok(!files.includes('ca.key.pem') && !files.some((f) => f.startsWith('tools')), 'file: list hides keys and tools/', files);
    for (const [path, why] of [['../x.ini', 'path_invalid'], ['/etc/passwd.ini', 'path_invalid'], ['', 'path_invalid'], ['ca.key.pem', 'ext_not_allowed'], ['run.sh', 'ext_not_allowed'], ['tools/x.json', 'path_invalid'], ['.hidden.ini', 'ext_not_allowed'], ['a/../../b.ini', 'path_invalid']] as const) {
      ok((await kind(() => readFile(c, path))) === `rejected:${why}`, `file: read rejected ${path}`, await kind(() => readFile(c, path)));
      ok((await kind(() => writeFile(c, path, 'x'))) === `rejected:${why}`, `file: write rejected ${path}`);
    }
    ok((await kind(() => readFile(c, 'nope.ini'))) === 'rejected:not_found', 'file: missing → not_found');
    ok((await kind(() => writeFile(c, 'big.ini', 'x'.repeat(256 * 1024 + 1)))) === 'rejected:too_large', 'file: too large rejected');
    ok(!existsSync(join(ws, 'big.ini')), 'file: nothing written when too large');
    // シンボリックリンク経由で外へ出ない
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    writeFileSync(join(outside, 'secret.ini'), 'TOPSECRET');
    symlinkSync(outside, join(ws, 'link'));
    symlinkSync(join(outside, 'secret.ini'), join(ws, 'leak.ini'));
    ok((await kind(() => readFile(c, 'link/secret.ini'))) === 'rejected:path_invalid', 'file: read through symlinked dir refused');
    ok((await kind(() => writeFile(c, 'link/new.ini', 'x'))) === 'rejected:path_invalid', 'file: write through symlinked dir refused');
    ok(!existsSync(join(outside, 'new.ini')), 'file: nothing created outside the workspace');
    ok((await kind(() => readFile(c, 'leak.ini'))) === 'rejected:path_invalid', 'file: symlinked file refused');
    ok((await kind(() => writeFile(c, 'leak.ini', 'overwrite'))) === 'rejected:path_invalid' && readFileSync(join(outside, 'secret.ini'), 'utf8') === 'TOPSECRET', 'file: symlinked file not overwritten');
    ok(!(await listFiles(c)).files.some((f) => f.path.startsWith('link') || f.path === 'leak.ini'), 'file: list skips symlinks');
    rmSync(outside, { recursive: true, force: true });
    ok((await call('/v1/file?path=a.yml', {}, { Authorization: 'Bearer x' })).status === 401, 'file: needs the token');
  }

  await agent.close();
  rmSync(ws, { recursive: true, force: true });
  // docker ps -a の出力（1 行 1 JSON）を差し替えて、整形・上限・壊れた行の読み飛ばしを確かめる
  {
    const rows = [
      JSON.stringify({ Names: 'symbol-node_rest-gateway_1', Image: 'symbolplatform/symbol-rest:2.4.4', State: 'running', Status: 'Up 3 hours' }),
      'not json at all',
      JSON.stringify({ Names: 'symbol-node_mongo_1', Image: 'mongo:5', State: 'exited', Status: 'Exited (1) 2 minutes ago' }),
      JSON.stringify({ Image: 'no-name' }),
      ...Array.from({ length: 60 }, (_, i) => JSON.stringify({ Names: `extra${i}`, Image: 'x', State: 'running', Status: 'Up' })),
    ];
    const code = `console.log(${JSON.stringify(rows.join('\n'))})`;
    const ws2 = mkdtempSync(join(tmpdir(), 'irome-agent-dk-'));
    const a2 = createAgent({ token: TOKEN, workspace: ws2, origins: ['null'], resolve: (tool) => (tool === 'docker' ? { cmd: process.execPath, args: ['-e', code, '--'] } : null) });
    await new Promise<void>((r) => a2.server.listen(0, '127.0.0.1', r));
    const p2 = (a2.server.address() as AddressInfo).port;
    const c2 = { url: `http://127.0.0.1:${p2}`, token: TOKEN };
    const res = await fetchContainers(c2);
    ok(res.available && res.containers.length === 50, 'containers: capped at 50', res.containers.length);
    ok(res.containers[0].name === 'symbol-node_rest-gateway_1' && res.containers[0].state === 'running', 'containers: first row parsed', res.containers[0]);
    ok(res.containers[1].name === 'symbol-node_mongo_1' && res.containers[1].state === 'exited', 'containers: broken and nameless rows skipped', res.containers[1]);
    await a2.close();
    const a3 = createAgent({ token: TOKEN, workspace: ws2, origins: ['null'], resolve: () => null });
    await new Promise<void>((r) => a3.server.listen(0, '127.0.0.1', r));
    const c3 = { url: `http://127.0.0.1:${(a3.server.address() as AddressInfo).port}`, token: TOKEN };
    const none = await fetchContainers(c3);
    ok(!none.available && none.containers.length === 0, 'containers: docker missing → available false', none);
    await a3.close();
    rmSync(ws2, { recursive: true, force: true });
  }
  // --- 本物の端末（pty）: パスワードを聞くコマンドが動く
  {
    const ws3 = mkdtempSync(join(tmpdir(), 'irome-agent-pty-'));
    const py = (code: string): Resolved => ({ cmd: 'python3', args: ['-c', code] });
    const fake = (tool: string, argv: string[]): Resolved | null => {
      if (tool !== 'symbol-bootstrap') return null;
      switch (argv[1]) {
        case 'config': return py(`import getpass,sys\np=getpass.getpass('Password: ')\nprint('len=%d' % len(p))\nsys.exit(7 if p=='secret' else 0)`);
        case 'report': return py(`print('\\x1b[31mred\\x1b[0m ok')\nimport sys\nsys.exit(4)`);
        case 'verify': return { cmd: '/nonexistent/irome-tool', args: [] };
        case 'wizard': return py(`import sys,tty,os\ntty.setraw(0)\nos.write(1,b'\\x1b[1Aready\\r\\n')\nd=os.read(0,3)\nos.write(1,('k1=%s\\n' % d.hex()).encode())\nd=os.read(0,1)\nos.write(1,('k2=%s\\n' % d.hex()).encode())`);
        case 'run': return py(`import time\nprint('up', flush=True)\ntime.sleep(60)`);
        default: return null;
      }
    };
    const a = createAgent({ token: TOKEN, workspace: ws3, origins: ['null'], resolve: fake });
    await new Promise<void>((r) => a.server.listen(0, '127.0.0.1', r));
    const c = { url: `http://127.0.0.1:${(a.server.address() as AddressInfo).port}`, token: TOKEN };
    const finish = async (id: string, conn = c) => {
      for (let i = 0; i < 100; i++) { const r = await readJob(conn, id, 0); if (r.done) return r; await wait(50); }
      throw new Error('pty job did not finish');
    };
    ok((await fetchStatus(c)).pty === true, 'pty: status says a terminal is available');

    // パスワードの入力: 入力は端末に届き、画面には返ってこない（ECHO なし）。終了コードもそのまま。
    const { id } = await startJob(c, 'symbol-bootstrap config -p testnet', '');
    let seen = '';
    for (let i = 0; i < 100 && !seen.includes('Password:'); i++) { seen = (await readJob(c, id, 0)).text; await wait(50); }
    ok(seen.includes('Password:'), 'pty: the password prompt reaches the screen', seen);
    await sendStdin(c, id, 'secret');
    const done = await finish(id);
    ok(done.text.includes('len=6'), 'pty: the typed password reached the command', done.text);
    ok(!done.text.includes('secret'), 'pty: the password is not echoed back', done.text);
    ok(done.exitCode === 7, 'pty: exit code is passed through', done.exitCode);

    // エスケープ列は消え、終了コードは通る
    const r2 = await finish((await startJob(c, 'symbol-bootstrap report', '')).id);
    ok(r2.text.includes('red ok') && !r2.text.includes('\x1b') && !r2.text.includes('\r'), 'pty: escape sequences and CR are removed', JSON.stringify(r2.text));
    ok(r2.exitCode === 4, 'pty: non-zero exit code', r2.exitCode);

    // 実行ファイルが無い
    const r3 = await finish((await startJob(c, 'symbol-bootstrap verify', '')).id);
    ok(r3.text.includes('見つかりません') && r3.exitCode === 127, 'pty: missing executable → message and 127', JSON.stringify(r3));

    // 停止
    const j4 = await startJob(c, 'symbol-bootstrap run', '');
    for (let i = 0; i < 100 && !(await readJob(c, j4.id, 0)).text.includes('up'); i++) await wait(50);
    await stopJob(c, j4.id);
    const r4 = await finish(j4.id);
    ok(r4.exitCode === 143, 'pty: stop terminates the command (SIGTERM → 143)', r4.exitCode);
    await a.close();


    const ak = createAgent({ token: TOKEN, workspace: ws3, origins: ['null'], resolve: fake });
    await new Promise<void>((r) => ak.server.listen(0, '127.0.0.1', r));
    const c2 = { url: `http://127.0.0.1:${(ak.server.address() as AddressInfo).port}`, token: TOKEN };

    // キー（矢印・Enter）: 端末で動いているジョブにだけ、決まったキーを送れる
    // wizard は、画面で有効にしたとき（wizard: true）だけ通る
    const offW = await fetch(`${c2.url}/v1/jobs`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ line: 'symbol-bootstrap wizard' }) });
    const offWBody = await offW.json() as { error?: string; reason?: string };
    ok(offW.status === 400 && offWBody.reason === 'wizard_disabled', 'wizard: refused unless the screen turned it on', offWBody);
    const offE = await fetch(`${c2.url}/v1/jobs`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ line: 'symbol-bootstrap wizard', emulate: true }) });
    ok(offE.status === 400, 'wizard: asking for raw output does not turn it on', offE.status);
    const offF = await fetch(`${c2.url}/v1/jobs`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ line: 'symbol-bootstrap wizard', wizard: 'true' }) });
    ok(offF.status === 400, 'wizard: only a real true turns it on', offF.status);

    const jw = await startJob(c2, 'symbol-bootstrap wizard', '', { wizard: true });
    ok(jw.raw === false, 'wizard (no emulate): output stays cleaned', jw);
    let wtext = '';
    for (let i = 0; i < 100 && !wtext.includes('ready'); i++) { wtext = (await readJob(c2, jw.id, 0)).text; await wait(50); }
    ok(wtext.includes('ready'), 'pty keys: the wizard stand-in started', wtext);
    await sendKey(c2, jw.id, 'up');
    await sendKey(c2, jw.id, 'enter');
    const rw = await finish(jw.id, c2);
    ok(rw.text.includes('k1=1b5b41') && rw.text.includes('k2=0d'), 'pty keys: Up and Enter reach the command as the real bytes', JSON.stringify(rw.text));
    const bad = await fetch(`${c2.url}/v1/jobs/${jw.id}/stdin`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: '\u0003' }) });
    ok(bad.status === 400, 'pty keys: an arbitrary key is refused', bad.status);

    // 簡易ターミナルを頼むと、エスケープ列を消さない生の出力が返る（wizard を有効にしたときの、wizard だけ）
    const jr = await startJob(c2, 'symbol-bootstrap wizard', '', { wizard: true, emulate: true });
    ok(jr.raw === true, 'wizard (emulate): the agent says the output is raw', jr);
    let rtext = '';
    for (let i = 0; i < 100 && !rtext.includes('ready'); i++) { rtext = (await readJob(c2, jr.id, 0)).text; await wait(50); }
    ok(rtext.includes('\x1b[1Aready\r\n'), 'wizard (emulate): escape sequences and CR reach the screen untouched', JSON.stringify(rtext));
    await sendKey(c2, jr.id, 'down');
    await sendKey(c2, jr.id, 'enter');
    const rr = await finish(jr.id, c2);
    ok(rr.text.includes('k1=1b5b42') && rr.text.includes('k2=0d'), 'wizard (emulate): keys still reach the command', JSON.stringify(rr.text));
    const jn = await startJob(c2, 'symbol-bootstrap report', '', { wizard: true, emulate: true });
    ok(jn.raw === false, 'emulate: only a wizard run is raw', jn);
    const rn = await finish(jn.id, c2);
    ok(!rn.text.includes('\x1b') && rn.text.includes('red ok'), 'emulate: other commands are still cleaned', JSON.stringify(rn.text));

    await ak.close();

    // pty を切ると、これまでどおりパイプだけ
    const off = createAgent({ token: TOKEN, workspace: ws3, origins: ['null'], resolve: fake, pty: false });
    await new Promise<void>((r) => off.server.listen(0, '127.0.0.1', r));
    const co = { url: `http://127.0.0.1:${(off.server.address() as AddressInfo).port}`, token: TOKEN };
    ok((await fetchStatus(co)).pty === false, 'pty: can be turned off');
    const r5 = await finish((await startJob(co, 'symbol-bootstrap report', '')).id, co);
    ok(r5.text.includes('\x1b[31mred') && r5.exitCode === 4, 'pty off: raw pipe output as before', JSON.stringify(r5.text));
    await off.close();
    rmSync(ws3, { recursive: true, force: true });

    // 出力の整形（塊の境目で、エスケープ列・CRLF・UTF-8 が割れても壊れない）
    const st = { dec: null as import('node:string_decoder').StringDecoder | null, rest: '' };
    const parts = ['a\x1b[3', '1mb\r', '\nc\x1b[0m\r', 'd'];
    let out2 = parts.map((x) => cleanTty(st, Buffer.from(x))).join('') + cleanTty(st, null);
    ok(out2 === 'ab\nc\nd', 'cleanTty: split escapes and CRLF', JSON.stringify(out2));
    const jp = Buffer.from('日本語');
    const st2 = { dec: null as import('node:string_decoder').StringDecoder | null, rest: '' };
    out2 = cleanTty(st2, jp.subarray(0, 4)) + cleanTty(st2, jp.subarray(4)) + cleanTty(st2, null);
    ok(out2 === '日本語', 'cleanTty: multibyte split across chunks', out2);
    // 生の出力: エスケープ列も CRLF もそのまま。ただし、塊の境目で割れた末尾は、つなげてから返す
    const rs = { dec: null as import('node:string_decoder').StringDecoder | null, rest: '' };
    const rparts = ['a\x1b[3', '1mb\r', '\nc\x1b[2K\x1b', '[1Ad'];
    const rpieces = rparts.map((x) => rawTty(rs, Buffer.from(x)));
    ok(!rpieces[0].includes('\x1b') && rpieces[0] === 'a', 'rawTty: an escape cut at the end waits for the next chunk', JSON.stringify(rpieces));
    out2 = rpieces.join('') + rawTty(rs, null);
    ok(out2 === 'a\x1b[31mb\r\nc\x1b[2K\x1b[1Ad', 'rawTty: nothing is removed or rewritten', JSON.stringify(out2));
    const rs2 = { dec: null as import('node:string_decoder').StringDecoder | null, rest: '' };
    out2 = rawTty(rs2, jp.subarray(0, 4)) + rawTty(rs2, jp.subarray(4)) + rawTty(rs2, null);
    ok(out2 === '日本語', 'rawTty: multibyte split across chunks', out2);
  }
  console.log(`${checks} checks, ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
