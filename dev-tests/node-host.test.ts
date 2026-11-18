// ノードを動かしている PC の状態（ディスク・CPU・メモリ・証明書の期限）: 判定のしきい値・受け取りの検証・証明書の読み取り・エージェントの HTTP。
// 実行: npx tsx dev-tests/node-host.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { evaluateHost, sanitizeHostStats, HOST_LIMITS } from '../src/lib/node/nodeHost';
import type { HostStats } from '../src/lib/node/nodeHost';
import { collectHostStats, readCerts } from '../src/server/node-agent/host';
import { createAgent } from '../src/server/node-agent/agent';
import { AgentError, fetchHostStats } from '../src/lib/node/agentClient';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const DAY = 86_400_000, GB = 1024 ** 3, NOW = Date.UTC(2026, 10, 15);
const base = (o: Partial<HostStats> = {}): HostStats => ({
  at: NOW,
  disk: { path: '/w', totalBytes: 100 * GB, freeBytes: 50 * GB },
  cpu: { cores: 4, usagePct: 20, load1: 0.5 },
  memory: { totalBytes: 8 * GB, availableBytes: 4 * GB },
  certs: [{ path: 'target/nodes/node/cert/node.crt.pem', subject: 'node', notAfter: NOW + 200 * DAY }],
  ...o,
});
const keys = (h: HostStats) => evaluateHost(h).map((i) => `${i.key}:${i.level}`).join(',');

// --- 判定
ok(keys(base()) === '', 'healthy host → no issues');
ok(keys(base({ disk: { path: '/w', totalBytes: 100 * GB, freeBytes: 14 * GB } })) === 'disk_low:warn', 'disk 14% free → warn');
ok(keys(base({ disk: { path: '/w', totalBytes: 100 * GB, freeBytes: 15 * GB } })) === '', 'disk 15% free → ok (boundary)');
ok(keys(base({ disk: { path: '/w', totalBytes: 100 * GB, freeBytes: 4 * GB } })) === 'disk_low:error', 'disk 4% free → error');
ok(keys(base({ cpu: { cores: 4, usagePct: 90, load1: 1 } })) === 'cpu_high:warn', 'cpu 90% → warn');
ok(keys(base({ cpu: { cores: 4, usagePct: 99, load1: 1 } })) === 'cpu_high:error', 'cpu 99% → error');
ok(keys(base({ cpu: { cores: 4, usagePct: null, load1: null } })) === '', 'cpu unknown → no issue');
ok(keys(base({ memory: { totalBytes: 8 * GB, availableBytes: 0.7 * GB } })) === 'mem_low:warn', 'mem 8.7% → warn');
ok(keys(base({ memory: { totalBytes: 8 * GB, availableBytes: 0.2 * GB } })) === 'mem_low:error', 'mem 2.5% → error');
ok(keys(base({ certs: [{ path: 'a', subject: 'a', notAfter: NOW + 29 * DAY }] })) === 'cert_expiring:warn', 'cert 29 days → warn');
ok(keys(base({ certs: [{ path: 'a', subject: 'a', notAfter: NOW + 6 * DAY }] })) === 'cert_expiring:error', 'cert 6 days → error');
ok(keys(base({ certs: [{ path: 'a', subject: 'a', notAfter: NOW - DAY }] })) === 'cert_expiring:error', 'expired cert → error');
{
  const i = evaluateHost(base({ certs: [{ path: 'a', subject: 'a', notAfter: NOW + 200 * DAY }, { path: 'b', subject: 'b', notAfter: NOW + 10 * DAY }] }));
  ok(i.length === 1 && i[0].level === 'warn' && i[0].n === 10, 'soonest cert decides', i);
}
ok(keys(base({ disk: null, cpu: null, memory: null, certs: [] })) === '', 'nothing readable → no issues');
ok(HOST_LIMITS.diskFreeErrorPct < HOST_LIMITS.diskFreeWarnPct && HOST_LIMITS.certErrorDays < HOST_LIMITS.certWarnDays, 'thresholds ordered');

