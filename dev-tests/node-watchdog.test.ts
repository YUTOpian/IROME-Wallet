// エージェントの常駐ウォッチドッグ: 設定の検証・巡回と再起動の決まり・保存と復元・エージェントの HTTP を確かめる。
// 実行: npx tsx dev-tests/node-watchdog.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { normalizeNotifyUrl, sanitizeComposeDirs, sanitizeWatchdogConfig, sanitizeWatchdogSnapshot } from '../src/lib/node/nodeWatchdog';
import type { WatchdogConfig } from '../src/lib/node/nodeWatchdog';
import { AUTO_RESTART_LIMITS as L } from '../src/lib/node/nodeAutoRestart';
import type { WatchSample } from '../src/lib/node/nodeWatch';
import { WATCHDOG_FILE, createWatchdog, notifyText, readWatchdogFile } from '../src/server/node-agent/watchdog';
import type { RestartResult } from '../src/server/node-agent/watchdog';
import { createAgent } from '../src/server/node-agent/agent';
import { findComposeDirs } from '../src/server/node-agent/composeDirs';
import { AgentError, fetchComposeDirs, fetchWatchdog, saveWatchdog } from '../src/lib/node/agentClient';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const cfg = (o: Partial<WatchdogConfig> = {}): WatchdogConfig => ({ enabled: true, url: 'http://127.0.0.1:3000', dir: '', intervalSec: 60, ...o });

// --- 設定の検証
ok(sanitizeWatchdogConfig(cfg()).ok, 'valid config');
const norm = sanitizeWatchdogConfig(cfg({ url: 'http://127.0.0.1:3000/', dir: 'target/docker/' }));
ok(norm.ok && norm.config.url === 'http://127.0.0.1:3000' && norm.config.dir === 'target/docker', 'url / dir are normalized', norm);
const rj = (o: unknown) => { const r = sanitizeWatchdogConfig(o); return r.ok ? 'ok' : r.reason; };
ok(rj(cfg({ url: 'http://example.com:3000' })) === 'bad_url', 'public http refused');
ok(rj(cfg({ dir: '../x' })) === 'bad_dir' && rj(cfg({ dir: '/etc' })) === 'bad_dir', 'dir outside the workspace refused');
ok(rj(cfg({ intervalSec: 1 })) === 'bad_interval', 'interval must be a listed one');
ok(rj({ ...cfg(), line: 'rm -rf /' }) === 'bad_config', 'unknown field (a command) refused');
ok(rj({ enabled: 'yes', url: 'http://127.0.0.1:3000', dir: '', intervalSec: 60 }) === 'bad_config' && rj(null) === 'bad_config' && rj([]) === 'bad_config', 'wrong types refused');
ok(sanitizeWatchdogSnapshot({ config: cfg(), notify: { set: false, host: '' }, running: true, lastCheckAt: 1, level: 'ok', issues: ['stalled', 'x y'], attempts: 1, gaveUp: false, log: [{ at: 1, kind: 'restart_ok', reason: 'stalled' }, { at: 2, kind: 'evil' }, { at: 3, kind: 'gave_up', reason: '<script>' }] })?.log.length === 2, 'snapshot: bad log entries dropped');
ok(sanitizeWatchdogSnapshot({ config: { enabled: true } }) === null, 'snapshot: broken config → null');

// --- 巡回と再起動
const dir = mkdtempSync(join(tmpdir(), 'wd-'));
let t = 1_000_000;
const sample = (o: Partial<WatchSample> = {}): WatchSample => ({ at: t, reachable: true, apiNode: 'up', db: 'up', height: 100, finalizedHeight: 90, finalizationEpoch: 1, name: 'n', version: '1', networkIdentifier: 152, peers: 3, refHeight: null, refSkipped: false, latencyMs: 5, ...o });
let mode: 'ok' | 'stuck' | 'down' = 'ok';
let h = 100;
const probe = async (): Promise<WatchSample> => {
  if (mode === 'down') return sample({ reachable: false, apiNode: null, db: null, height: null, finalizedHeight: null, peers: null, name: null });
  if (mode === 'ok') h += 1;
  return sample({ height: h });
};
let restarts: string[] = [];
let result: RestartResult = 'ok';
const wd = createWatchdog({ workspace: dir, restart: async (d) => { restarts.push(d); return result; }, probe, now: () => t });
const step = async (ms = 30_000) => { t += ms; await wd.tick(); };

