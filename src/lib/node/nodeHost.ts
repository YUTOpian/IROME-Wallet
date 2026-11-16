// ノードを動かしている PC の状態（ディスク・CPU・メモリ・証明書の期限）。エージェント（src/server/node-agent/host.ts）が集めて返し、
// 画面は、受け取ったものの形を確かめて、しきい値で「注意・異常」を決める（ここは画面に依らない部品）。
// 返すのは数字と、証明書（公開のもの）の件名・期限だけ。鍵・設定ファイルの中身は入らない。
import type { WatchIssue } from './nodeWatch';

export interface HostDisk { path: string; totalBytes: number; freeBytes: number }
export interface HostCpu { cores: number; /** 直近の使用率（%）。取れないときは null。 */ usagePct: number | null; /** 1 分の平均負荷（Windows では null）。 */ load1: number | null }
export interface HostMemory { totalBytes: number; availableBytes: number }
export interface HostCert { path: string; subject: string; /** 期限（UTC のミリ秒）。 */ notAfter: number }
export interface HostStats { at: number; disk: HostDisk | null; cpu: HostCpu | null; memory: HostMemory | null; certs: HostCert[] }

export const HOST_LIMITS = {
  diskFreeWarnPct: 15,
  diskFreeErrorPct: 5,
  cpuWarnPct: 90,
  cpuErrorPct: 98,
  memAvailWarnPct: 10,
  memAvailErrorPct: 5,
  certWarnDays: 30,
  certErrorDays: 7,
} as const;

const DAY = 86_400_000;
const MAX_CERTS = 20;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonNeg = (v: unknown): v is number => isNum(v) && v >= 0;
const rec = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '');

/** エージェントから届いたものを信用せず、形・範囲をもう一度確かめる（定義に無い項目は落ちる）。壊れていれば null。 */
export function sanitizeHostStats(raw: unknown): HostStats | null {
  const r = rec(raw);
  if (!r || !isNum(r.at)) return null;
  const d = rec(r.disk);
  const disk: HostDisk | null = d && nonNeg(d.totalBytes) && nonNeg(d.freeBytes) && d.totalBytes > 0 && d.freeBytes <= d.totalBytes
    ? { path: clip(d.path, 200), totalBytes: d.totalBytes, freeBytes: d.freeBytes } : null;
  const c = rec(r.cpu);
  const cpu: HostCpu | null = c && nonNeg(c.cores) && c.cores >= 1
    ? { cores: Math.floor(c.cores), usagePct: isNum(c.usagePct) && c.usagePct >= 0 && c.usagePct <= 100 ? c.usagePct : null, load1: nonNeg(c.load1) ? c.load1 : null } : null;
  const m = rec(r.memory);
  const memory: HostMemory | null = m && nonNeg(m.totalBytes) && nonNeg(m.availableBytes) && m.totalBytes > 0 && m.availableBytes <= m.totalBytes
    ? { totalBytes: m.totalBytes, availableBytes: m.availableBytes } : null;
  const certs: HostCert[] = [];
  if (Array.isArray(r.certs)) {
    for (const x of r.certs) {
      const e = rec(x);
      if (!e || !isNum(e.notAfter)) continue;
      certs.push({ path: clip(e.path, 200), subject: clip(e.subject, 120), notAfter: e.notAfter });
      if (certs.length >= MAX_CERTS) break;
    }
  }
  return { at: r.at, disk, cpu, memory, certs };
}

/** しきい値で、問題の一覧にする。n は、メッセージに入れる数（ディスク・メモリは空きの %、CPU は使用率 %、証明書は残り日数。期限切れは 0 以下）。 */
export function evaluateHost(h: HostStats, now: number = h.at): WatchIssue[] {
  const L = HOST_LIMITS;
  const issues: WatchIssue[] = [];
  if (h.disk) {
    const free = (h.disk.freeBytes / h.disk.totalBytes) * 100;
    if (free < L.diskFreeErrorPct) issues.push({ key: 'disk_low', level: 'error', n: Math.round(free) });
    else if (free < L.diskFreeWarnPct) issues.push({ key: 'disk_low', level: 'warn', n: Math.round(free) });
  }
  if (h.cpu && h.cpu.usagePct !== null) {
    if (h.cpu.usagePct >= L.cpuErrorPct) issues.push({ key: 'cpu_high', level: 'error', n: Math.round(h.cpu.usagePct) });
    else if (h.cpu.usagePct >= L.cpuWarnPct) issues.push({ key: 'cpu_high', level: 'warn', n: Math.round(h.cpu.usagePct) });
  }
  if (h.memory) {
    const avail = (h.memory.availableBytes / h.memory.totalBytes) * 100;
    if (avail < L.memAvailErrorPct) issues.push({ key: 'mem_low', level: 'error', n: Math.round(avail) });
    else if (avail < L.memAvailWarnPct) issues.push({ key: 'mem_low', level: 'warn', n: Math.round(avail) });
  }
  if (h.certs.length > 0) {
    // いちばん近い期限だけを問題にする（ほかは一覧で見える）
    const soonest = Math.min(...h.certs.map((c) => c.notAfter));
    const days = Math.floor((soonest - now) / DAY);
    if (soonest <= now) issues.push({ key: 'cert_expiring', level: 'error', n: days });
    else if (days < L.certErrorDays) issues.push({ key: 'cert_expiring', level: 'error', n: days });
    else if (days < L.certWarnDays) issues.push({ key: 'cert_expiring', level: 'warn', n: days });
  }
  return issues;
}

export const daysLeft = (notAfter: number, now: number): number => Math.floor((notAfter - now) / DAY);
