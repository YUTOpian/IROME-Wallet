// ノード構築エージェント: Node.js・Python を、作業場所の tools/ の中だけに入れる／消す。
// - sudo は使わない。OS 全体には何も入れない（Docker は、管理者権限が要るため、ここでは扱わない。Docker は dockerInstall.ts の、sudo を 1 回だけ使う別の手順）。
// - 取りに行く先は、決まったホストの https だけ。ダウンロードしたものは、配布元の SHA-256 の一覧と合わせてから展開する。
//   （この確認は、転送の破損と、ファイル単体のすり替えを防ぐもの。配布元そのものが侵害された場合は防げない。）
// - シェルは通さない。展開は、固定の引数で `tar` を呼ぶだけ（Windows は標準の System32\tar.exe。zip も読める）。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { isInside, localNodeExe, localPythonExe, systemTar } from './platform';

/** 取りに行ってよいホスト（https のみ）。リダイレクト先も、毎回ここで確かめる。 */
export const DOWNLOAD_HOSTS: readonly string[] = [
  'nodejs.org',
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];

/** tools/node に入れる Node.js のメジャー版（エージェント自身の下限 22.12 に合わせる）。 */
export const NODE_MAJOR = 22;
/** tools/python に入れる Python のマイナー版（symbol-shoestring が使える範囲の安定版）。 */
export const PYTHON_MINOR = '3.12';

const MAX_JSON = 20 * 1024 * 1024;
const MAX_ARCHIVE = 300 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export interface ProvisionCtx {
  ws: string;
  out: (text: string) => void;
  /** 停止が頼まれたか（ダウンロードの途中で見る） */
  stopped: () => boolean;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  /** 展開（試験用に差し替える。省略は、tar）。 */
  extract?: (archive: string, dest: string) => Promise<boolean>;
  /** 取りに行ってよいホスト（省略は DOWNLOAD_HOSTS）。Docker の鍵の取得は、download.docker.com の 1 つだけに絞って渡す。 */
  allowedHosts?: readonly string[];
  /** 何も届かないまま待ってよい時間（ミリ秒）。省略は 120 秒。大きなファイルは、届くたびに数え直す（全体の時間ではない）。 */
  idleTimeoutMs?: number;
}

export const toolsPath = (ws: string) => join(ws, 'tools');

export function hostAllowed(url: string, hosts: readonly string[] = DOWNLOAD_HOSTS): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && u.port === '' && u.username === '' && u.password === '' && hosts.includes(u.hostname);
}

/** 許可したホストだけ、リダイレクトも手で追って（最大 5 回）取得し、届いた分を onChunk に渡す。サイズの上限と、停止の確認つき。 */
async function fetchChunks(url: string, ctx: ProvisionCtx, maxBytes: number, onChunk: (chunk: Buffer) => void): Promise<void> {
  const f = ctx.fetchImpl ?? fetch;
  const idleMs = ctx.idleTimeoutMs ?? TIMEOUT_MS;
  let cur = url;
  for (let hop = 0; hop <= 5; hop++) {
    if (!hostAllowed(cur, ctx.allowedHosts)) throw new Error(`許可していない取得先です: ${cur}`);
    const ac = new AbortController();
    let timer = setTimeout(() => ac.abort(), idleMs);
    try {
      const res = await f(cur, { redirect: 'manual', signal: ac.signal, headers: { 'User-Agent': 'irome-node-agent', Accept: '*/*' } });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('リダイレクト先がありません');
        cur = new URL(loc, cur).toString();
        continue;
      }
      if (!res.ok) throw new Error(`取得に失敗しました（HTTP ${res.status}）: ${cur}`);
      const len = Number(res.headers.get('content-length') ?? '0');
      if (len > maxBytes) throw new Error('ファイルが大きすぎます');
      if (!res.body) throw new Error('本文がありません');
      let total = 0;
      const reader = res.body.getReader();
      for (;;) {
        if (ctx.stopped()) { ac.abort(); throw new Error('停止しました'); }
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(timer);
        timer = setTimeout(() => ac.abort(), idleMs);
        total += value.byteLength;
        if (total > maxBytes) { ac.abort(); throw new Error('ファイルが大きすぎます'); }
        onChunk(Buffer.from(value));
      }
      return;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('リダイレクトが多すぎます');
}

/** 許可したホストだけから取得して、メモリに返す（小さいファイル用）。 */
export async function download(url: string, ctx: ProvisionCtx, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await fetchChunks(url, ctx, maxBytes, (c) => chunks.push(c));
  return Buffer.concat(chunks);
}

/** 許可したホストだけから取得して、ファイルに直接書く（大きいファイル用。メモリに溜めない）。dest は、まだ無いパス。失敗・停止のときは、書きかけを消す。 */
export async function downloadToFile(url: string, dest: string, ctx: ProvisionCtx, maxBytes: number, onProgress?: (bytes: number) => void): Promise<{ bytes: number; sha256: string }> {
  const fd = openSync(dest, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    await fetchChunks(url, ctx, maxBytes, (c) => { writeSync(fd, c); hash.update(c); bytes += c.length; onProgress?.(bytes); });
  } catch (e) {
    closeSync(fd);
    rmSync(dest, { force: true });
    throw e;
  }
  closeSync(fd);
  return { bytes, sha256: hash.digest('hex') };
}

export const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** `<hash>  <name>`（SHA256SUMS の形式）から、名前に対応するハッシュを探す。 */
export function findSum(list: string, name: string): string | null {
  for (const line of list.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m && m[2] === name) return m[1];
  }
  return null;
}

