// ノードの状態ウォッチ: 自分のノード（Symbol の REST ゲートウェイ）を一定間隔で見て、「正常 / 注意 / 異常」を判定する。
//
// - 見るもの: /node/health（api と db）・/chain/info（高さ・ファイナライズ）・/node/info（名前・版・ネットワーク）・/node/peers（接続数）。
//   読むだけ。ウォレットの鍵にも、ノードの設定にも触れない。
// - 比べるもの（任意）: ウォレットが使っているノードの高さ。ネットワークが違うときは、比べない（誤判定を避ける）。
// - ここは通信の部品と判定だけ（画面に依らない）。fetch は差し替えられる（テスト用）。
import { isAllowedNodeUrl } from '../nodePolicy';

export type WatchLevel = 'ok' | 'warn' | 'error';
export type IssueKey = 'unreachable' | 'api_down' | 'db_down' | 'stalled' | 'behind' | 'finalization_lag' | 'no_peers';
export interface WatchIssue { key: IssueKey; level: Exclude<WatchLevel, 'ok'>; n?: number }

export interface WatchSample {
  at: number;
  reachable: boolean;
  apiNode: string | null; // 'up' / 'down' / null（読めなかった）
  db: string | null;
  height: number | null;
  finalizedHeight: number | null;
  finalizationEpoch: number | null;
  name: string | null;
  version: string | null;
  networkIdentifier: number | null;
  peers: number | null;
  /** 比べたノードの高さ。比べない・比べられないときは null。 */
  refHeight: number | null;
  /** ネットワークが違うので比べなかった。 */
  refSkipped: boolean;
  /** 応答までの時間（ミリ秒。/chain/info か /node/health のうち、早く返ったほう）。 */
  latencyMs: number | null;
}

export interface HeightTrack { height: number; since: number }
export interface WatchEvent { at: number; level: WatchLevel; issues: WatchIssue[] }

/** 注意・異常にするしきい値。 */
export const WATCH_LIMITS = {
  stalledWarnMs: 3 * 60_000,
  stalledErrorMs: 10 * 60_000,
  behindWarn: 10,
  behindError: 100,
  finalizationWarn: 2160, // 3 エポック分（Symbol メインネットは 1 エポック = 720 ブロック）
  requestTimeoutMs: 5000,
} as const;

export const WATCH_INTERVALS_SEC: readonly number[] = [10, 30, 60];

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** 入力を REST の基点 URL にする。https は何でも、http はこの PC・LAN だけ（nodePolicy と同じ決まり）。だめなら null。 */
export function normalizeWatchUrl(input: string): string | null {
  const text = input.trim();
  if (text === '') return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const u = new URL(withScheme);
    const base = `${u.protocol}//${u.host}`;
    return isAllowedNodeUrl(base) ? base : null;
  } catch { return null; }
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d{1,18}$/.test(v)) return Number(v);
  return null;
};
const str = (v: unknown, max = 100): string | null => (typeof v === 'string' && v.length <= max ? v : null);

async function getJson(f: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await f(url, { signal: controller.signal });
    if (!res.ok) throw new Error('http');
    return await res.json();
  } finally { clearTimeout(timer); }
}

