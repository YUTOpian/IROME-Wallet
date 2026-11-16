// ノードの自動再起動: いつ動かすか（対象・2 回続けて・間隔・回数の上限・戻ったら数え直し）と、流すコマンドが許可リストを通ることを確かめる。
// 実行: npx tsx dev-tests/node-auto-restart.test.ts
import { AUTO_RESTART_LIMITS as L, AUTO_RESTART_LINE, decideRestart, initialRestartState, restartReason } from '../src/lib/node/nodeAutoRestart';
import type { RestartState } from '../src/lib/node/nodeAutoRestart';
import { parseCommandLine } from '../src/lib/node/nodeCommands';
import type { WatchIssue } from '../src/lib/node/nodeWatch';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const err = (key: WatchIssue['key']): WatchIssue[] => [{ key, level: 'error' }];
const warn = (key: WatchIssue['key']): WatchIssue[] => [{ key, level: 'warn' }];

// --- 流すコマンドは、エージェントの許可リストを通る（docker compose restart・対象の指定なし）
const parsed = parseCommandLine(AUTO_RESTART_LINE);
ok(parsed.ok && parsed.tool === 'docker' && parsed.argv.join(' ') === 'docker compose restart', 'restart line passes the allowlist', parsed);

// --- 対象の判定
ok(restartReason(err('stalled')) === 'stalled', 'stalled error → target');
ok(restartReason(err('api_down')) === 'api_down' && restartReason(err('db_down')) === 'db_down' && restartReason(err('unreachable')) === 'unreachable', 'api/db/unreachable → target');
ok(restartReason(warn('stalled')) === null, 'stalled warn → not yet');
ok(restartReason(warn('behind')) === null && restartReason(err('behind')) === null && restartReason(warn('no_peers')) === null, 'behind / no_peers → never');
ok(restartReason(err('disk_low')) === null && restartReason(err('cert_expiring')) === null && restartReason(err('cpu_high')) === null && restartReason(err('mem_low')) === null, 'host problems → never (a restart does not fix them)');
ok(restartReason([]) === null, 'no issues');

// --- 止まり: すぐ動かす
let d = decideRestart(initialRestartState(), err('stalled'), 1000);
ok(d.action === 'restart' && d.state.attempts === 1 && d.state.lastAt === 1000, 'stalled → restart at once', d);

// --- 落ちている: 2 回続けて
d = decideRestart(initialRestartState(), err('api_down'), 1000);
ok(d.action === 'none' && d.state.bad === 1, 'api_down 1st round → wait', d);
d = decideRestart(d.state, err('api_down'), 31_000);
ok(d.action === 'restart' && d.state.attempts === 1, 'api_down 2nd round → restart', d);
// 1 回見えて、戻ったら数え直し
d = decideRestart(initialRestartState(), err('unreachable'), 0);
d = decideRestart(d.state, [], 30_000);
ok(d.state.bad === 0 && d.action === 'none', 'recovered → count resets');
d = decideRestart(d.state, err('unreachable'), 60_000);
ok(d.action === 'none', 'after reset needs 2 again');

// --- 間隔: 10 分は動かさない
const after: RestartState = { bad: 0, attempts: 1, lastAt: 0, gaveUp: false };
d = decideRestart(after, err('stalled'), L.cooldownMs - 1);
ok(d.action === 'none', 'inside cooldown → no restart', d);
d = decideRestart(after, err('stalled'), L.cooldownMs);
ok(d.action === 'restart' && d.state.attempts === 2, 'cooldown over → restart', d);

// --- 回数の上限: 3 回で、あきらめて 1 回だけ知らせる
let s: RestartState = { bad: 0, attempts: L.maxAttempts, lastAt: 0, gaveUp: false };
d = decideRestart(s, err('stalled'), L.cooldownMs * 5);
ok(d.action === 'gave_up' && d.state.gaveUp, 'max attempts → gave up', d);
d = decideRestart(d.state, err('stalled'), L.cooldownMs * 6);
ok(d.action === 'none', 'gave up is announced once', d);
// 正常に戻ったら、回数は 0 に戻る
d = decideRestart(d.state, [], L.cooldownMs * 7);
ok(d.state.attempts === 0 && !d.state.gaveUp && d.state.lastAt === null, 'healthy → everything resets', d);

// --- 注意だけの間は、何もしない（数え直しもしない問題ではないので bad は 0）
s = { bad: 1, attempts: 1, lastAt: 5, gaveUp: false };
d = decideRestart(s, warn('stalled'), 99);
ok(d.action === 'none' && d.state.bad === 0, 'warn only → nothing');

// --- 通常の流れ: 3 回直らない→止まる
s = initialRestartState();
let n = 0, t = 0;
for (let i = 0; i < 200; i++) {
  t += 30_000;
  const r = decideRestart(s, err('stalled'), t);
  s = r.state;
  if (r.action === 'restart') n++;
}
ok(n === L.maxAttempts, 'a node that never recovers is restarted exactly maxAttempts times', n);

console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