export function nodeTarget(platform: NodeJS.Platform, arch: string): string | null {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win' : null;
  const a = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  return os && a ? `${os}-${a}` : null;
}

/** Node.js の配布ファイルの拡張子。Windows は zip、それ以外は tar.gz。 */
export const nodeArchiveExt = (target: string) => (target.startsWith('win-') ? 'zip' : 'tar.gz');

export function pythonTriple(platform: NodeJS.Platform, arch: string): string | null {
  const k = `${platform}/${arch}`;
  switch (k) {
    case 'linux/x64': return 'x86_64-unknown-linux-gnu';
    case 'linux/arm64': return 'aarch64-unknown-linux-gnu';
    case 'darwin/x64': return 'x86_64-apple-darwin';
    case 'darwin/arm64': return 'aarch64-apple-darwin';
    case 'win32/x64': return 'x86_64-pc-windows-msvc';
    case 'win32/arm64': return 'aarch64-pc-windows-msvc';
    default: return null;
  }
}

/** 固定の引数で、実行ファイルを呼んで標準出力を返す（失敗は null）。 */
export function probeCmd(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    let buf = '';
    try {
      const c = spawn(cmd, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const t = setTimeout(() => c.kill('SIGKILL'), 15_000);
      c.stdout?.on('data', (d: Buffer) => { buf += d.toString('utf8'); });
      c.stderr?.on('data', (d: Buffer) => { buf += d.toString('utf8'); });
      c.on('error', () => { clearTimeout(t); done(null); });
      c.on('close', (code) => { clearTimeout(t); done(code === 0 ? buf.trim() : null); });
    } catch { done(null); }
  });
}

function extractWithTar(archive: string, dest: string, plat: NodeJS.Platform): Promise<boolean> {
  return new Promise((done) => {
    try {
      // -xf は、tar.gz も zip も、中身を見て読む（zip は bsdtar = Windows 標準の tar.exe）。
      const c = spawn(systemTar(plat), ['-xf', archive, '-C', dest, '--strip-components=1'], { shell: false, stdio: 'ignore', windowsHide: true });
      c.on('error', () => done(false));
      c.on('close', (code) => done(code === 0));
    } catch { done(false); }
  });
}

