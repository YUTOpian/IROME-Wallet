// ノード構築エージェント: OS ごとの違い（Windows ネイティブ対応）をここに集める。
// どれも、OS の種類（plat）を引数で受ける。試験で、Linux 上でも Windows の分岐を確かめられるように。
//
// Windows で、Linux / macOS と違う点:
// - npm が入れる実行ファイルは `.cmd`（シェル用の小さな橋渡し）。Node.js はセキュリティ修正（CVE-2024-27980）以降、
//   シェルなしで `.cmd` を起動できない。かといって `cmd.exe /c` を通すと、`%` や `^` が解釈されてしまう。
//   そこで、`.cmd` は使わず、パッケージの `package.json` の `bin` が指す JavaScript を、`node.exe` で直接動かす。
//   npm 自身も同じく、`npm-cli.js` を `node.exe` で直接動かす。
// - 環境変数の名前は大文字・小文字を区別しない（`Path`）。`PATH` を足すと、2 つできてしまうことがあるので、元の名前に合わせる。
// - 子プロセスの停止は、シグナルではなく、`taskkill /T /F`（子孫ごと）。
// - パスの大文字・小文字は区別されず、区切りは `\` も使える。
// - root の代わりに、管理者権限（昇格）で動かさない。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface Resolved { cmd: string; args: string[]; local?: boolean }

export const isWindows = (plat: NodeJS.Platform) => plat === 'win32';
export const pathDelimiter = (plat: NodeJS.Platform) => (isWindows(plat) ? ';' : ':');

// ---- パス ----

/** `p` が `root` の中（`allowEqual` なら root 自身も）か。Windows は大文字・小文字と `\` を区別しない。 */
export function isInside(root: string, p: string, plat: NodeJS.Platform, allowEqual = false): boolean {
  const norm = (s: string) => {
    let x = isWindows(plat) ? s.replace(/\\/g, '/').toLowerCase() : s;
    x = x.replace(/\/+$/, '');
    return x;
  };
  const r = norm(root), q = norm(p);
  if (q === r) return allowEqual;
  return q.startsWith(r + '/');
}

// ---- tools/ の場所 ----

export const toolsRoot = (ws: string) => join(ws, 'tools');

/** tools/node の中の node 本体。Windows は直下の node.exe、それ以外は bin/node。 */
export const localNodeExe = (ws: string, plat: NodeJS.Platform) =>
  isWindows(plat) ? join(ws, 'tools', 'node', 'node.exe') : join(ws, 'tools', 'node', 'bin', 'node');

/** tools/python の中の python 本体。Windows は直下の python.exe、それ以外は bin/python3。 */
export const localPythonExe = (ws: string, plat: NodeJS.Platform) =>
  isWindows(plat) ? join(ws, 'tools', 'python', 'python.exe') : join(ws, 'tools', 'python', 'bin', 'python3');

/** npm でツールを入れた先の、実行用の橋渡し（`.bin`）。Windows は `.cmd`。 */
export const npmBinPath = (ws: string, name: string, plat: NodeJS.Platform) =>
  join(ws, 'tools', 'node_modules', '.bin', name + (isWindows(plat) && name !== '' ? '.cmd' : ''));

/** Shoestring の venv の Python。 */
export const venvPythonPath = (ws: string, plat: NodeJS.Platform) =>
  join(ws, 'tools', 'venv', isWindows(plat) ? 'Scripts' : 'bin', isWindows(plat) ? 'python.exe' : 'python');

/** 作業場所の tools/ に入れたものを、PATH の先頭に足す場所。 */
export function toolDirs(ws: string, plat: NodeJS.Platform): string[] {
  const t = toolsRoot(ws);
  return isWindows(plat)
    ? [join(t, 'node_modules', '.bin'), join(t, 'node'), join(t, 'python'), join(t, 'python', 'Scripts')]
    : [join(t, 'node_modules', '.bin'), join(t, 'node', 'bin'), join(t, 'python', 'bin')];
}

// ---- 子プロセスの環境変数 ----

/** 環境変数 PATH の、本当の名前（Windows は `Path` のことが多い）。 */
export function envPathKey(env: NodeJS.ProcessEnv, plat: NodeJS.Platform): string {
  if (!isWindows(plat)) return 'PATH';
  return Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
}

/** 子プロセス用の環境変数。PATH の先頭に tools/ のものを足す。Windows は、`Path` と `PATH` の二重を作らない。 */
export function childEnv(ws: string, plat: NodeJS.Platform, env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const key = envPathKey(env, plat);
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (isWindows(plat) && k !== key && k.toLowerCase() === 'path') continue;
    base[k] = v;
  }
  const dirs = [...toolDirs(ws, plat), ...(base[key] ? [base[key] as string] : [])];
  return { ...base, [key]: dirs.join(pathDelimiter(plat)), ...extra };
}