ok(wd.snapshot().running === false && !wd.snapshot().config.enabled, 'starts disabled');
wd.configure(cfg({ dir: 'target/docker' }));
await new Promise((r) => setTimeout(r, 20)); // configure の最初の巡回
ok(wd.snapshot().running && wd.snapshot().config.dir === 'target/docker', 'enabled → running');
ok(restarts.length === 0 && wd.snapshot().level === 'ok', 'healthy → no restart');

mode = 'stuck';
await step(); // 止まり始め（高さが変わらない）
for (let i = 0; i < 18; i++) await step(); // 10 分に届くまで（最後に正常だった時刻から数える）
ok(restarts.length === 0, 'stuck under 10 min → no restart', restarts.length);
await step();
ok(restarts.length === 1 && restarts[0] === 'target/docker', 'stalled ≥ 10 min → restart once, in the configured dir', restarts);
ok(wd.snapshot().log[0].kind === 'restart_ok' && wd.snapshot().log[0].reason === 'stalled', 'logged', wd.snapshot().log);
for (let i = 0; i < 10; i++) await step();
ok(restarts.length === 1, 'cooldown: not restarted again within 10 min', restarts.length);

// 直った: 高さが動く → recovered
mode = 'ok';
await step();
ok(wd.snapshot().level === 'ok' && wd.snapshot().log[0].kind === 'recovered' && wd.snapshot().attempts === 0, 'recovered logged, counter reset', wd.snapshot());

// 落ちている: 2 回続けて
mode = 'down'; restarts = [];
await step();
ok(restarts.length === 0, 'down once → wait');
await step();
ok(restarts.length === 1, 'down twice → restart', restarts.length);

// 直らないまま: 上限で止まる
for (let i = 0; i < 300; i++) await step();
ok(restarts.length === L.maxAttempts, 'never recovers → exactly maxAttempts restarts', restarts.length);
ok(wd.snapshot().gaveUp && wd.snapshot().log.filter((e) => e.kind === 'gave_up').length === 1, 'gave up, announced once', wd.snapshot().log.map((e) => e.kind));

// busy: 回数に数えず、再試行
mode = 'ok'; await step(); // 戻す
mode = 'down'; restarts = []; result = 'busy';
await step(); await step();
ok(wd.snapshot().attempts === 0 && wd.snapshot().log[0].kind === 'restart_busy', 'busy: not counted', wd.snapshot());
result = 'ok';
await step();
ok(restarts.length === 2 && wd.snapshot().attempts === 1, 'busy: retried next round', restarts.length);

// 止める
wd.configure(cfg({ enabled: false }));
ok(!wd.snapshot().running, 'disabled → stopped');
wd.close();

// --- 通知先の Webhook
ok(normalizeNotifyUrl('https://hooks.slack.com/services/T000/B000/XXXX') !== null, 'https webhook ok');
for (const bad of ['http://hooks.slack.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://192.168.1.5/x', 'https://nas/x', 'https://printer.local/x', 'https://a.internal/x', 'https://[::1]/x', 'https://user:pw@example.com/x', 'https://example.com/x#frag', 'ftp://example.com', '', 'https://' + 'a'.repeat(600) + '.com'])
  ok(normalizeNotifyUrl(bad) === null, `notify url refused: ${bad.slice(0, 40)}`);
ok(rj(cfg({ notifyUrl: 'http://x.example.com' })) === 'bad_notify' && rj(cfg({ notifyUrl: 'https://hooks.example.com/a' })) === 'ok' && rj(cfg({ notifyUrl: '' })) === 'ok', 'config: notifyUrl validated');
ok(sanitizeWatchdogSnapshot({ config: cfg({ notifyUrl: 'https://hooks.example.com/secret' }), notify: { set: true, host: 'hooks.example.com' }, running: true, issues: [], log: [] }) === null, 'snapshot never carries the webhook URL');
const tx = notifyText('gave_up', 'http://127.0.0.1:3000')!;
ok(tx.includes('127.0.0.1:3000') && !tx.includes('http://') && notifyText('started', 'http://x:1') === null && notifyText('restart_busy', 'http://x:1') === null, 'notify text: host only, no noise events', tx);