/** tools/<name> へ、展開済みのフォルダを入れ替える（途中で失敗しても、元のものは壊さない）。 */
async function fetchAndExtract(ctx: ProvisionCtx, name: 'node' | 'python', archiveUrl: string, fileName: string, expectedSha: string): Promise<string | null> {
  const tools = toolsPath(ctx.ws);
  mkdirSync(tools, { recursive: true });
  ctx.out(`ダウンロードします: ${fileName}\n`);
  const data = await download(archiveUrl, ctx, MAX_ARCHIVE);
  ctx.out(`  ${(data.length / 1024 / 1024).toFixed(1)} MB\n`);
  const got = sha256(data);
  if (got !== expectedSha) { ctx.out(`SHA-256 が一致しません（期待 ${expectedSha} / 実際 ${got}）。入れません。\n`); return null; }
  ctx.out('SHA-256 が一致しました。\n');
  const tmp = mkdtempSync(join(tools, `.${name}-tmp-`));
  try {
    const archive = join(tmp, fileName.endsWith('.zip') ? 'archive.zip' : 'archive.tar.gz');
    writeFileSync(archive, data);
    const stage = join(tmp, 'stage');
    mkdirSync(stage);
    ctx.out('展開します…\n');
    if (!(await (ctx.extract ?? ((a, d) => extractWithTar(a, d, ctx.platform ?? process.platform)))(archive, stage))) {
      ctx.out('展開に失敗しました（tar が使えない、またはファイルが壊れています。Windows は 10 以降の標準の tar.exe が要ります）。\n');
      rmSync(tmp, { recursive: true, force: true });
      return null;
    }
    return stage;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

function swapIn(ctx: ProvisionCtx, name: 'node' | 'python', stage: string): void {
  const dest = join(toolsPath(ctx.ws), name);
  if (existsSync(dest)) {
    if (lstatSync(dest).isSymbolicLink()) throw new Error(`tools/${name} がシンボリックリンクなので、置き換えません`);
    rmSync(dest, { recursive: true, force: true });
  }
  renameSync(stage, dest);
  // 一時フォルダの残り（archive.tar.gz）を片づける
  const parent = join(stage, '..');
  rmSync(parent, { recursive: true, force: true });
}

export async function installNode(ctx: ProvisionCtx): Promise<number> {
  const target = nodeTarget(ctx.platform ?? process.platform, ctx.arch ?? process.arch);
  if (!target) { ctx.out('この OS・CPU には、画面から Node.js を入れられません（Linux / macOS / Windows の x64・arm64 だけ）。\n'); return 1; }
  const plat = ctx.platform ?? process.platform;
  const ext = nodeArchiveExt(target);
  const base = `https://nodejs.org/dist/latest-v${NODE_MAJOR}.x`;
  try {
    ctx.out(`Node.js ${NODE_MAJOR}.x の最新版を調べます…\n`);
    const sums = (await download(`${base}/SHASUMS256.txt`, ctx, MAX_JSON)).toString('utf8');
    const m = new RegExp(`^[0-9a-f]{64}\\s+\\*?(node-v(\\d+\\.\\d+\\.\\d+)-${target}\\.${ext === 'zip' ? 'zip' : 'tar\\.gz'})\\s*$`, 'm').exec(sums);
    if (!m) { ctx.out(`この環境（${target}）向けのファイルが、配布元の一覧にありません。\n`); return 1; }
    const sum = findSum(sums, m[1]);
    if (!sum) { ctx.out('配布元の一覧に、ハッシュがありません。\n'); return 1; }
    const stage = await fetchAndExtract(ctx, 'node', `${base}/${m[1]}`, m[1], sum);
    if (!stage) return 1;
    swapIn(ctx, 'node', stage);
    const v = await probeCmd(localNodeExe(ctx.ws, plat), ['--version']);
    if (!v) { ctx.out(`入れましたが、tools/node の node が動きません（${localNodeExe(ctx.ws, plat)}）。\n`); return 1; }
    ctx.out(`Node.js ${v} を、tools/node に入れました。symbol-bootstrap・symbol-node-watcher の導入・実行は、これを先に使います。\n`);
    return 0;
  } catch (e) {
    ctx.out(`入れられませんでした: ${(e as Error).message}\n`);
    return 1;
  }
}

interface GhAsset { name: string; browser_download_url: string }

export async function installPython(ctx: ProvisionCtx): Promise<number> {
  const triple = pythonTriple(ctx.platform ?? process.platform, ctx.arch ?? process.arch);
  if (!triple) { ctx.out('この OS・CPU には、画面から Python を入れられません（Linux / macOS / Windows の x64・arm64 だけ）。\n'); return 1; }
  const plat = ctx.platform ?? process.platform;
  try {
    ctx.out('Python（python-build-standalone）の最新リリースを調べます…\n');
    const rel = JSON.parse((await download('https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest', ctx, MAX_JSON)).toString('utf8')) as { assets?: GhAsset[] };
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const re = new RegExp(`^cpython-(${PYTHON_MINOR.replace('.', '\\.')}\\.(\\d+))\\+[0-9]+-${triple}-install_only\\.tar\\.gz$`);
    const cands = assets
      .map((a) => ({ a, m: re.exec(a.name) }))
      .filter((x): x is { a: GhAsset; m: RegExpExecArray } => x.m !== null)
      .sort((x, y) => Number(y.m[2]) - Number(x.m[2]));
    if (cands.length === 0) { ctx.out(`Python ${PYTHON_MINOR} の、この環境（${triple}）向けのファイルが見つかりません。\n`); return 1; }
    const pick = cands[0].a;
    const sumsAsset = assets.find((a) => a.name === 'SHA256SUMS');
    if (!sumsAsset) { ctx.out('配布元に SHA256SUMS がありません。確認できないので入れません。\n'); return 1; }
    const sums = (await download(sumsAsset.browser_download_url, ctx, MAX_JSON)).toString('utf8');
    const sum = findSum(sums, pick.name);
    if (!sum) { ctx.out('SHA256SUMS に、このファイルのハッシュがありません。入れません。\n'); return 1; }
    const stage = await fetchAndExtract(ctx, 'python', pick.browser_download_url, pick.name, sum);
    if (!stage) return 1;
    swapIn(ctx, 'python', stage);
    const py = localPythonExe(ctx.ws, plat);
    const v = await probeCmd(py, ['--version']);
    // pty・termios は Linux / macOS だけ（Windows には無い）
    const need = plat === 'win32' ? 'venv, ssl' : 'venv, ssl, pty, termios';
    const mods = await probeCmd(py, ['-c', `import ${need}`]);
    if (!v || mods === null) { ctx.out(`入れましたが、tools/python の python が動かない、または ${need} が使えません。\n`); return 1; }
    ctx.out(`${v} を、tools/python に入れました。Shoestring の導入（tools/venv）は、これを先に使います（Linux / macOS は、端末（pty）も）。\n`);
    return 0;
  } catch (e) {
    ctx.out(`入れられませんでした: ${(e as Error).message}\n`);
    return 1;
  }
}

/** tools/<name> を消す。シンボリックリンクなら消さない。作業場所の外を指していても消さない。 */
export function removeTool(ws: string, name: 'node' | 'python', out: (t: string) => void, plat: NodeJS.Platform = process.platform): number {
  const dir = join(toolsPath(ws), name);
  if (!existsSync(dir)) { out(`tools/${name} はありません。\n`); return 0; }
  if (lstatSync(dir).isSymbolicLink()) { out(`tools/${name} がシンボリックリンクなので、削除しません。\n`); return 1; }
  const root = realpathSync(ws);
  const real = realpathSync(dir);
  if (!isInside(root, real, plat)) { out(`tools/${name} が作業場所の外を指しているので、削除しません。\n`); return 1; }
  if (name === 'python' && existsSync(join(toolsPath(ws), 'venv'))) {
    out('tools/venv（Shoestring）が、この Python を使っています。先に「irome uninstall shoestring」で消してください。\n');
    return 1;
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: plat === 'win32' ? 5 : 0, retryDelay: 200 });
  } catch (e) {
    out(`削除できませんでした（${(e as Error).message}）。${name === 'node' ? 'tools/node の node' : 'tools/python の python'} を使っているものが動いていないか確かめてください（Windows は、動いている実行ファイルを消せません）。\n`);
    return 1;
  }
  if (existsSync(dir)) { out(`まだ残っています: ${dir}\n`); return 1; }
  out(`tools/${name} を削除しました。\n`);
  return 0;
}

/** 一時フォルダの取り残し（`.node-tmp-*` など）を片づける。起動時と導入の前に呼ぶ。 */
export function sweepTmp(ws: string): void {
  const tools = toolsPath(ws);
  if (!existsSync(tools)) return;
  for (const e of readdirSync(tools)) {
    if (!/^\.(node|python|docker)-tmp-/.test(e)) continue;
    // 開いたままのディスクイメージ（読み取り専用）が残っていると消せない。起動を止めないよう、消せなければ、そのままにする
    try { rmSync(join(tools, e), { recursive: true, force: true }); } catch { /* そのまま */ }
  }
}
