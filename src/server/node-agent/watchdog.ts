// エージェントの常駐ウォッチドッグ: 画面を閉じていても、ノードの REST を一定間隔で見て、止まっている・落ちているときに、決まりに沿って再起動する。
// 判定は、画面のウォッチ（lib/node/nodeWatch.ts）と、自動再起動の決まり（lib/node/nodeAutoRestart.ts）をそのまま使う（暴走させない決まりも同じ）。
// 設定は作業場所の `.irome-watchdog.json`（権限 600）に保存し、エージェントを再起動しても続く（読むときも、毎回 sanitize を通す）。
// 再起動するコマンドは固定（`docker compose restart`）。実際に流すのは agent.ts が渡す関数で、許可リストを通る。
import { chmodSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, probeNode, trackHeight } from '../../lib/node/nodeWatch';
import type { HeightTrack, WatchSample } from '../../lib/node/nodeWatch';
import { decideRestart, initialRestartState } from '../../lib/node/nodeAutoRestart';
import type { RestartState } from '../../lib/node/nodeAutoRestart';
import { DEFAULT_WATCHDOG, sanitizeWatchdogConfig } from '../../lib/node/nodeWatchdog';
import type { WatchdogConfig, WatchdogLog, WatchdogSnapshot, WatchdogLogKind } from '../../lib/node/nodeWatchdog';
import type { WatchLevel } from '../../lib/node/nodeWatch';

export const WATCHDOG_FILE = '.irome-watchdog.json';
const MAX_LOG = 50;

export type RestartResult = 'ok' | 'failed' | 'busy';
export interface WatchdogDeps {
  workspace: string;
  /** compose のあるフォルダ（作業場所からの相対）で、`docker compose restart` を流して終わるのを待つ。 */
  restart: (dir: string) => Promise<RestartResult>;
  /** 1 回見る（試験用に差し替える）。 */
  probe?: (base: string) => Promise<WatchSample>;
  now?: () => number;
  /** 設定を保存しない（試験用）。 */
  persist?: boolean;
  /** 通知の送信に使う fetch（試験用に差し替える。省略は組み込みの fetch）。 */
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' }) => Promise<{ ok: boolean }>;
}

export interface Watchdog {
  snapshot(): WatchdogSnapshot;
  /** 設定を入れ替えて保存する。enabled なら巡回を（再）開、そうでなければ止める。 */
  configure(config: WatchdogConfig): void;
  /** 1 回だけ巡回する（タイマーからも、試験からも呼ぶ）。 */
  tick(): Promise<void>;
  /** 保存済みの設定を読み、enabled なら始める。 */
  load(): void;
  close(): void;
}

const publicConfig = (c: WatchdogConfig) => ({ enabled: c.enabled, url: c.url, dir: c.dir, intervalSec: c.intervalSec });

export function readWatchdogFile(workspace: string): WatchdogConfig {
  const p = join(workspace, WATCHDOG_FILE);
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile() || st.size > 4096) return { ...DEFAULT_WATCHDOG };
    const r = sanitizeWatchdogConfig(JSON.parse(readFileSync(p, 'utf8')));
    return r.ok ? r.config : { ...DEFAULT_WATCHDOG };
  } catch { return { ...DEFAULT_WATCHDOG }; }
}

const NOTIFY_TIMEOUT_MS = 8000;
const REASON_TEXT: Record<string, string> = { stalled: 'ブロックが止まっています', api_down: 'API が落ちています', db_down: 'DB が落ちています', unreachable: 'REST に繋がりません' };
const hostOf = (u: string): string => { try { return new URL(u).host; } catch { return ''; } };

/** 通知の本文（短く。URL の本体・作業場所のパス・鍵などは入れない）。 */
export function notifyText(kind: WatchdogLogKind, watchedUrl: string, reason?: string): string | null {
  const node = hostOf(watchedUrl) || 'node';
  const why = reason && REASON_TEXT[reason] ? `（${REASON_TEXT[reason]}）` : '';
  switch (kind) {
    case 'restart_ok': return `[IROME] ${node}: 再起動しました${why}`;
    case 'restart_failed': return `[IROME] ${node}: 再起動に失敗しました${why}`;
    case 'gave_up': return `[IROME] ${node}: 再起動しても直らないため、自動の再起動をやめました。手で確認してください。`;
    case 'recovered': return `[IROME] ${node}: 正常に戻りました`;
    default: return null;
  }
}

