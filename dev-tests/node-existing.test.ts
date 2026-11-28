// 既存のノード（symbol-bootstrap 製・Shoestring 製）を操る部品: 検出（名前だけ）・受け取りの検証・よく使うコマンド・作り直すコマンドの見分け・エージェントの HTTP。
// 実行: npx tsx dev-tests/node-existing.test.ts
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { existingPresets, nodeAt, riskOnExisting, sanitizeExistingNodes } from '../src/lib/node/existingNodes';
import type { ExistingNode } from '../src/lib/node/existingNodes';
import { findExistingNodes } from '../src/server/node-agent/existingNodes';
import { createAgent } from '../src/server/node-agent/agent';
import { AgentError, fetchExistingNodes } from '../src/lib/node/agentClient';
import { parseCommandLine, validateArgv, validateSubdir } from '../src/lib/node/nodeCommands';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const put = (p: string, body = 'x') => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); };

const ws = mkdtempSync(join(tmpdir(), 'irome-existing-'));
// bootstrap 製: bs/target/docker/docker-compose.yml（中に addresses.yml）
put(join(ws, 'bs/target/docker/docker-compose.yml'));
put(join(ws, 'bs/target/addresses.yml'), 'SECRET-DO-NOT-READ');
// Shoestring 製: ss/docker-compose.yaml + userconfig/
put(join(ws, 'ss/docker-compose.yaml'));
mkdirSync(join(ws, 'ss/userconfig'), { recursive: true });
// 深い場所の Shoestring（config.ini だけで見分ける）
put(join(ws, 'a/b/ss2/compose.yaml'));
put(join(ws, 'a/b/ss2/config.ini'));
// 見つけてはいけないもの: compose だけ（どちらの印も無い）・tools/ ・ . で始まるフォルダ・シンボリックリンク
put(join(ws, 'plain/docker-compose.yml'));
put(join(ws, 'tools/x/target/docker/docker-compose.yml'));
put(join(ws, '.hidden/target/docker/docker-compose.yml'));
put(join(ws, 'node_modules/y/docker-compose.yml'));
put(join(ws, 'node_modules/y/config.ini'));
let linked = false;
try { symlinkSync(join(ws, 'bs'), join(ws, 'link-to-bs'), 'dir'); linked = true; } catch { /* 作れない環境 */ }
// target があっても docker/ に compose が無い（bootstrap の途中）→ bootstrap にしない
mkdirSync(join(ws, 'half/target/docker'), { recursive: true });
// 作業場所の直下がノード（bootstrap）のとき
const ws2 = mkdtempSync(join(tmpdir(), 'irome-existing2-'));
put(join(ws2, 'target/docker/docker-compose.yml'));

const found = findExistingNodes(ws);
const key = (n: ExistingNode) => `${n.kind}:${n.dir}|${n.composeDir}`;
const keys = found.map(key);
ok(keys.includes('bootstrap:bs|bs/target/docker'), 'bootstrap node found with compose dir under target/docker', keys);
ok(keys.includes('shoestring:ss|ss'), 'shoestring node found (userconfig/)', keys);
ok(keys.includes('shoestring:a/b/ss2|a/b/ss2'), 'deep shoestring node found (config.ini)', keys);
ok(!keys.some((k) => k.includes('plain')), 'compose-only folder is not a node', keys);
ok(!keys.some((k) => k.includes('tools') || k.includes('.hidden') || k.includes('node_modules')), 'tools / dot dirs / node_modules skipped', keys);
ok(!keys.some((k) => k.includes('half')), 'target without compose is not a node', keys);
ok(!keys.some((k) => k.includes('target/docker|target/docker') || k.startsWith('shoestring:bs')), 'bootstrap target/docker is not counted as a second node', keys);
if (linked) ok(!keys.some((k) => k.includes('link-to-bs')), 'symlinked folder not followed', keys);
ok(found.length === 3, 'exactly 3 nodes', keys);
ok(keys.indexOf('bootstrap:bs|bs/target/docker') < keys.indexOf('shoestring:a/b/ss2|a/b/ss2'), 'shallow first', keys);
ok(findExistingNodes(ws2).map(key).join() === 'bootstrap:|target/docker', 'workspace root itself can be the node', findExistingNodes(ws2).map(key));
ok(findExistingNodes(join(ws, 'nope')).length === 0, 'missing workspace → empty');

