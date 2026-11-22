// ノードの自動再起動: 状態ウォッチが「止まっている・落ちている」と判断したとき、エージェント経由で `docker compose restart` を 1 回だけ流す。
// ここは「いつ再起動するか」を決める純粋な部品（画面にも通信にも依らない）。実際の実行は NodeWatchCard が、既存のエージェントの許可リスト（docker compose restart）を通して行う。
//
// 暴走させないための決まり:
// - 対象は、止まり（stalled が「異常」）・API / DB が落ちている・REST に繋がらない、のどれか。
//   「注意」だけ（遅れ・ピア 0・ディスクなど）では動かさない。再起動で直らないものだから。
// - 条件が 2 回続けて見えたときだけ動かす（1 回の取りこぼしで再起動しない）。止まりは、もともと 10 分たっているので即時。
// - 1 回動かしたら、10 分は動かさない（起動して追いつくまでの時間）。
// - 直らないまま 3 回動かしたら、あきらめて知らせるだけにする。正常に戻ったら、回数は 0 に戻る。
import type { WatchIssue } from './nodeWatch';

export const AUTO_RESTART_LIMITS = {
  /** 続けて何回の巡回で「悪い」が見えたら動かすか（stalled は、もう 10 分たっているので 1 回で動かす）。 */
  confirmRounds: 2,
  /** 1 回動かしたあと、次に動かすまでに空ける時間。 */
  cooldownMs: 10 * 60_000,
  /** 直らないまま動かす回数の上限。 */
  maxAttempts: 3,
  /** 再起動のコマンドが終わるのを待つ上限。 */
  jobTimeoutMs: 120_000,
} as const;

/** 画面から流す再起動のコマンド（エージェントの許可リストを通る形。`-f` や対象の指定は付けない）。 */
export const AUTO_RESTART_LINE = 'docker compose restart';

/** 再起動の対象にする問題の種類。 */
const TRIGGER_KEYS: ReadonlySet<string> = new Set(['stalled', 'api_down', 'db_down', 'unreachable']);

export interface RestartState {
  /** 続けて「悪い」が見えた巡回の数。 */
  bad: number;
  /** 直らないまま動かした回数。 */
  attempts: number;
  /** 最後に動かした時刻。まだ動かしていなければ null。 */
  lastAt: number | null;
  /** あきらめた（上限に達した）あと、知らせ済みか。 */
  gaveUp: boolean;
}

export const initialRestartState = (): RestartState => ({ bad: 0, attempts: 0, lastAt: null, gaveUp: false });

export type RestartDecision =
  | { action: 'none'; state: RestartState }
  | { action: 'restart'; state: RestartState; reason: string }
  | { action: 'gave_up'; state: RestartState };

/** 再起動の理由にできる問題（「異常」のレベルで、対象の種類のもの）。なければ null。 */
export function restartReason(issues: readonly WatchIssue[]): string | null {
  const hit = issues.find((i) => i.level === 'error' && TRIGGER_KEYS.has(i.key));
  return hit ? hit.key : null;
}

/**
 * 1 回の巡回の結果から、再起動するかを決める。state は呼び出し側が持ち続け、返ってきた state を次に渡す。
 * `restart` を返したら、呼び出し側は実際に流す（流せなかったときは state を戻さず、次の巡回でまた決める）。
 */
export function decideRestart(state: RestartState, issues: readonly WatchIssue[], now: number, limits: typeof AUTO_RESTART_LIMITS = AUTO_RESTART_LIMITS): RestartDecision {
  const reason = restartReason(issues);
  if (reason === null) return { action: 'none', state: initialRestartState() }; // 戻った: 数え直し
  const bad = state.bad + 1;
  const need = reason === 'stalled' ? 1 : limits.confirmRounds;
  const next: RestartState = { ...state, bad };
  if (bad < need) return { action: 'none', state: next };
  if (state.attempts >= limits.maxAttempts) {
    return state.gaveUp ? { action: 'none', state: next } : { action: 'gave_up', state: { ...next, gaveUp: true } };
  }
  if (state.lastAt !== null && now - state.lastAt < limits.cooldownMs) return { action: 'none', state: next };
  return { action: 'restart', state: { bad: 0, attempts: state.attempts + 1, lastAt: now, gaveUp: false }, reason };
}