export function createWatchdog(deps: WatchdogDeps): Watchdog {
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? ((base: string) => probeNode(base));
  let config: WatchdogConfig = { ...DEFAULT_WATCHDOG };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let gen = 0; // 設定を変えたら増やす。古い巡回の結果を捨てる
  let busyTick = false;
  let track: HeightTrack | null = null;
  let state: RestartState = initialRestartState();
  let lastCheckAt: number | null = null;
  let level: WatchLevel | null = null;
  let issues: string[] = [];
  let log: WatchdogLog[] = [];
  const push = (e: WatchdogLog) => {
    log = [e, ...log].slice(0, MAX_LOG);
    void notify(e);
  };
  // 通知（Webhook）。失敗しても、見張りには影響させない（記録に 1 行残すだけ）。Slack（text）と Discord（content）の両方で読める形。
  const notify = async (e: WatchdogLog): Promise<void> => {
    const url = config.notifyUrl;
    const text = notifyText(e.kind, config.url, e.reason);
    if (!url || text === null) return;
    const f = deps.fetchImpl ?? ((u: string, init: Parameters<NonNullable<WatchdogDeps['fetchImpl']>>[1]) => fetch(u, init));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), NOTIFY_TIMEOUT_MS);
    try {
      const res = await f(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text }), signal: ctl.signal, redirect: 'error' });
      if (!res.ok) throw new Error('http');
    } catch {
      log = [{ at: now(), kind: 'notify_failed' as const }, ...log].slice(0, MAX_LOG);
    } finally { clearTimeout(timer); }
  };

  const reset = () => { track = null; state = initialRestartState(); lastCheckAt = null; level = null; issues = []; };

  const schedule = (g: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void tick().finally(() => { if (running && g === gen) schedule(g); }); }, config.intervalSec * 1000);
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    if (busyTick) return;
    busyTick = true;
    const g = gen;
    try {
      const s = await probe(config.url);
      if (g !== gen) return;
      track = trackHeight(track, s);
      const ev = evaluate(s, track);
      level = ev.level;
      issues = ev.issues.map((i) => i.key);
      lastCheckAt = s.at;
      const before = state;
      const d = decideRestart(state, ev.issues, s.at);
      if (d.action === 'none') {
        // 再起動したあと、問題がなくなった: 戻ったと記録する（あきらめたあとに、手で直った場合も）
        if (ev.issues.every((i) => i.level !== 'error') && (before.attempts > 0 || before.gaveUp) && d.state.attempts === 0) push({ at: s.at, kind: 'recovered' });
        state = d.state;
      } else if (d.action === 'gave_up') {
        state = d.state;
        push({ at: s.at, kind: 'gave_up' });
      } else {
        state = d.state;
        const r = await deps.restart(config.dir);
        if (g !== gen) return;
        if (r === 'busy') {
          // 別のコマンドが動いていて流せなかった: 回数に数えず、次の巡回でもう一度
          state = { ...d.state, attempts: d.state.attempts - 1, lastAt: before.lastAt, bad: 99 };
          push({ at: now(), kind: 'restart_busy', reason: d.reason });
        } else {
          // 高さの追跡は、あえて消さない: 止まりが続く間は問題が見え続け、再起動の間隔と回数の上限（decideRestart）が効く。消すと、問題が一時的に消えて、回数が 0 に戻ってしまう。
          push({ at: now(), kind: r === 'ok' ? 'restart_ok' : 'restart_failed', reason: d.reason });
        }
      }
    } catch {
      // 巡回の失敗（想定外）では、何もしない。次の巡回でやり直す
    } finally { busyTick = false; }
  };

  const persist = (c: WatchdogConfig) => {
    if (deps.persist === false) return;
    const p = join(deps.workspace, WATCHDOG_FILE);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(c, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* Windows */ }
    renameSync(tmp, p);
  };

  const begin = () => {
    gen += 1;
    reset();
    if (timer) { clearTimeout(timer); timer = null; }
    running = config.enabled;
    if (running) { push({ at: now(), kind: 'started' }); void tick().finally(() => { if (running) schedule(gen); }); }
  };

  return {
    snapshot: () => ({ config: publicConfig(config), notify: { set: !!config.notifyUrl, host: config.notifyUrl ? hostOf(config.notifyUrl) : '' }, running, lastCheckAt, level, issues, attempts: state.attempts, gaveUp: state.gaveUp, log }),
    configure(c) {
      // 通知先: 省略は、いまの設定を残す。空は消す。
      const keep = c.notifyUrl === undefined ? config.notifyUrl : c.notifyUrl;
      config = { enabled: c.enabled, url: c.url, dir: c.dir, intervalSec: c.intervalSec, ...(keep ? { notifyUrl: keep } : {}) };
      persist(config); begin();
    },
    tick,
    load() { config = readWatchdogFile(deps.workspace); if (config.enabled) begin(); },
    close() { gen += 1; running = false; if (timer) { clearTimeout(timer); timer = null; } },
  };
}