// --- 受け取りの検証
ok(sanitizeExistingNodes(null).length === 0 && sanitizeExistingNodes('x').length === 0, 'non-array → empty');
const sn = sanitizeExistingNodes([
  { kind: 'bootstrap', dir: 'bs', composeDir: 'bs/target/docker', extra: 'dropped' },
  { kind: 'other', dir: 'x', composeDir: 'x' },
  { kind: 'shoestring', dir: '../out', composeDir: 'x' },
  { kind: 'shoestring', dir: '/abs', composeDir: 'x' },
  { kind: 'shoestring', dir: 'ok', composeDir: 'C:/win' },
  { kind: 'shoestring', dir: 'ss', composeDir: 'ss' },
  null, 5, { kind: 'shoestring', dir: 1, composeDir: 'x' },
]);
ok(sn.map(key).join() === 'bootstrap:bs|bs/target/docker,shoestring:ss|ss', 'bad entries dropped', sn.map(key));
ok(!('extra' in (sn[0] as object)), 'unknown fields dropped');
ok(sanitizeExistingNodes(Array.from({ length: 50 }, (_, i) => ({ kind: 'shoestring', dir: `n${i}`, composeDir: `n${i}` }))).length === 20, 'capped at 20');

// --- よく使うコマンドは、すべて許可の判定を通り、作り直さない
const bs: ExistingNode = { kind: 'bootstrap', dir: 'bs', composeDir: 'bs/target/docker' };
const ss: ExistingNode = { kind: 'shoestring', dir: 'ss', composeDir: 'ss' };
for (const n of [bs, ss]) {
  const ps = existingPresets(n);
  ok(ps.length >= 4, `${n.kind}: presets exist`);
  for (const p of ps) {
    const r = parseCommandLine(p.line, {});
    ok(r.ok, `${n.kind}: preset passes the allow-list: ${p.line}`, r);
    ok(validateSubdir(p.cwd).ok, `${n.kind}: preset cwd valid: ${p.cwd}`);
    ok(r.ok && riskOnExisting(r.argv, p.cwd, [n]) === null, `${n.kind}: preset is not flagged risky: ${p.line}`);
  }
}
ok(existingPresets(bs).filter((p) => p.line.startsWith('docker compose')).every((p) => p.cwd === 'bs/target/docker'), 'bootstrap: compose runs in target/docker');
ok(existingPresets(bs).filter((p) => p.line.startsWith('symbol-bootstrap')).every((p) => p.cwd === 'bs'), 'bootstrap: symbol-bootstrap runs in the node dir');
ok(existingPresets(ss).every((p) => p.cwd === 'ss'), 'shoestring: everything runs in the node dir');

