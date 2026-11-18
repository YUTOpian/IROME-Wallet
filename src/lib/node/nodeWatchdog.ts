// エージェントの常駐ウォッチドッグ（画面を閉じていても、ノードを見て、止まったら再起動する）の、設定と状態の形。
// 画面とエージェントの両方が使う純粋な部品。受け取ったものは、必ず sanitize を通して、形と範囲をもう一度確かめる。
// 再起動するコマンドは固定（`docker compose restart`）。設定で変えられるのは、見るノードの URL・作業フォルダ・間隔・オンオフだけ。
import { normalizeWatchUrl } from './nodeWatch';
import { validateSubdir } from './nodeCommands';
import type { WatchLevel } from './nodeWatch';

export const WATCHDOG_INTERVALS_SEC: readonly number[] = [30, 60, 120, 300];
export interface WatchdogConfig {
  enabled: boolean;
  /** 見るノードの REST（正規化済み）。 */ url: string;
  /** compose ファイルのある作業フォルダ（作業場所からの相対。空は直下）。 */ dir: string;
  intervalSec: number;
  /** 通知先の Webhook（https のみ）。空・省略は通知しない。保存時に省略すると、いまの設定を残す。URL そのものが秘密なので、状態には返さない（NotifyInfo だけ返す）。 */
  notifyUrl?: string;
}
/** 画面に返す設定（通知先の URL は含めない）。 */
export type PublicWatchdogConfig = Omit<WatchdogConfig, 'notifyUrl'>;
/** 通知先を設定してあるか（URL の本体は返さず、送り先のホスト名だけ）。 */
export interface NotifyInfo { set: boolean; host: string }
export const DEFAULT_WATCHDOG: WatchdogConfig = { enabled: false, url: 'http://127.0.0.1:3000', dir: '', intervalSec: 60 };

/**
 * 通知先の Webhook。https だけ・ユーザー名とパスワードの入った形は不可・IP アドレスや「.」の無い名前（localhost・社内の名前）は不可
 * （エージェントが、この PC や社内の機器へ送ってしまわないように）。正規化した URL を返す。
 */
export function normalizeNotifyUrl(input: string): string | null {
  const v = input.trim();
  if (v.length === 0 || v.length > 500) return null;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.hash !== '') return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return null;
  return u.toString();
}

export type WatchdogLogKind = 'restart_ok' | 'restart_failed' | 'restart_busy' | 'gave_up' | 'recovered' | 'started' | 'notify_failed';
export interface WatchdogLog { at: number; kind: WatchdogLogKind; reason?: string }
export interface WatchdogSnapshot {
  config: PublicWatchdogConfig;
  notify: NotifyInfo;
  /** 巡回が動いているか。 */
  running: boolean;
  lastCheckAt: number | null;
  level: WatchLevel | null;
  /** いまの問題の種類（再起動の対象になるものだけでなく、全部）。 */
  issues: string[];
  attempts: number;
  gaveUp: boolean;
  log: WatchdogLog[];
}

const rec = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** 設定を、決まった形だけ受け入れる（知らない項目・型違い・範囲外は断る）。url は正規化し、dir は作業場所の中だけ。 */
export function sanitizeWatchdogConfig(raw: unknown): { ok: true; config: WatchdogConfig } | { ok: false; reason: 'bad_config' | 'bad_url' | 'bad_dir' | 'bad_interval' | 'bad_notify' } {
  const r = rec(raw);
  if (!r) return { ok: false, reason: 'bad_config' };
  const allowed = new Set(['enabled', 'url', 'dir', 'intervalSec', 'notifyUrl']);
  if (Object.keys(r).some((k) => !allowed.has(k))) return { ok: false, reason: 'bad_config' };
  if (typeof r.enabled !== 'boolean' || typeof r.url !== 'string' || typeof r.dir !== 'string' || typeof r.intervalSec !== 'number') return { ok: false, reason: 'bad_config' };
  const url = normalizeWatchUrl(r.url);
  if (url === null) return { ok: false, reason: 'bad_url' };
  const dir = validateSubdir(r.dir);
  if (!dir.ok) return { ok: false, reason: 'bad_dir' };
  if (!WATCHDOG_INTERVALS_SEC.includes(r.intervalSec)) return { ok: false, reason: 'bad_interval' };
  if (r.notifyUrl !== undefined && typeof r.notifyUrl !== 'string') return { ok: false, reason: 'bad_config' };
  let notifyUrl: string | undefined;
  if (typeof r.notifyUrl === 'string' && r.notifyUrl.trim() !== '') {
    const n = normalizeNotifyUrl(r.notifyUrl);
    if (n === null) return { ok: false, reason: 'bad_notify' };
    notifyUrl = n;
  } else if (r.notifyUrl === '') notifyUrl = '';
  return { ok: true, config: { enabled: r.enabled, url, dir: dir.value, intervalSec: r.intervalSec, ...(notifyUrl !== undefined ? { notifyUrl } : {}) } };
}

const KINDS: ReadonlySet<string> = new Set<WatchdogLogKind>(['restart_ok', 'restart_failed', 'restart_busy', 'gave_up', 'recovered', 'started', 'notify_failed']);
const REASONS: ReadonlySet<string> = new Set(['stalled', 'api_down', 'db_down', 'unreachable']);

/** エージェントから届いた状態を信用せず、形をもう一度確かめる。壊れていれば null。 */
export function sanitizeWatchdogSnapshot(raw: unknown): WatchdogSnapshot | null {
  const r = rec(raw);
  if (!r) return null;
  // 状態には、通知先の URL は入らない（入っていたら、不正として断る）
  const cr = rec(r.config);
  if (!cr || 'notifyUrl' in cr) return null;
  const c = sanitizeWatchdogConfig(cr);
  if (!c.ok) return null;
  const nr = rec(r.notify);
  const notify: NotifyInfo = { set: nr?.set === true, host: typeof nr?.host === 'string' ? nr.host.replace(/[^A-Za-z0-9.-]/g, '').slice(0, 100) : '' };
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const log: WatchdogLog[] = [];
  if (Array.isArray(r.log)) {
    for (const x of r.log.slice(0, 50)) {
      const e = rec(x);
      if (!e || num(e.at) === null || typeof e.kind !== 'string' || !KINDS.has(e.kind)) continue;
      log.push({ at: e.at as number, kind: e.kind as WatchdogLogKind, ...(typeof e.reason === 'string' && REASONS.has(e.reason) ? { reason: e.reason } : {}) });
    }
  }
  const level = r.level === 'ok' || r.level === 'warn' || r.level === 'error' ? r.level : null;
  const issues = Array.isArray(r.issues) ? r.issues.filter((s): s is string => typeof s === 'string' && /^[a-z_]{1,30}$/.test(s)).slice(0, 12) : [];
  return { config: c.config, notify, running: r.running === true, lastCheckAt: num(r.lastCheckAt), level, issues, attempts: Math.min(num(r.attempts) ?? 0, 100), gaveUp: r.gaveUp === true, log };
}

/** 見つけた作業フォルダの候補（compose ファイルのあるフォルダ）。受け取ったものは、作業場所の中の相対パスだけ残す。 */
export function sanitizeComposeDirs(raw: unknown): string[] {
  const r = rec(raw);
  const list = r && Array.isArray(r.dirs) ? r.dirs : [];
  const out: string[] = [];
  for (const d of list.slice(0, 20)) {
    if (typeof d !== 'string') continue;
    const v = validateSubdir(d);
    if (v.ok && !out.includes(v.value)) out.push(v.value);
  }
  return out;
}