// ---- npm・npm のツールを、シェルなしで動かす（Windows） ----

/** ツールを動かす node: tools/node にあればそれ、なければこのエージェント自身の node。 */
export function nodeForTools(ws: string, plat: NodeJS.Platform, execPath: string): string {
  const local = localNodeExe(ws, plat);
  return existsSync(local) ? local : execPath;
}

/** npm-cli.js の場所。tools/node の npm を先に、なければエージェント自身の node と同じところの npm。 */
export function npmCliPath(ws: string, execPath: string): string | null {
  const cands = [
    join(ws, 'tools', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return cands.find((c) => existsSync(c)) ?? null;
}

/**
 * npm を動かすコマンド。Linux / macOS は `npm` のまま。
 * Windows は、`npm.cmd` を使えないので、`node npm-cli.js …`。見つからなければ null。
 */
export function npmCommand(ws: string, args: string[], plat: NodeJS.Platform, execPath: string): { cmd: string; args: string[] } | null {
  if (!isWindows(plat)) return { cmd: 'npm', args };
  const cli = npmCliPath(ws, execPath);
  return cli ? { cmd: nodeForTools(ws, plat, execPath), args: [cli, ...args] } : null;
}

/** パッケージの package.json の bin が指す JavaScript（パッケージの外を指すものは、使わない）。 */
export function packageBinScript(pkgDir: string, bin: string, plat: NodeJS.Platform): string | null {
  try {
    const pj = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { bin?: unknown };
    const rel = typeof pj.bin === 'string' ? pj.bin : (pj.bin && typeof pj.bin === 'object' ? (pj.bin as Record<string, unknown>)[bin] : undefined);
    if (typeof rel !== 'string' || rel === '') return null;
    const full = resolve(pkgDir, rel);
    if (!isInside(pkgDir, full, plat)) return null;
    return existsSync(full) ? full : null;
  } catch { return null; }
}

/** 作業場所の tools/node_modules に入れた npm パッケージの、実行コマンド（Windows: node で JS を直接）。 */
export function localNpmTool(ws: string, pkg: string, bin: string, plat: NodeJS.Platform, execPath: string): Resolved | null {
  const script = packageBinScript(join(ws, 'tools', 'node_modules', pkg), bin, plat);
  return script ? { cmd: nodeForTools(ws, plat, execPath), args: [script], local: true } : null;
}

/**
 * PATH に入っている（`npm install -g` した）npm パッケージの、実行コマンド（Windows）。
 * PATH のフォルダに `<bin>.cmd` があり、同じフォルダの `node_modules/<pkg>` があるものを探す。
 */
export function globalNpmTool(pkg: string, bin: string, pathValue: string, plat: NodeJS.Platform, execPath: string): Resolved | null {
  for (const dir of pathValue.split(pathDelimiter(plat)).map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    if (!existsSync(join(dir, `${bin}.cmd`))) continue;
    const script = packageBinScript(join(dir, 'node_modules', pkg), bin, plat);
    if (script) return { cmd: execPath, args: [script], local: false };
  }
  return null;
}

// ---- 停止・権限 ----

/** Windows: 子プロセスを、子孫ごと止める（`taskkill /T /F`）。 */
export function killTree(pid: number | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  const exe = join(root, 'System32', 'taskkill.exe');
  try {
    const c = spawn(existsSync(exe) ? exe : 'taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, stdio: 'ignore', windowsHide: true });
    c.on('error', () => { /* もう終わっている */ });
  } catch { /* もう終わっている */ }
}

/** Windows: 管理者権限（昇格）で動いているか。`fltmc` は、昇格していないと失敗する。 */
export function isElevatedWindows(env: NodeJS.ProcessEnv = process.env): boolean {
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  const exe = join(root, 'System32', 'fltmc.exe');
  if (!existsSync(exe)) return false;
  try {
    const r = spawnSync(exe, [], { shell: false, stdio: 'ignore', windowsHide: true, timeout: 5000 });
    return r.status === 0;
  } catch { return false; }
}

/** 展開に使う tar。Windows は、標準の `System32\tar.exe`（zip も読める bsdtar）。Git の GNU tar は、zip を読めず、`C:` をホスト名と取り違える。 */
export function systemTar(plat: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string {
  if (!isWindows(plat)) return 'tar';
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  const exe = join(root, 'System32', 'tar.exe');
  return existsSync(exe) ? exe : 'tar';
}