/** バージョンは数値で返る（例: 16777472 → 1.0.1.0）。 */
export function formatNodeVersion(v: unknown): string | null {
  const n = num(v);
  if (n === null) return null;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

export interface RefResult { height: number; networkIdentifier: number | null }

/** 1 回見る。base は normalizeWatchUrl を通したもの。ref は「比べるノード」の高さを返す関数（省略なら比べない）。 */
export async function probeNode(
  base: string,
  opts: { ref?: (() => Promise<RefResult | null>) | null; fetchImpl?: FetchLike; now?: () => number; timeoutMs?: number } = {},
): Promise<WatchSample> {
  const f: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, { ...init, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }));
  const now = opts.now ?? Date.now;
  const timeout = opts.timeoutMs ?? WATCH_LIMITS.requestTimeoutMs;
  const timed = async (path: string) => { const t0 = now(); const v = await getJson(f, `${base}${path}`, timeout); return { v, ms: now() - t0 }; };
  const [health, chain, info, peers, ref] = await Promise.allSettled([
    timed('/node/health'), timed('/chain/info'), timed('/node/info'), timed('/node/peers'),
    opts.ref ? opts.ref() : Promise.resolve(null),
  ]);
  const at = now();
  const h = health.status === 'fulfilled' ? (health.value.v as { status?: { apiNode?: unknown; db?: unknown } }) : null;
  const c = chain.status === 'fulfilled' ? (chain.value.v as { height?: unknown; latestFinalizedBlock?: { height?: unknown; finalizationEpoch?: unknown } }) : null;
  const i = info.status === 'fulfilled' ? (info.value.v as { friendlyName?: unknown; version?: unknown; networkIdentifier?: unknown }) : null;
  const p = peers.status === 'fulfilled' ? peers.value.v : null;
  const reachable = h !== null || c !== null || i !== null;
  const networkIdentifier = num(i?.networkIdentifier);
  const r = ref.status === 'fulfilled' ? ref.value : null;
  const refSkipped = r !== null && r.networkIdentifier !== null && networkIdentifier !== null && r.networkIdentifier !== networkIdentifier;
  const latencies = [health, chain].flatMap((x) => (x.status === 'fulfilled' ? [x.value.ms] : []));
  return {
    at,
    reachable,
    apiNode: str(h?.status?.apiNode, 20),
    db: str(h?.status?.db, 20),
    height: num(c?.height),
    finalizedHeight: num(c?.latestFinalizedBlock?.height),
    finalizationEpoch: num(c?.latestFinalizedBlock?.finalizationEpoch),
    name: str(i?.friendlyName),
    version: formatNodeVersion(i?.version),
    networkIdentifier,
    peers: Array.isArray(p) ? p.length : null,
    refHeight: r && !refSkipped ? r.height : null,
    refSkipped,
    latencyMs: latencies.length ? Math.min(...latencies) : null,
  };
}

/** 高さが最後に変わった時刻を持ち続ける（止まっているかの判定用）。高さが戻った（ロールバック）ときも、変わった扱い。 */
export function trackHeight(prev: HeightTrack | null, s: WatchSample): HeightTrack | null {
  if (s.height === null) return prev;
  if (prev && prev.height === s.height) return prev;
  return { height: s.height, since: s.at };
}

/** 1 回分の見た結果から、問題の一覧と全体のレベルを決める。 */
export function evaluate(s: WatchSample, track: HeightTrack | null): { level: WatchLevel; issues: WatchIssue[] } {
  const issues: WatchIssue[] = [];
  if (!s.reachable) {
    issues.push({ key: 'unreachable', level: 'error' });
  } else {
    if (s.apiNode !== null && s.apiNode !== 'up') issues.push({ key: 'api_down', level: 'error' });
    if (s.db !== null && s.db !== 'up') issues.push({ key: 'db_down', level: 'error' });
    if (track && s.height !== null) {
      const still = s.at - track.since;
      if (still >= WATCH_LIMITS.stalledErrorMs) issues.push({ key: 'stalled', level: 'error', n: Math.floor(still / 60_000) });
      else if (still >= WATCH_LIMITS.stalledWarnMs) issues.push({ key: 'stalled', level: 'warn', n: Math.floor(still / 60_000) });
    }
    if (s.height !== null && s.refHeight !== null) {
      const behind = s.refHeight - s.height;
      if (behind >= WATCH_LIMITS.behindError) issues.push({ key: 'behind', level: 'error', n: behind });
      else if (behind >= WATCH_LIMITS.behindWarn) issues.push({ key: 'behind', level: 'warn', n: behind });
    }
    if (s.height !== null && s.finalizedHeight !== null && s.height - s.finalizedHeight >= WATCH_LIMITS.finalizationWarn) {
      issues.push({ key: 'finalization_lag', level: 'warn', n: s.height - s.finalizedHeight });
    }
    if (s.peers === 0) issues.push({ key: 'no_peers', level: 'warn' });
  }
  const level: WatchLevel = issues.some((x) => x.level === 'error') ? 'error' : issues.length ? 'warn' : 'ok';
  return { level, issues };
}

/** 前回と今回で、レベルか問題の顔ぶれが変わったか（変わったときだけ、履歴に残す）。 */
export function changed(prev: { level: WatchLevel; issues: WatchIssue[] } | null, next: { level: WatchLevel; issues: WatchIssue[] }): boolean {
  if (!prev) return true;
  if (prev.level !== next.level) return true;
  const sig = (x: WatchIssue[]) => x.map((i) => `${i.key}:${i.level}`).sort().join(',');
  return sig(prev.issues) !== sig(next.issues);
}

export const MAX_EVENTS = 50;