{
  const d3 = mkdtempSync(join(tmpdir(), 'wd-n-'));
  const sent: Array<{ url: string; body: string; redirect: string }> = [];
  let netFail = false;
  let t3 = 5_000_000;
  let h3 = 1;
  const stuckProbe = async (): Promise<WatchSample> => ({ ...sample({ height: h3 }), at: t3 });
  const w = createWatchdog({
    workspace: d3, restart: async () => 'ok', probe: stuckProbe, now: () => t3,
    fetchImpl: async (url, init) => { if (netFail) throw new Error('net'); sent.push({ url, body: init.body, redirect: init.redirect }); return { ok: true }; },
  });
  w.configure(cfg({ notifyUrl: 'https://hooks.example.com/services/SECRET' }));
  await new Promise((r) => setTimeout(r, 20));
  const sn = JSON.stringify(w.snapshot());
  ok(!sn.includes('SECRET') && w.snapshot().notify.set && w.snapshot().notify.host === 'hooks.example.com', 'snapshot masks the webhook', sn);
  ok(JSON.parse(readFileSync(join(d3, WATCHDOG_FILE), 'utf8')).notifyUrl === 'https://hooks.example.com/services/SECRET', 'webhook saved in the (600) file');
  for (let i = 0; i < 22; i++) { t3 += 30_000; await w.tick(); }
  await new Promise((r) => setTimeout(r, 20));
  ok(sent.length === 1 && sent[0].url.endsWith('/SECRET') && sent[0].redirect === 'error', 'restart → one notification (no redirects)', sent.length);
  const body = JSON.parse(sent[0].body) as { text: string; content: string };
  ok(body.text === body.content && body.text.includes('再起動しました'), 'payload carries text and content', body);
  // 省略 = 残す / 空 = 消す
  w.configure(cfg({ intervalSec: 120 }));
  ok(w.snapshot().notify.set, 'omitted notifyUrl keeps the current one');
  w.configure(cfg({ notifyUrl: '' }));
  ok(!w.snapshot().notify.set && JSON.parse(readFileSync(join(d3, WATCHDOG_FILE), 'utf8')).notifyUrl === undefined, 'empty notifyUrl clears it');
  // 失敗しても見張りは続く
  w.configure(cfg({ notifyUrl: 'https://hooks.example.com/x' }));
  await new Promise((r) => setTimeout(r, 20));
  netFail = true; h3 += 0;
  for (let i = 0; i < 22; i++) { t3 += 30_000; await w.tick(); }
  await new Promise((r) => setTimeout(r, 20));
  ok(w.snapshot().log.some((e) => e.kind === 'notify_failed') && w.snapshot().running, 'notify failure is logged; watching continues', w.snapshot().log.map((e) => e.kind));
  w.close(); rmSync(d3, { recursive: true, force: true });
}

// --- 作業フォルダの自動検出
{
  const d4 = mkdtempSync(join(tmpdir(), 'wd-c-'));
  mkdirSync(join(d4, 'target', 'docker'), { recursive: true });
  writeFileSync(join(d4, 'target', 'docker', 'docker-compose.yml'), 'services: {}');
  mkdirSync(join(d4, 'shoestring'), { recursive: true });
  writeFileSync(join(d4, 'shoestring', 'docker-compose.yaml'), 'services: {}');
  writeFileSync(join(d4, 'shoestring', 'docker-compose-recovery.yaml'), 'services: {}');
  mkdirSync(join(d4, 'tools', 'x'), { recursive: true }); writeFileSync(join(d4, 'tools', 'x', 'compose.yml'), '');
  mkdirSync(join(d4, 'node_modules', 'y'), { recursive: true }); writeFileSync(join(d4, 'node_modules', 'y', 'compose.yml'), '');
  mkdirSync(join(d4, '.hidden'), { recursive: true }); writeFileSync(join(d4, '.hidden', 'compose.yml'), '');
  mkdirSync(join(d4, 'a', 'b', 'c', 'd', 'e'), { recursive: true }); writeFileSync(join(d4, 'a', 'b', 'c', 'd', 'e', 'compose.yml'), '');
  mkdirSync(join(d4, 'dirnamed'), { recursive: true }); mkdirSync(join(d4, 'dirnamed', 'compose.yml'));
  if (process.platform !== 'win32') { try { symlinkSync('/etc', join(d4, 'link')); } catch { /* ignore */ } }
  const found = findComposeDirs(d4);
  ok(found.join(',') === 'shoestring,target/docker', 'compose dirs: only real ones (no tools/, node_modules, dot dirs, too deep, recovery file, links)', found);
  writeFileSync(join(d4, 'compose.yaml'), '');
  ok(findComposeDirs(d4)[0] === '', 'compose file in the workspace root → ""');
  ok(sanitizeComposeDirs({ dirs: ['a/b', '../x', '/etc', 5, 'a/b', ''] }).join('|') === 'a/b|', 'client re-validates the dirs', sanitizeComposeDirs({ dirs: ['a/b', '../x', '/etc', 5, 'a/b', ''] }));
  rmSync(d4, { recursive: true, force: true });
}