// --- 作り直す・消すコマンドの見分け
const risk = (line: string, cwd: string, nodes: ExistingNode[]) => { const r = parseCommandLine(line, {}); return r.ok ? riskOnExisting(r.argv, cwd, nodes)?.command ?? null : 'REJECTED'; };
for (const c of ['config', 'start', 'clean', 'resetData', 'encrypt', 'decrypt']) ok(risk(`symbol-bootstrap ${c}`, 'bs', [bs]) === `symbol-bootstrap ${c}`, `bootstrap ${c} in node dir → risky`);
ok(risk('symbol-bootstrap config -p testnet -a dual --noPassword', 'bs', [bs]) === 'symbol-bootstrap config', 'bootstrap config with options → risky');
ok(risk('symbol-bootstrap resetData', 'bs/target/docker', [bs]) === 'symbol-bootstrap resetData', 'inside the compose dir counts too');
ok(risk('symbol-bootstrap config', 'bs/sub', [bs]) === 'symbol-bootstrap config', 'inside a sub folder of the node counts too');
for (const c of ['healthCheck', 'stop', 'run', 'compose', 'link', 'updateVotingKeys', 'report', 'verify']) ok(risk(`symbol-bootstrap ${c}`, 'bs', [bs]) === null, `bootstrap ${c} → not risky`);
ok(risk('shoestring init --package mainnet config.ini', 'ss', [ss]) === 'shoestring init', 'shoestring init → risky');
ok(risk('shoestring setup --config ./config.ini --overrides ./overrides.ini --package mainnet --directory . --ca-key-path ./ca.key.pem', 'ss', [ss]) === 'shoestring setup', 'shoestring setup → risky');
ok(risk('shoestring reset-data --config config.ini --directory .', 'ss', [ss]) === 'shoestring reset-data', 'shoestring reset-data → risky');
ok(risk('python3 -m shoestring setup --config c.ini --overrides o.ini --package mainnet --directory . --ca-key-path ./ca.key.pem', 'ss', [ss]) === 'shoestring setup', 'python3 -m shoestring form is read as shoestring');
for (const c of ['health --config config.ini --directory .', 'upgrade --config config.ini --directory . --overrides overrides.ini', 'renew-certificates --config config.ini --directory .', '--help']) ok(risk(`shoestring ${c}`, 'ss', [ss]) === null, `shoestring ${c.split(' ')[0]} → not risky (routine)`);
ok(risk('symbol-bootstrap config', 'other-folder', [bs]) === null, 'a different folder → not flagged');
ok(risk('symbol-bootstrap config', '', [bs]) === null, 'workspace root is not inside bs');
ok(risk('symbol-bootstrap config', '', [{ kind: 'bootstrap', dir: '', composeDir: 'target/docker' }]) === 'symbol-bootstrap config', 'node at the workspace root: root cwd is flagged');
ok(risk('symbol-bootstrap config', 'tools', [{ kind: 'bootstrap', dir: '', composeDir: 'target/docker' }]) === null, 'node at the workspace root: other folders not flagged');
ok(risk('symbol-bootstrap config', 'bsx', [bs]) === null, 'prefix lookalike (bsx) is not bs');
ok(nodeAt('../x', [bs]) === null, 'invalid cwd → no node');
ok(risk('symbol-bootstrap config', 'bs', []) === null, 'no known nodes → nothing flagged');

// --- 本物のエージェントの HTTP
const TOKEN = 'a'.repeat(40);
async function main() {
  const agent = createAgent({ token: TOKEN, workspace: ws, origins: ['null'], resolve: () => null });
  await new Promise<void>((r) => agent.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`;
  const viaAgent = await fetchExistingNodes({ url, token: TOKEN });
  ok(viaAgent.map(key).join() === keys.join(), 'fetchExistingNodes through the real agent', viaAgent.map(key));
  ok((await fetchExistingNodes({ url, token: 'wrong' }).catch((e) => (e as AgentError).kind)) === 'unauthorized', 'wrong token refused');
  const noAuth = await fetch(`${url}/v1/existing-nodes`);
  ok(noAuth.status === 401, 'no token → 401', noAuth.status);
  const body = await (await fetch(`${url}/v1/existing-nodes`, { headers: { Authorization: `Bearer ${TOKEN}` } })).text();
  ok(!body.includes('SECRET-DO-NOT-READ'), 'file contents never appear in the response');
  ok(readFileSync(join(ws, 'bs/target/addresses.yml'), 'utf8') === 'SECRET-DO-NOT-READ', 'scan did not modify files');
  // 既存のノードのフォルダで、画面から実行できる形（compose の場所で docker compose ps -a。許可の判定は、これまでと同じ）
  ok(validateArgv(['docker', 'compose', 'ps', '-a']).ok, 'docker compose ps -a is allowed (same allow-list as before)');
  await agent.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ws2, { recursive: true, force: true });
  console.log(`${checks} checks, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
void main();
