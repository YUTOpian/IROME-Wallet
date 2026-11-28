// ノードの状態ウォッチ: 判定（正常 / 注意 / 異常）・URL の決まり・REST の読み取りを、偽の fetch で確かめる。
// 実行: npx tsx dev-tests/node-watch.test.ts
import { WATCH_LIMITS, changed, evaluate, formatNodeVersion, normalizeWatchUrl, probeNode, trackHeight } from '../src/lib/node/nodeWatch';
import type { WatchSample } from '../src/lib/node/nodeWatch';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

// --- URL
ok(normalizeWatchUrl('http://127.0.0.1:3000/') === 'http://127.0.0.1:3000', 'local http ok, path dropped');
ok(normalizeWatchUrl('localhost:3000') === 'http://localhost:3000', 'bare host gets http');
ok(normalizeWatchUrl('192.168.1.20:3000') === 'http://192.168.1.20:3000', 'LAN http ok');
ok(normalizeWatchUrl('https://node.example.com:3001') === 'https://node.example.com:3001', 'https any host');
ok(normalizeWatchUrl('http://node.example.com:3000') === null, 'public http refused');
ok(normalizeWatchUrl('') === null && normalizeWatchUrl('ftp://x') === null && normalizeWatchUrl('not a url') === null, 'garbage refused');

ok(formatNodeVersion(16777472) === '1.0.1.0' && formatNodeVersion('x') === null, 'version format');

// --- 判定
const T0 = 1_000_000_000;
const base = (o: Partial<WatchSample> = {}): WatchSample => ({
  at: T0, reachable: true, apiNode: 'up', db: 'up', height: 1000, finalizedHeight: 900, finalizationEpoch: 5, name: 'n', version: '1.0.1.0',
  networkIdentifier: 104, peers: 8, refHeight: 1000, refSkipped: false, latencyMs: 20, ...o,
});
const keys = (s: WatchSample, since = s.at) => evaluate(s, s.height === null ? null : { height: s.height, since }).issues.map((i) => `${i.key}:${i.level}`).sort().join(',');
ok(evaluate(base(), { height: 1000, since: T0 }).level === 'ok', 'healthy node is ok');
ok(keys(base({ reachable: false, apiNode: null, db: null, height: null })) === 'unreachable:error', 'unreachable → error only');
ok(keys(base({ apiNode: 'down' })) === 'api_down:error', 'api down');
ok(keys(base({ db: 'down' })) === 'db_down:error', 'db down');
ok(keys(base({ apiNode: null, db: null })) === '', 'health unreadable but chain readable: no false alarm');
ok(keys(base(), T0 - (WATCH_LIMITS.stalledWarnMs - 1)) === '', 'just under the stall limit');
ok(keys(base(), T0 - WATCH_LIMITS.stalledWarnMs) === 'stalled:warn', 'stalled → warn');
ok(keys(base(), T0 - WATCH_LIMITS.stalledErrorMs) === 'stalled:error', 'stalled long → error');
ok(keys(base({ refHeight: 1009 })) === '', 'a few blocks behind is normal');
ok(keys(base({ refHeight: 1010 })) === 'behind:warn', 'behind → warn');
ok(keys(base({ refHeight: 1100 })) === 'behind:error', 'far behind → error');
ok(keys(base({ refHeight: 900 })) === '', 'ahead of the reference is fine');
ok(keys(base({ refHeight: null })) === '', 'no reference → no comparison');
ok(keys(base({ finalizedHeight: 1000 - WATCH_LIMITS.finalizationWarn })) === 'finalization_lag:warn', 'finalization lag → warn');
ok(keys(base({ finalizedHeight: null })) === '', 'no finalization info → no alarm');
ok(keys(base({ peers: 0 })) === 'no_peers:warn', 'no peers → warn');
ok(evaluate(base({ apiNode: 'down', peers: 0 }), { height: 1000, since: T0 }).level === 'error', 'worst level wins');

