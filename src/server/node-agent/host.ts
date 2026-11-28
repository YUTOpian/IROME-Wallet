// ノードを動かしている PC の状態を集める（読むだけ）: ディスクの空き（作業場所のあるドライブ）・CPU の使用率・メモリ・証明書の期限。
// 証明書は、作業場所の中の `*.crt.pem` / `*.cert.pem` から、**証明書（公開のもの）の件名と期限だけ**を読む。
// 秘密鍵のファイル（`*.key.pem` など）は開かない。ファイルの中身は返さない。シンボリックリンクは辿らない。tools/ と node_modules の中は見ない。
import os from 'node:os';
import { X509Certificate } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import type { HostCert, HostStats } from '../../lib/node/nodeHost';

const CERT_NAME = /\.(crt|cert)\.pem$/i;
const BLOCK = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/;
const MAX_CERT_FILE = 64 * 1024;

type CpuTimes = { idle: number; total: number };
const cpuTimes = (): CpuTimes => {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { idle += c.times.idle; total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq; }
  return { idle, total };
};
let prevCpu: CpuTimes | null = null;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 前回からの使用率（%）。前回が無いときは、短く（0.25 秒）測る。 */
async function cpuUsage(): Promise<number | null> {
  let a = prevCpu;
  if (!a) { a = cpuTimes(); await sleep(250); }
  const b = cpuTimes();
  prevCpu = b;
  const total = b.total - a.total;
  if (!(total > 0)) return null;
  return Math.min(100, Math.max(0, (1 - (b.idle - a.idle) / total) * 100));
}

/** Linux は MemAvailable（キャッシュを除いた、使える分）。それ以外は os.freemem()。 */
function memory(): { totalBytes: number; availableBytes: number } | null {
  const total = os.totalmem();
  if (!(total > 0)) return null;
  let avail = os.freemem();
  if (process.platform === 'linux') {
    try {
      const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
      if (m) avail = Number(m[1]) * 1024;
    } catch { /* os.freemem() のまま */ }
  }
  return { totalBytes: total, availableBytes: Math.min(total, Math.max(0, avail)) };
}

function disk(ws: string): HostStats['disk'] {
  try {
    const s = statfsSync(ws);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    if (!(total > 0) || !Number.isFinite(free)) return null;
    return { path: ws, totalBytes: total, freeBytes: Math.min(total, Math.max(0, free)) };
  } catch { return null; }
}

/** 作業場所の中の証明書（期限だけ）。 */
export function readCerts(ws: string): HostCert[] {
  const out: HostCert[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 6 || out.length >= 20) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (r === 'tools') continue; walk(join(dir, e.name), r, depth + 1); continue; }
      if (!e.isFile() || !CERT_NAME.test(e.name) || out.length >= 20) continue;
      try {
        const full = join(dir, e.name);
        if (lstatSync(full).size > MAX_CERT_FILE) continue;
        // 証明書のブロックだけを取り出して読む（同じファイルに鍵が入っていても、そこは読まない）
        const block = BLOCK.exec(readFileSync(full, 'utf8'));
        if (!block) continue;
        const x = new X509Certificate(block[0]);
        const notAfter = Date.parse(x.validTo);
        if (!Number.isFinite(notAfter)) continue;
        const cn = /CN=([^\n,]+)/.exec(x.subject)?.[1] ?? x.subject.split('\n')[0] ?? '';
        out.push({ path: r, subject: cn.slice(0, 120), notAfter });
      } catch { /* 読めない・壊れたものは飛ばす */ }
    }
  };
  walk(ws, '', 0);
  return out.sort((p, q) => p.notAfter - q.notAfter);
}

export async function collectHostStats(ws: string, now: () => number = Date.now): Promise<HostStats> {
  const usage = await cpuUsage().catch(() => null);
  const load1 = process.platform === 'win32' ? null : os.loadavg()[0];
  return {
    at: now(),
    disk: disk(ws),
    cpu: { cores: Math.max(1, os.cpus().length), usagePct: usage, load1 },
    memory: memory(),
    certs: readCerts(ws),
  };
}