// --- 受け取りの検証
ok(sanitizeHostStats(null) === null && sanitizeHostStats('x') === null && sanitizeHostStats({}) === null, 'garbage → null');
{
  const s = sanitizeHostStats({ ...base(), secret: 'x', disk: { path: '/w', totalBytes: 10, freeBytes: 20 }, cpu: { cores: 0, usagePct: 150, load1: -1 }, memory: { totalBytes: 0, availableBytes: 0 }, certs: [{ path: 'a', subject: 'b\nc', notAfter: NOW, privateKey: 'k' }, { path: 'bad', notAfter: 'x' }] });
  ok(s !== null && s.disk === null && s.cpu === null && s.memory === null, 'out-of-range values dropped', s);
  ok(s !== null && s.certs.length === 1 && !('privateKey' in s.certs[0]) && !s.certs[0].subject.includes('\n') && !('secret' in s), 'unknown fields and control chars dropped', s);
}
ok((sanitizeHostStats({ ...base(), certs: Array.from({ length: 50 }, (_, i) => ({ path: `p${i}`, subject: 's', notAfter: NOW })) })?.certs.length ?? 0) === 20, 'certs capped at 20');

// --- 本物の読み取り
const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const ws = mkdtempSync(join(tmpdir(), 'irome-host-'));
async function main() {
  const h = await collectHostStats(ws);
  ok(h.disk !== null && h.disk.totalBytes > 0 && h.disk.freeBytes <= h.disk.totalBytes, 'real disk numbers', h.disk);
  ok(h.cpu !== null && h.cpu.cores >= 1 && (h.cpu.usagePct === null || (h.cpu.usagePct >= 0 && h.cpu.usagePct <= 100)), 'real cpu numbers', h.cpu);
  ok(h.memory !== null && h.memory.availableBytes <= h.memory.totalBytes && h.memory.totalBytes > 0, 'real memory numbers', h.memory);
  ok(Array.isArray(h.certs) && h.certs.length === 0, 'no certs in an empty workspace');
  ok(sanitizeHostStats(JSON.parse(JSON.stringify(h))) !== null, 'collected stats pass the client check');

  if (hasOpenssl) {
    const dir = join(ws, 'target', 'nodes', 'node', 'cert');
    mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'node.key.pem'), '-out', join(dir, 'node.crt.pem'), '-days', '20', '-subj', '/CN=my-test-node'], { stdio: 'ignore' });
    // 鍵と証明書が同じファイルに入っているものも、証明書のブロックだけを読む
    execFileSync('sh', ['-c', `cat "${join(dir, 'node.key.pem')}" "${join(dir, 'node.crt.pem')}" > "${join(dir, 'node.full.crt.pem')}"`]);
    // 外・tools/・シンボリックリンクの中は見ない
    mkdirSync(join(ws, 'tools', 'x'), { recursive: true });
    execFileSync('cp', [join(dir, 'node.crt.pem'), join(ws, 'tools', 'x', 'evil.crt.pem')]);
    const outside = mkdtempSync(join(tmpdir(), 'irome-host-out-'));
    execFileSync('cp', [join(dir, 'node.crt.pem'), join(outside, 'o.crt.pem')]);
    symlinkSync(outside, join(ws, 'link'));
    writeFileSync(join(ws, 'broken.crt.pem'), 'not a cert');
    const certs = readCerts(ws);
    const paths = certs.map((c) => c.path).sort();
    ok(paths.join(',') === 'target/nodes/node/cert/node.crt.pem,target/nodes/node/cert/node.full.crt.pem', 'only certs inside the workspace (not tools/, symlinks, broken, or *.key.pem)', paths);
    const d = (certs[0].notAfter - Date.now()) / DAY;
    ok(d > 18 && d < 21 && certs[0].subject === 'my-test-node', 'expiry and CN read', { d, s: certs[0].subject });
    ok(!JSON.stringify(certs).includes('PRIVATE KEY'), 'no key material in the result');
    ok(keys({ ...base(), certs }) === 'cert_expiring:warn', 'a 20-day cert is a warning');
    rmSync(outside, { recursive: true, force: true });
  } else console.log('(openssl not available: certificate parsing tests skipped)');

  // --- エージェントの HTTP
  const TOKEN = 't'.repeat(40);
  const agent = createAgent({ token: TOKEN, workspace: ws, origins: ['null'], resolve: () => null });
  await new Promise<void>((r) => agent.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`;
  const stats = await fetchHostStats({ url, token: TOKEN });
  ok(stats !== null && stats.disk !== null && stats.memory !== null, 'fetchHostStats through the real agent', stats);
  if (hasOpenssl) ok((stats?.certs.length ?? 0) === 2, 'certs come through the agent', stats?.certs);
  ok((await fetchHostStats({ url, token: 'wrong' }).catch((e) => (e as AgentError).kind)) === 'unauthorized', 'wrong token refused');
  const noAuth = await fetch(`${url}/v1/host`);
  ok(noAuth.status === 401, 'no token → 401', noAuth.status);
  await agent.close();
  rmSync(ws, { recursive: true, force: true });
  console.log(`${checks} checks, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
void main();