// --- 高さの追跡
{
  const a = trackHeight(null, base({ at: 10, height: 5 }));
  ok(a?.height === 5 && a.since === 10, 'first height is tracked');
  const b = trackHeight(a, base({ at: 40, height: 5 }));
  ok(b === a, 'same height keeps the old time');
  const c = trackHeight(b, base({ at: 70, height: 6 }));
  ok(c?.height === 6 && c.since === 70, 'new height resets the time');
  const d = trackHeight(c, base({ at: 100, height: 4 }));
  ok(d?.height === 4 && d.since === 100, 'a height that went back counts as a change');
  ok(trackHeight(d, base({ at: 130, height: null, reachable: false })) === d, 'unreadable height keeps the track');
}

// --- 変化の検出
{
  const ev = evaluate(base({ apiNode: 'down' }), null);
  ok(changed(null, ev), 'first result is recorded');
  ok(!changed(ev, evaluate(base({ apiNode: 'down' }), null)), 'same result is not recorded again');
  ok(changed(ev, evaluate(base(), null)), 'recovery is recorded');
  ok(changed(evaluate(base({ peers: 0 }), null), evaluate(base({ db: 'down' }), null)), 'different issue is recorded');
}

// --- REST の読み取り（偽の fetch）
const fake = (routes: Record<string, unknown | 'fail'>) => async (url: string) => {
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  const v = routes[path];
  if (v === undefined || v === 'fail') return { ok: false, json: async () => ({}) };
  return { ok: true, json: async () => v };
};
const good = {
  '/node/health': { status: { apiNode: 'up', db: 'up' } },
  '/chain/info': { height: '123456', latestFinalizedBlock: { height: '123000', finalizationEpoch: 171 } },
  '/node/info': { friendlyName: 'my-node', version: 16777472, networkIdentifier: 152 },
  '/node/peers': [{}, {}, {}],
};
async function main() {
  {
    const s = await probeNode('http://127.0.0.1:3000', { fetchImpl: fake(good), ref: async () => ({ height: 123460, networkIdentifier: 152 }) });
    ok(s.reachable && s.apiNode === 'up' && s.db === 'up' && s.height === 123456 && s.finalizedHeight === 123000 && s.finalizationEpoch === 171, 'chain fields read', s);
    ok(s.name === 'my-node' && s.version === '1.0.1.0' && s.networkIdentifier === 152 && s.peers === 3, 'info fields read', s);
    ok(s.refHeight === 123460 && !s.refSkipped, 'reference height used when the network matches', s);
  }
  {
    const s = await probeNode('http://127.0.0.1:3000', { fetchImpl: fake(good), ref: async () => ({ height: 5, networkIdentifier: 104 }) });
    ok(s.refHeight === null && s.refSkipped, 'different network: not compared', s);
  }
  {
    const s = await probeNode('http://127.0.0.1:3000', { fetchImpl: fake(good), ref: async () => { throw new Error('offline'); } });
    ok(s.reachable && s.refHeight === null && !s.refSkipped, 'reference failure does not break the watch', s);
  }
  {
    const s = await probeNode('http://127.0.0.1:3000', { fetchImpl: fake({}) });
    ok(!s.reachable && s.height === null && s.peers === null, 'nothing answers → unreachable', s);
  }
  {
    const s = await probeNode('http://127.0.0.1:3000', { fetchImpl: fake({ ...good, '/node/health': 'fail', '/node/peers': 'fail' }) });
    ok(s.reachable && s.apiNode === null && s.height === 123456 && s.peers === null, 'partial answers still count as reachable', s);
  }
  {
    const s = await probeNode('http://127.0.0.1:3000', { fetchImpl: fake({ ...good, '/chain/info': { height: 'abc', latestFinalizedBlock: { height: {} } } }) });
    ok(s.height === null && s.finalizedHeight === null, 'garbage numbers are ignored', s);
  }
  {
    // 応答しない相手は、タイムアウトで切る
    const hang = (_url: string, init?: { signal?: AbortSignal }) => new Promise<never>((_r, rej) => { init?.signal?.addEventListener('abort', () => rej(new Error('abort'))); });
    const t0 = Date.now();
    const s = await probeNode('http://127.0.0.1:3000', { fetchImpl: hang, timeoutMs: 80 });
    ok(!s.reachable && Date.now() - t0 < 2000, 'hanging node is cut off by the timeout', s);
  }
  console.log(`${checks} checks, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
void main();