// --- 保存と復元
const file = join(dir, WATCHDOG_FILE);
ok(existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).enabled === false, 'config saved');
if (process.platform !== 'win32') ok((statSync(file).mode & 0o077) === 0, 'saved with mode 600');
wd.configure(cfg({ intervalSec: 120, dir: 'a/b' })); wd.close();
const back = readWatchdogFile(dir);
ok(back.intervalSec === 120 && back.dir === 'a/b' && back.enabled, 'config restored', back);
writeFileSync(file, JSON.stringify({ enabled: true, url: 'http://evil.example.com', dir: '..', intervalSec: 60 }));
ok(!readWatchdogFile(dir).enabled, 'tampered file → defaults (disabled)');
writeFileSync(file, '{ not json');
ok(!readWatchdogFile(dir).enabled, 'broken file → defaults');

// --- エージェントの HTTP（本物のサーバーで）
const ws2 = mkdtempSync(join(tmpdir(), 'wd-agent-'));
const token = 'x'.repeat(40);
const agent = createAgent({ token, workspace: ws2, origins: [], watchdogProbe: async () => sample({ height: 5 }) });
await new Promise<void>((r) => agent.server.listen(0, '127.0.0.1', r));
const conn = { url: `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`, token };
const snap0 = await fetchWatchdog(conn);
ok(snap0 !== null && !snap0.config.enabled && !snap0.running, 'GET /v1/watchdog: default disabled', snap0);
const snap1 = await saveWatchdog(conn, cfg({ dir: 'target/docker', intervalSec: 300 }));
ok(snap1 !== null && snap1.config.enabled && snap1.running && snap1.config.dir === 'target/docker', 'PUT starts it', snap1);
ok(existsSync(join(ws2, WATCHDOG_FILE)), 'PUT saved the file');
let rej = '';
try { await saveWatchdog(conn, cfg({ dir: '../x' })); } catch (e) { rej = e instanceof AgentError ? `${e.kind}:${e.reason}` : 'other'; }
ok(rej === 'rejected:bad_dir', 'PUT with a bad dir is refused', rej);
let unauth = '';
try { await fetchWatchdog({ ...conn, token: 'y'.repeat(40) }); } catch (e) { unauth = e instanceof AgentError ? e.kind : 'other'; }
ok(unauth === 'unauthorized', 'needs the token', unauth);
const raw = await fetch(`${conn.url}/v1/watchdog`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cfg(), line: 'rm -rf /' }) });
ok(raw.status === 400, 'extra field (a command) → 400', raw.status);
const cd = await fetchComposeDirs(conn);
ok(Array.isArray(cd) && cd.length === 0, 'GET /v1/compose-dirs (empty workspace)', cd);
const raw2 = await fetch(`${conn.url}/v1/watchdog`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cfg(), notifyUrl: 'http://evil.example.com' }) });
ok(raw2.status === 400, 'http webhook → 400', raw2.status);
const withN = await saveWatchdog(conn, cfg({ notifyUrl: 'https://hooks.example.com/SECRETX' }));
ok(withN !== null && withN.notify.set && !JSON.stringify(withN).includes('SECRETX'), 'PUT notifyUrl: response masks it', withN);
const again = await fetchWatchdog(conn);
ok(again !== null && again.notify.set && !JSON.stringify(again).includes('SECRETX'), 'GET never returns the webhook URL');
await saveWatchdog(conn, cfg({ enabled: false }));
await agent.close();
// 再起動したエージェントが、保存した設定で始める
writeFileSync(join(ws2, WATCHDOG_FILE), JSON.stringify(cfg({ intervalSec: 300 })));
const agent2 = createAgent({ token, workspace: ws2, origins: [], watchdogProbe: async () => sample({ height: 5 }) });
await new Promise<void>((r) => agent2.server.listen(0, '127.0.0.1', r));
const conn2 = { url: `http://127.0.0.1:${(agent2.server.address() as AddressInfo).port}`, token };
const s2 = await fetchWatchdog(conn2);
ok(s2 !== null && s2.running && s2.config.enabled, 'agent restart → watchdog resumes from the saved file', s2);
await agent2.close();

rmSync(dir, { recursive: true, force: true });
rmSync(ws2, { recursive: true, force: true });
console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
