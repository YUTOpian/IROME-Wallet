// ノード構築エージェント（サーバー専用・ローカル専用）。
//
// ブラウザのウォレットは、シェルも Docker も触れない。そこで、同じ PC で別に起動したこのプロセスが、
// ウォレットから届いた「許可されたコマンド」だけを実行し、出力を返す（Bitcoin Core のように、ウォレットから環境構築をするための橋）。
//
// 安全のための決まり:
// - 待ち受けは 127.0.0.1 だけ。Host ヘッダが 127.0.0.1 / localhost 以外なら断る（DNS リバインディング対策）。
// - 起動のたびに作るランダムなトークン（Authorization: Bearer）が無い要求は断る。
// - Origin が許可リストに無い要求は断る（既定: file://（"null"）・GitHub Pages・localhost の開発サーバー）。
// - 実行できるのは lib/node/nodeCommands.ts の許可リストだけ。シェルは通さない（spawn に引数の配列を渡す）。毎回ここで再判定する。
// - ウォレットの秘密鍵・ニーモニックは、このエージェントに渡らない（渡す仕組みが無い）。
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { EDITABLE_EXTENSIONS, MAX_FILE_BYTES, UPGRADE_TARGETS, isKeyMaterialPath, isSecretArgv, isWizardArgv, parseCommandLine, validateArgv, validateSubdir, validateWorkspaceFile } from '../../lib/node/nodeCommands';
import { parseAddressesYml, withVotings } from '../../lib/node/nodeKeys';
import { collectHostStats } from './host';
import { createWatchdog } from './watchdog';
import { findComposeDirs } from './composeDirs';
import { findExistingNodes } from './existingNodes';
import { nemSteps } from './nemNode';
import type { RestartResult } from './watchdog';
import { AUTO_RESTART_LIMITS, AUTO_RESTART_LINE } from '../../lib/node/nodeAutoRestart';
import { sanitizeWatchdogConfig } from '../../lib/node/nodeWatchdog';
import { readCertKeys } from './certKeys';
import { attachVotingTrees, readVotingTrees } from './votingTrees';
import { mergeShoestringKeys, readShoestringKeys } from './shoestringKeys';
import type { NodeKeySet } from '../../lib/node/nodeKeys';
import type { InstallTarget, NemAction, ToolName } from '../../lib/node/nodeCommands';
import { installNode, installPython, probeCmd, removeTool, sweepTmp } from './provision';
import { dockerInstallSteps } from './dockerInstall';
import type { DockerInstallEnv } from './dockerInstall';
import { childEnv, envPathKey, globalNpmTool, isInside, isWindows, killTree, localNodeExe, localNpmTool, localPythonExe, npmBinPath, npmCommand, venvPythonPath } from './platform';
import type { Resolved } from './platform';

export const AGENT_VERSION = 1;
const MAX_BODY = 400 * 1024; // 設定ファイルの保存（最大 256KB）が入る大きさ
const MAX_OUTPUT = 1_000_000;
const MAX_RUNNING = 3;
const MAX_JOBS_KEPT = 30;
const KILL_GRACE_MS = 5000;
const SECRET_OUTPUT_KEEP_MS = 30_000;

export interface AgentOptions {
  token: string;
  workspace: string;
  /** 許可する Origin。'null'（file://）を含められる。localhost / 127.0.0.1 の http は常に許可。 */
  origins: string[];
  /** テスト用: 実行ファイルの解決を差し替える。 */
  resolve?: (tool: ToolName, argv: string[], ws: string) => Resolved | null;
  /** 本物の端末（pty）で動かすか。省略は自動（Linux / macOS で python3 の pty が使えるときだけ）。false で、これまでどおりパイプだけにする。 */
  pty?: boolean;
  /** Node.js・Python の導入で使う fetch（試験用に差し替える。省略は、組み込みの fetch）。 */
  fetch?: typeof fetch;
  /** 導入先の OS・CPU（試験用。省略は、この PC）。 */
  platform?: NodeJS.Platform;
  arch?: string;
  /** 秘密鍵が出たコマンドの出力を、終わってからメモリに残す時間（ミリ秒。試験用。省略は 30 秒）。 */
  secretOutputKeepMs?: number;
  /** 常駐ウォッチドッグの「1 回見る」を差し替える（試験用）。 */
  watchdogFetch?: NonNullable<Parameters<typeof createWatchdog>[0]['fetchImpl']>;
  watchdogProbe?: (base: string) => Promise<import('../../lib/node/nodeWatch').WatchSample>;
}

export type { Resolved };
/** run があるときは、外部コマンドを起動せず、この関数を実行する（tools/ の中の削除・確認だけに使う）。戻り値は終了コード。 */
export interface Step { label: string; cmd: string; args: string[]; cwd: string; /** 起動の直前に、引数を決める（Docker の導入の sudo 用）。配列なら、その引数で起動する。'skip' は、何もせず成功。null は、失敗。 */ prepare?: (out: (text: string) => void, ctl: { stopped: () => boolean }) => Promise<string[] | 'skip' | null>; run?: (out: (text: string) => void, ctl: { stopped: () => boolean }) => number | Promise<number>; /** 端末（pty）で動かす（symbol-bootstrap / shoestring / symbol-node-watcher の、画面から打ったコマンドだけ） */ pty?: boolean; /** 出力を、エスケープ列を消さずに生のまま返す（画面の簡易ターミナルが描く。wizard を有効にして、画面が頼んだときだけ） */ raw?: boolean }

interface Job {
  id: string;
  line: string;
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  running: boolean;
  buf: string;
  base: number; // buf の先頭が、全体の何文字目か
  child: ChildProcess | null;
  stopRequested: boolean;
  /** 端末で動かしているステップの、出力の整形の途中経過（UTF-8 の途中・エスケープ列の途中・行末の CR を、次の塊まで持ち越す） */
  dec: StringDecoder | null;
  rest: string;
  /** 端末（pty）で動いている（キーを送れる） */
  pty: boolean;
  /** 秘密鍵が出る形のコマンド（確認を通したもの）。終わって少し経ったら、出力をエージェントのメモリからも消す。 */
  secret: boolean;
  /** 出力を生のまま（エスケープ列つき）で返している。画面の簡易ターミナルが描く。 */
  raw: boolean;
}

const isWin = process.platform === 'win32';

/**
 * 本物の端末（pty）の中でコマンドを動かす小さな補助（Python 標準の pty。ネイティブの追加パッケージは要らない）。
 * `python3 -c <これ> <実行ファイル> <引数…>` の形で、シェルは通さず、引数の配列をそのまま渡す。
 * - 子プロセスの標準入出力を端末にする（パスワードを聞くコマンドが動く。パスワードは、端末が画面に出さない）。
 * - 端末の ECHO は切っておく（入力した文字は、画面側が表示する。二重に出さない）。
 * - 子プロセスが終わったら、端末を握ったままの孫プロセスがいても、残りの出力を読んで終わる。終了コードをそのまま返す。
 * - SIGTERM / SIGINT / SIGHUP は、子プロセスのグループに転送する（画面の「停止」が効く）。
 */
export const PTY_HELPER = `
import os, sys, pty, select, signal, termios, struct, fcntl
argv = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    try:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        a = termios.tcgetattr(0)
        a[3] = a[3] & ~termios.ECHO
        termios.tcsetattr(0, termios.TCSANOW, a)
    except Exception:
        pass
    try:
        os.execvp(argv[0], argv)
    except OSError as e:
        m = ('見つかりません: ' if e.errno == 2 else '実行できません: ') + argv[0] + '\\n'
        os.write(2, m.encode('utf-8'))
        os._exit(127)
def fwd(sig, frm):
    try:
        os.killpg(pid, sig)
    except Exception:
        try:
            os.kill(pid, sig)
        except Exception:
            pass
for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(s, fwd)
def pump(block):
    r, _, _ = select.select([fd] + ([0] if stdin_open[0] else []), [], [], 0.2 if block else 0)
    got = False
    if fd in r:
        try:
            d = os.read(fd, 4096)
        except OSError:
            d = b''
        if d:
            os.write(1, d)
            got = True
        else:
            return None
    if 0 in r:
        d = os.read(0, 4096)
        if not d:
            stdin_open[0] = False
        else:
            try:
                os.write(fd, d)
            except OSError:
                pass
    return got
stdin_open = [True]
status = None
while True:
    if pump(True) is None:
        break
    w, st = os.waitpid(pid, os.WNOHANG)
    if w:
        status = st
        while pump(False):
            pass
        break
if status is None:
    _, status = os.waitpid(pid, 0)
if os.WIFEXITED(status):
    sys.exit(os.WEXITSTATUS(status))
sys.exit(128 + (os.WTERMSIG(status) if os.WIFSIGNALED(status) else 1))
`;

/** 端末に送れるキー（対話式の画面を操作する用。決まったものだけ。画面から任意のバイト列は送れない）。 */
export const TTY_KEYS: Readonly<Record<string, string>> = {
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', enter: '\r', space: ' ', tab: '\t',
};

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const TAIL_RE = /(\x1b(\[[0-9;?]*[ -/]*|\][^\x07]*)?|\r)$/;
/** 端末の出力を、画面に出せる文字にする: エスケープ列を消し、CRLF を LF にする（行頭に戻すだけの CR も、改行にする）。途中で切れた末尾は rest に持ち越す。 */
export function cleanTty(job: { dec: StringDecoder | null; rest: string }, chunk: Buffer | null): string {
  const dec = job.dec ?? (job.dec = new StringDecoder('utf8'));
  let text = job.rest + (chunk ? dec.write(chunk) : dec.end());
  job.rest = '';
  if (chunk) {
    const m = TAIL_RE.exec(text);
    if (m && m[0].length < 200) { job.rest = m[0]; text = text.slice(0, text.length - m[0].length); }
  }
  return text.replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
const RAW_TAIL_RE = /\x1b(\[[0-9;?]*[ -/]*|\][^\x07]*)?$/;
/**
 * 端末の出力を、エスケープ列を消さずにそのまま返す（画面の簡易ターミナルが、カーソル移動などを自分で描く）。
 * UTF-8 の途中と、エスケープ列の途中で切れた末尾だけは、次の塊まで持ち越す（途中で割れると、画面側で崩れるため）。
 */
export function rawTty(job: { dec: StringDecoder | null; rest: string }, chunk: Buffer | null): string {
  const dec = job.dec ?? (job.dec = new StringDecoder('utf8'));
  let text = job.rest + (chunk ? dec.write(chunk) : dec.end());
  job.rest = '';
  if (chunk) {
    const m = RAW_TAIL_RE.exec(text);
    if (m && m[0].length < 200) { job.rest = m[0]; text = text.slice(0, text.length - m[0].length); }
  }
  return text;
}
const toolsDir = (ws: string) => join(ws, 'tools');
const plat = process.platform;
/** tools/python があれば、その python を先に使う（Shoestring の venv・pty の補助）。 */
const basePython = (ws: string) => { const p = localPythonExe(ws, plat); return existsSync(p) ? p : (isWin ? 'python' : 'python3'); };
const venvPython = (ws: string) => venvPythonPath(ws, plat);

/** ツール名を、実行ファイルと引数に解決する。ワークスペースの tools/ に入れたものを先に探し、なければ PATH の名前をそのまま使う。 */
export function defaultResolve(tool: ToolName, argv: string[], ws: string, platform: NodeJS.Platform = process.platform, execPath: string = process.execPath, env: NodeJS.ProcessEnv = process.env): Resolved | null {
  const rest = argv.slice(1);
  switch (tool) {
    case 'symbol-bootstrap':
    case 'symbol-node-watcher': {
      if (isWindows(platform)) {
        // Windows: npm が作る `.cmd` はシェルなしで動かせない。package.json の bin が指す JavaScript を、node で直接動かす。
        const loc = localNpmTool(ws, tool, tool, platform, execPath) ?? globalNpmTool(tool, tool, env[envPathKey(env, platform)] ?? '', platform, execPath);
        return loc ? { ...loc, args: [...loc.args, ...rest] } : { cmd: tool, args: rest };
      }
      const local = npmBinPath(ws, tool, platform);
      return { cmd: existsSync(local) ? local : tool, args: rest, ...(existsSync(local) ? { local: true } : {}) };
    }
    case 'shoestring': {
      const py = venvPythonPath(ws, platform);
      // `shoestring wizard` は、この画面の呼び名。Shoestring の wizard モジュール（python -m shoestring.wizard）に置き換えて動かす（引数は付けない）
      if (rest[0] === 'wizard') return existsSync(py) ? { cmd: py, args: ['-m', 'shoestring.wizard'], local: true } : { cmd: isWindows(platform) ? 'python' : 'python3', args: ['-m', 'shoestring.wizard'] };
      return existsSync(py) ? { cmd: py, args: ['-m', 'shoestring', ...rest], local: true } : { cmd: 'shoestring', args: rest };
    }
    case 'pip': {
      // 公式の `python3 -m pip …`（install / install --upgrade / show の symbol-shoestring だけ）。tools/venv があればその Python の pip、なければ PC の python3 の pip
      const py = venvPythonPath(ws, platform);
      const pipArgs = ['-m', 'pip', ...argv.slice(3)];
      return existsSync(py) ? { cmd: py, args: pipArgs, local: true } : { cmd: isWindows(platform) ? 'python' : 'python3', args: pipArgs };
    }
    case 'docker': return { cmd: 'docker', args: rest };
    case 'openssl': return { cmd: 'openssl', args: rest };
    case 'node': return { cmd: execPath, args: rest };
    default: return null;
  }
}

/** npm を動かす 1 手順。Windows は npm.cmd を使えないので、node で npm-cli.js を直接。見つからなければ、案内を出して止まる。 */
function npmStepFor(ws: string, pl: NodeJS.Platform, label: string, args: string[], execPath: string = process.execPath, cwd: string = ws): Step {
  const c = npmCommand(ws, args, pl, execPath);
  if (c) return { label, cmd: c.cmd, args: c.args, cwd };
  return { label, cmd: '', args: [], cwd: ws, run: (out) => { out('npm（npm-cli.js）が見つかりません。先に「irome install node」で Node.js を tools/ に入れるか、npm つきの Node.js を入れてください。\n'); return 1; } };
}

/** 入れたツールが動くかの確認。Windows は、入れたあとで、package.json の bin から探して node で動かす（手順を組む時点では、まだ無いため）。 */
function versionStep(ws: string, pl: NodeJS.Platform, pkg: string, execPath: string = process.execPath): Step {
  if (!isWindows(pl)) return { label: '入ったか確認します', cmd: npmBinPath(ws, pkg, pl), args: ['--version'], cwd: ws };
  return {
    label: '入ったか確認します', cmd: '', args: [], cwd: ws,
    run: async (out) => {
      const r = localNpmTool(ws, pkg, pkg, pl, execPath);
      if (!r) { out(`${pkg} の実行ファイルが見つかりません（tools/node_modules/${pkg}）。\n`); return 1; }
      const v = await probeCmd(r.cmd, [...r.args, '--version']);
      if (v === null) { out(`${pkg} が動きません。\n`); return 1; }
      out(`${v}\n`);
      return 0;
    },
  };
}

/** `irome install …` の手順。エージェントが固定で組む（画面から任意の引数は入らない）。 */
export interface ProvisionEnv { fetch?: typeof fetch; platform?: NodeJS.Platform; arch?: string; /** このエージェント自身の node（試験用）。省略は process.execPath */ execPath?: string; /** Docker の導入の差し替え（試験用） */ docker?: DockerInstallEnv['hooks'] }

export function installSteps(target: InstallTarget, ws: string, env: ProvisionEnv = {}): Step[] {
  const tools = toolsDir(ws);
  const pl = env.platform ?? process.platform;
  const prov = (out: (t: string) => void, ctl: { stopped: () => boolean }) => ({ ws, out, stopped: ctl.stopped, fetchImpl: env.fetch, platform: env.platform, arch: env.arch });
  const npmStep = (label: string, args: string[]): Step => npmStepFor(ws, pl, label, args, env.execPath);
  switch (target) {
    case 'node': return [
      { label: 'Node.js を tools/node に入れます（nodejs.org から取得し、SHA-256 を確かめます）', cmd: '', args: [], cwd: ws, run: (out, ctl) => { sweepTmp(ws); return installNode(prov(out, ctl)); } },
    ];
    case 'docker': return dockerInstallSteps(ws, { platform: env.platform, fetch: env.fetch, hooks: env.docker });
    case 'python': return [
      { label: 'Python を tools/python に入れます（python-build-standalone を GitHub から取得し、SHA-256 を確かめます）', cmd: '', args: [], cwd: ws, run: (out, ctl) => { sweepTmp(ws); return installPython(prov(out, ctl)); } },
    ];
    case 'bootstrap': return [
      npmStep('symbol-bootstrap をワークスペースの tools/ に入れます', ['install', '--prefix', tools, 'symbol-bootstrap']),
      versionStep(ws, pl, 'symbol-bootstrap', env.execPath),
    ];
    case 'nodewatch': return [
      npmStep('symbol-node-watcher をワークスペースの tools/ に入れます', ['install', '--prefix', tools, 'symbol-node-watcher']),
    ];
    case 'shoestring': return [
      { label: 'Python の仮想環境（tools/venv）を作ります', cmd: basePython(ws), args: ['-m', 'venv', join(tools, 'venv')], cwd: ws },
      { label: 'symbol-shoestring を入れます', cmd: venvPython(ws), args: ['-m', 'pip', 'install', 'symbol-shoestring'], cwd: ws },
      { label: '入ったか確認します', cmd: venvPython(ws), args: ['-m', 'pip', 'show', 'symbol-shoestring'], cwd: ws },
    ];
  }
}

/** symbol-bootstrap の公式リポジトリ（固定。画面からは変えられない）。 */
export const BOOTSTRAP_REPO = 'https://github.com/symbol/symbol-bootstrap.git';

/** tools/ の中のフォルダを消す。シンボリックリンクは辿らず、tools/ の外に出るものは消さない。無ければ何もしない。 */
function removeInTools(ws: string, dir: string, out: (t: string) => void, pl: NodeJS.Platform): number {
  let st;
  try { st = lstatSync(dir); } catch { return 0; }
  if (st.isSymbolicLink()) { out(`${dir} がシンボリックリンクなので、消しません。\n`); return 1; }
  try {
    if (!isInside(realpathSync(join(ws, 'tools')), realpathSync(dir), pl)) { out(`${dir} が tools/ の外なので、消しません。\n`); return 1; }
    rmSync(dir, { recursive: true, force: true });
    return 0;
  } catch (e) { out(`消せません: ${(e as Error).message}\n`); return 1; }
}

/**
 * `irome upgrade bootstrap` の手順: 公式の更新手順（git clone → npm install → npm run build → npm pack --ignore-scripts → npm install）を、
 * `-g` も `sudo` も使わず、作業場所の tools/ の中だけで行う。エージェントが固定で組む（取得先は公式リポジトリに固定）。
 * npm の公開版は、公式の版に追いついていないことがあるため、公式の手順どおり、ソースからビルドする。
 * できた .tgz は tools/packages/ に残す（tools/package.json がそれを指すので、あとで別のパッケージを入れても、元の版に戻らない）。
 */
function bootstrapUpgradeSteps(ws: string, env: ProvisionEnv): Step[] {
  const pl = env.platform ?? process.platform;
  const tools = toolsDir(ws);
  const src = join(tools, '.upgrade', 'symbol-bootstrap');
  const keep = join(tools, 'packages', 'symbol-bootstrap.tgz');
  const npm = (label: string, args: string[], cwd: string = ws): Step => npmStepFor(ws, pl, label, args, env.execPath, cwd);
  const own = (label: string, run: NonNullable<Step['run']>): Step => ({ label, cmd: '', args: [], cwd: ws, run });
  return [
    own('準備を確かめます（tools/ の symbol-bootstrap と git）', async (out) => {
      const pj = join(tools, 'node_modules', 'symbol-bootstrap', 'package.json');
      if (!existsSync(pj)) { out('tools/ に symbol-bootstrap が入っていません。先に「irome install bootstrap」で入れてください。\n'); return 1; }
      try { out(`いまの版: ${(JSON.parse(readFileSync(pj, 'utf8')) as { version?: string }).version ?? '不明'}\n`); } catch { /* 版が読めなくても続ける */ }
      if ((await probeCmd('git', ['--version'])) === null) { out('git が見つかりません。公式の更新手順は git clone から始まるので、先に git を入れてください。\n'); return 1; }
      return removeInTools(ws, src, out, pl); // 前回の途中で止まったものが残っていれば、先に消す
    }),
    { label: '公式のリポジトリを取得します（git clone）', cmd: 'git', args: ['clone', '--depth', '1', BOOTSTRAP_REPO, src], cwd: ws },
    npm('依存パッケージを入れます（npm install）', ['install'], src),
    npm('ビルドします（npm run build）', ['run', 'build'], src),
    npm('パッケージにまとめます（npm pack --ignore-scripts）', ['pack', '--ignore-scripts'], src),
    own('できた .tgz を tools/packages/ に置きます', (out) => {
      const names = existsSync(src) ? readdirSync(src).filter((n) => /^symbol-bootstrap-\d[\w.+-]*\.tgz$/.test(n)) : [];
      if (names.length !== 1) { out(`symbol-bootstrap の .tgz が 1 つ見つかりません（${names.length} 個）。\n`); return 1; }
      mkdirSync(dirname(keep), { recursive: true });
      renameSync(join(src, names[0]), keep);
      out(`${names[0]} を ${keep} に置きました。\n`);
      return 0;
    }),
    npm('tools/ に入れます（npm install --prefix tools の .tgz）', ['install', '--prefix', tools, keep]),
    versionStep(ws, pl, 'symbol-bootstrap', env.execPath),
    own('作業用のフォルダを消します', (out) => {
      const c = removeInTools(ws, src, out, pl);
      if (c === 0) out('作業用のフォルダ（tools/.upgrade）を消しました。\n');
      return c;
    }),
  ];
}

/** tools/node_modules/<名前>/package.json の version。読めなければ null。 */
function toolsPkgVersion(ws: string, pkg: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(join(toolsDir(ws), 'node_modules', pkg, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  } catch { return null; }
}

/**
 * `irome upgrade nodewatch` の手順: tools/ の symbol-node-watcher を、npm の最新版に入れ直す（`irome install nodewatch` と同じ取得元で、`@latest` を付けるだけ）。
 * symbol-node-watcher は `--version` を持たないかもしれないので、前後の版は package.json から読む。tools/ に入っていなければ、先に「irome install nodewatch」を案内して止まる。
 */
function nodewatchUpgradeSteps(ws: string, env: ProvisionEnv): Step[] {
  const pl = env.platform ?? process.platform;
  const own = (label: string, run: NonNullable<Step['run']>): Step => ({ label, cmd: '', args: [], cwd: ws, run });
  return [
    own('準備を確かめます（tools/ の symbol-node-watcher）', (out) => {
      const v = toolsPkgVersion(ws, 'symbol-node-watcher');
      if (!existsSync(join(toolsDir(ws), 'node_modules', 'symbol-node-watcher', 'package.json'))) { out('tools/ に symbol-node-watcher が入っていません。先に「irome install nodewatch」で入れてください。\n'); return 1; }
      out(`いまの版: ${v ?? '不明'}\n`);
      return 0;
    }),
    npmStepFor(ws, pl, 'symbol-node-watcher を最新にします（npm install --prefix tools symbol-node-watcher@latest）', ['install', '--prefix', toolsDir(ws), 'symbol-node-watcher@latest'], env.execPath),
    own('入った版を確認します', (out) => {
      const v = toolsPkgVersion(ws, 'symbol-node-watcher');
      if (v === null) { out('symbol-node-watcher の版を読めません（tools/node_modules/symbol-node-watcher/package.json）。\n'); return 1; }
      out(`いまの版: ${v}\n`);
      return 0;
    }),
  ];
}

/**
 * `irome upgrade …` の手順。エージェントが固定で組む。
 * - shoestring: tools/venv の symbol-shoestring を最新にする（公式の `python3 -m pip install --upgrade symbol-shoestring` と同じ）。
 *   tools/venv が無いときは、何もせず、先に「irome install shoestring」を案内して止まる（PATH の別の Python には触らない）。
 * - bootstrap: 公式の手順で、tools/ の symbol-bootstrap を新しい版にする（上の bootstrapUpgradeSteps）。tools/ に入っていなければ、先に「irome install bootstrap」を案内して止まる。
 * - nodewatch: tools/ の symbol-node-watcher を npm の最新版に入れ直す（上の nodewatchUpgradeSteps）。tools/ に入っていなければ、先に「irome install nodewatch」を案内して止まる。
 * このあとの、ノード自体のアップデートは、Shoestring は `shoestring upgrade --config config.ini --directory . --overrides overrides.ini`（先に docker compose down）、
 * symbol-bootstrap は `symbol-bootstrap start -d --upgrade`（先に stop）で行う。
 */
export function upgradeSteps(target: InstallTarget, ws: string, env: ProvisionEnv = {}): Step[] {
  const stop = (label: string, msg: string): Step[] => [{ label, cmd: '', args: [], cwd: ws, run: (out) => { out(msg); return 1; } }];
  if (!UPGRADE_TARGETS.includes(target)) return stop('更新できるのは Shoestring・symbol-bootstrap・symbol-node-watcher だけです', '更新できるのは Shoestring（irome upgrade shoestring）・symbol-bootstrap（irome upgrade bootstrap）・symbol-node-watcher（irome upgrade nodewatch）だけです。\n');
  if (target === 'bootstrap') return bootstrapUpgradeSteps(ws, env);
  if (target === 'nodewatch') return nodewatchUpgradeSteps(ws, env);
  if (!existsSync(venvPython(ws))) return stop('Shoestring（tools/venv）を更新します', 'tools/venv に Shoestring が入っていません。先に「irome install shoestring」で入れてください。\n');
  return [
    { label: 'symbol-shoestring を最新にします', cmd: venvPython(ws), args: ['-m', 'pip', 'install', '--upgrade', 'symbol-shoestring'], cwd: ws },
    { label: '入ったバージョンを確認します', cmd: venvPython(ws), args: ['-m', 'pip', 'show', 'symbol-shoestring'], cwd: ws },
  ];
}

/**
 * `openssl genpkey -algorithm ed25519 -out <名前>.pem` の手順（Shoestring のメインキーを新しく作る）。
 * 同じ名前のファイル（シンボリックリンクも）があれば上書きせず断る（`ca.key.pem` を消してしまわないため）。作ったあと、所有者だけが読める権限（600）にする。
 */
export function genpkeySteps(argv: string[], cwd: string, pl: NodeJS.Platform = process.platform): Step[] {
  const file = argv[5];
  const target = join(cwd, file);
  let exists = false;
  try { lstatSync(target); exists = true; } catch { exists = false; }
  if (exists) return [{ label: argv.join(' '), cmd: '', args: [], cwd, run: (out) => { out(`${file} は、すでにあります。上書きしないので、別の名前にするか、先にそのファイルを退けてください。\n`); return 1; } }];
  const steps: Step[] = [{ label: argv.join(' '), cmd: 'openssl', args: argv.slice(1), cwd }];
  if (!isWindows(pl)) steps.push({ label: '鍵ファイルの権限を 600（自分だけ）にします', cmd: '', args: [], cwd, run: (out) => { try { chmodSync(target, 0o600); out(`${file} を作りました（権限 600）。安全な場所に保管してください。\n`); return 0; } catch { out(`${file} の権限を変えられませんでした（鍵ができたか確認してください）。\n`); return 1; } } });
  return steps;
}

/**
 * `openssl pkey -in <名前>.pem -text [-noout]` の手順（鍵の中身を見る。**秘密鍵が出力に出る**ので、画面の確認ポップアップを通した（secret: true）ときだけここに来る）。
 * 読むのは、作業フォルダの中の普通のファイルだけ。シンボリックリンクは辿らない（作業場所の外の鍵を、リンク越しに読ませないため）。
 */
export function pkeySteps(argv: string[], cwd: string): Step[] {
  const file = argv[3];
  const target = join(cwd, file);
  const refuse = (msg: string): Step[] => [{ label: argv.join(' '), cmd: '', args: [], cwd, run: (out) => { out(msg); return 1; } }];
  let st;
  try { st = lstatSync(target); } catch { return refuse(`${file} が、作業フォルダにありません。\n`); }
  if (st.isSymbolicLink()) return refuse(`${file} はシンボリックリンクなので、読みません（作業フォルダの中の鍵のファイルだけ読めます）。\n`);
  if (!st.isFile()) return refuse(`${file} は、ファイルではありません。\n`);
  return [{ label: argv.join(' '), cmd: 'openssl', args: argv.slice(1), cwd }];
}

/**
 * `mkdir [-p] <名前>` の手順（作業フォルダ cwd の中に、フォルダを作る）。シェルの mkdir は使わず、ここで作る。
 * - 作るのは、作業場所（ws）の中だけ。途中のフォルダがシンボリックリンクなら、辿らずに断る。tools/・node_modules・.git の中には作らない。
 * - -p が無いときは、本物の mkdir と同じに、親が無い・すでにあるときは断る。-p のときは、親も作り、すでにあれば何もしない。
 */
export function mkdirSteps(argv: string[], ws: string, cwd: string, pl: NodeJS.Platform = process.platform): Step[] {
  const recursive = argv[1] === '-p';
  const name = recursive ? argv[2] : argv[1];
  const label = argv.join(' ');
  return [{
    label, cmd: '', args: [], cwd,
    run: (out) => {
      const fail = (msg: string) => { out(`${msg}\n`); return 1; };
      try {
        const root = realpathSync(ws);
        if (!isInside(root, realpathSync(cwd), pl, true)) return fail('作業フォルダが、作業場所の外を指しているので、作りません。');
        const relBase = relative(ws, cwd);
        const all = [...(relBase === '' ? [] : relBase.split(sep)), ...name.split('/')];
        const low = all.map((x) => x.toLowerCase());
        if (low[0] === 'tools' || low.includes('node_modules') || low.includes('.git')) return fail('tools/・node_modules・.git の中には、作れません。');
        const names = name.split('/');
        let cur = cwd;
        for (let i = 0; i < names.length; i++) {
          cur = join(cur, names[i]);
          const last = i === names.length - 1;
          let st = null;
          try { st = lstatSync(cur); } catch { st = null; }
          if (st) {
            if (st.isSymbolicLink()) return fail(`${names.slice(0, i + 1).join('/')} はシンボリックリンクなので、辿りません。`);
            if (!st.isDirectory()) return fail(`${names.slice(0, i + 1).join('/')} は、フォルダではありません。`);
            if (last && !recursive) return fail(`${name} は、すでにあります。`);
            continue;
          }
          if (!last && !recursive) return fail(`${names.slice(0, i + 1).join('/')} がありません（途中のフォルダも作るなら、mkdir -p ${name}）。`);
          mkdirSync(cur, { mode: 0o700 });
        }
        out(`${name} を作りました。\n`);
        return 0;
      } catch (e) {
        return fail(`作れませんでした: ${(e as Error).message}`);
      }
    },
  }];
}

/** `irome uninstall …` の手順。消すのは、作業場所の tools/ に「入れる」で入れたものだけ。PATH にある別のインストール・ノードの設定・鍵・Docker のデータには触らない。 */
export function uninstallSteps(target: InstallTarget, ws: string, pl: NodeJS.Platform = process.platform): Step[] {
  const tools = toolsDir(ws);
  const gone = (label: string, path: string, name: string): Step => ({
    label, cmd: '', args: [], cwd: ws,
    run: (out) => {
      if (existsSync(path)) { out(`まだ残っています: ${path}\n`); return 1; }
      out(`${name} を、${tools} から削除しました。\n`);
      return 0;
    },
  });
  switch (target) {
    case 'node': return [{ label: 'tools/node を削除します', cmd: '', args: [], cwd: ws, run: (out) => removeTool(ws, 'node', out, pl) }];
    case 'python': return [{ label: 'tools/python を削除します', cmd: '', args: [], cwd: ws, run: (out) => removeTool(ws, 'python', out, pl) }];
    // Docker は、画面から消さない（OS の apt の管理下で、管理者権限が要る。許可リストでも、`irome uninstall docker` は通さない）。念のための断り。
    case 'docker': return [{ label: 'Docker は、この画面からは削除しません', cmd: '', args: [], cwd: ws, run: (out) => { out('Docker は、この画面からは削除しません。OS 側の手順で消してください（Linux: https://docs.docker.com/engine/install/ の「Uninstall」。Mac: Docker Desktop の「Troubleshoot > Uninstall」）。\n'); return 1; } }];
    case 'bootstrap': return [
      npmStepFor(ws, pl, 'symbol-bootstrap を tools/ から削除します', ['uninstall', '--prefix', tools, 'symbol-bootstrap']),
      gone('消えたか確認します', npmBinPath(ws, 'symbol-bootstrap', pl), 'symbol-bootstrap'),
    ];
    case 'nodewatch': return [
      npmStepFor(ws, pl, 'symbol-node-watcher を tools/ から削除します', ['uninstall', '--prefix', tools, 'symbol-node-watcher']),
      gone('消えたか確認します', npmBinPath(ws, 'symbol-node-watcher', pl), 'symbol-node-watcher'),
    ];
    case 'shoestring': {
      const venv = join(tools, 'venv');
      return [
        {
          label: 'Python の仮想環境（tools/venv）を削除します', cmd: '', args: [], cwd: ws,
          run: (out) => {
            if (!existsSync(venv)) { out('tools/venv はありません。\n'); return 0; }
            // 作業場所の外へ出る削除を避ける: tools/venv そのものがシンボリックリンクなら、中身は消さない
            if (lstatSync(venv).isSymbolicLink()) { out('tools/venv がシンボリックリンクなので、削除しません。\n'); return 1; }
            const root = realpathSync(ws);
            const real = realpathSync(venv);
            if (!isInside(root, real, pl)) { out('tools/venv が作業場所の外を指しているので、削除しません。\n'); return 1; }
            rmSync(venv, { recursive: true, force: true });
            return 0;
          },
        },
        gone('消えたか確認します', venv, 'Shoestring（tools/venv）'),
      ];
    }
  }
}

export function originAllowed(origin: string, list: readonly string[]): boolean {
  if (list.includes(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
}

export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i.test(host);
}

function tokenOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newToken(): string { return randomBytes(32).toString('hex'); }

export interface Agent { server: http.Server; close(): Promise<void> }

export function createAgent(opts: AgentOptions): Agent {
  const ws = opts.workspace;
  const resolve = opts.resolve ?? defaultResolve;
  const jobs = new Map<string, Job>();
  // 端末（pty）が使えるか: Linux / macOS で、python3 の pty が読み込めるときだけ。起動時に一度だけ確かめる。
  let ptyProbe: Promise<boolean> | null = null;
  const ptyAvailable = (): Promise<boolean> => {
    if (opts.pty === false || isWin) return Promise.resolve(false);
    ptyProbe ??= probe('python3', ['-c', 'import pty, termios, select, fcntl']).then((v) => { if (v === null) ptyProbe = null; return v !== null; });
    return ptyProbe;
  };

  const append = (job: Job, text: string) => {
    job.buf += text;
    if (job.buf.length > MAX_OUTPUT) {
      const drop = job.buf.length - MAX_OUTPUT;
      job.buf = job.buf.slice(drop);
      job.base += drop;
    }
  };

  const runStep = (job: Job, step: Step, ptyOn: boolean): Promise<number> =>
    new Promise((done) => {
      if (step.prepare) {
        const fail = (e: unknown) => { append(job, `実行できません: ${(e as Error).message}\n`); done(1); };
        try {
          Promise.resolve(step.prepare((text) => append(job, text), { stopped: () => job.stopRequested })).then((r) => {
            if (r === 'skip') { done(0); return; }
            if (r === null) { done(1); return; }
            void runStep(job, { ...step, prepare: undefined, args: r }, ptyOn).then(done);
          }, fail);
        } catch (e) { fail(e); }
        return;
      }
      if (step.run) {
        const fail = (e: unknown) => { append(job, `実行できません: ${(e as Error).message}\n`); done(1); };
        try { Promise.resolve(step.run((text) => append(job, text), { stopped: () => job.stopRequested })).then(done, fail); } catch (e) { fail(e); }
        return;
      }
      let child: ChildProcess;
      const viaPty = step.pty === true && ptyOn;
      const spawnCmd = viaPty ? basePython(ws) : step.cmd;
      const spawnArgs = viaPty ? ['-c', PTY_HELPER, step.cmd, ...step.args] : step.args;
      job.dec = null;
      job.rest = '';
      job.pty = viaPty;
      job.raw = viaPty && step.raw === true;
      const clean = (d: Buffer) => (job.raw ? rawTty(job, d) : cleanTty(job, d));
      try {
        child = spawn(spawnCmd, spawnArgs, {
          cwd: step.cwd,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: childEnv(ws, plat, process.env, { FORCE_COLOR: '0', NO_COLOR: '1', ...(viaPty ? { TERM: job.raw ? 'xterm-256color' : 'dumb' } : {}) }),
        });
      } catch (e) {
        append(job, `起動できません: ${(e as Error).message}\n`);
        done(127);
        return;
      }
      job.child = child;
      child.stdout?.on('data', (d: Buffer) => append(job, viaPty ? clean(d) : d.toString('utf8')));
      child.stderr?.on('data', (d: Buffer) => append(job, viaPty ? clean(d) : d.toString('utf8')));
      child.stdin?.on('error', () => { /* 終了済みへの書き込みは無視 */ });
      child.on('error', (e: NodeJS.ErrnoException) => {
        append(job, e.code === 'ENOENT'
          ? `見つかりません: ${step.cmd}（先に「irome install …」で入れるか、PATH に入れてください）\n`
          : `実行できません: ${e.message}\n`);
        done(127);
      });
      child.on('close', (code, signal) => {
        if (viaPty) { const tail = job.raw ? rawTty(job, null) : cleanTty(job, null); if (tail) append(job, tail); }
        done(code ?? (signal ? 128 : 1));
      });
    });

  const startJob = (line: string, steps: Step[], ptyOn: boolean, secret = false): Job => {
    const id = randomBytes(6).toString('hex');
    const job: Job = { id, line, cwd: steps[0]?.cwd ?? ws, startedAt: Date.now(), endedAt: null, exitCode: null, running: true, buf: '', base: 0, child: null, stopRequested: false, dec: null, rest: '', pty: false, raw: false, secret };
    jobs.set(id, job);
    // 古い終了済みの記録を捨てる（動いているものは残す）
    if (jobs.size > MAX_JOBS_KEPT) {
      for (const [k, j] of jobs) { if (!j.running && jobs.size > MAX_JOBS_KEPT) jobs.delete(k); }
    }
    void (async () => {
      let code = 0;
      for (const step of steps) {
        if (job.stopRequested) { code = 130; break; }
        if (steps.length > 1) append(job, `\n== ${step.label} ==\n`);
        code = await runStep(job, step, ptyOn);
        if (code !== 0) break;
      }
      job.exitCode = code;
      job.running = false;
      job.endedAt = Date.now();
      job.child = null;
      // 秘密鍵が出たコマンドの出力は、画面が読み終える時間（30 秒）を置いて、メモリからも消す（base を進めるので、読み位置はずれない）
      if (job.secret) setTimeout(() => { job.base += job.buf.length; job.buf = ''; }, opts.secretOutputKeepMs ?? SECRET_OUTPUT_KEEP_MS).unref();
    })();
    return job;
  };

  const stopJob = (job: Job) => {
    job.stopRequested = true;
    const c = job.child;
    if (!c) return;
    if (isWin) { killTree(c.pid); return; } // Windows: シグナルは使えない。子孫ごと止める
    c.kill('SIGTERM');
    setTimeout(() => { if (job.running && job.child === c) c.kill('SIGKILL'); }, KILL_GRACE_MS).unref();
  };

  const probe = (cmd: string, args: string[]): Promise<string | null> =>
    new Promise((done) => {
      let out = '';
      let finished = false;
      const end = (v: string | null) => { if (!finished) { finished = true; done(v); } };
      try {
        const c = spawn(cmd, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: ws, env: childEnv(ws, plat, process.env) });
        const timer = setTimeout(() => { c.kill('SIGKILL'); end(null); }, 8000);
        c.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
        c.stderr?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
        c.on('error', () => { clearTimeout(timer); end(null); });
        c.on('close', (code) => { clearTimeout(timer); end(code === 0 ? out.trim() : null); });
      } catch { end(null); }
    });

  const firstLine = (s: string | null, re?: RegExp): string | null => {
    if (s === null) return null;
    const l = s.split('\n').map((x) => x.trim()).find(Boolean) ?? '';
    if (!re) return l;
    const m = re.exec(s);
    return m ? m[1] : l;
  };

  const status = async () => {
    const r = (tool: ToolName, argv: string[]) => resolve(tool, argv, ws);
    /** 名前のまま（PATH 任せ）ではなく、実際のファイルまで解決できたか。 */
    const resolvedToFile = (res: Resolved, tool: string) => res.local !== undefined || res.cmd !== tool;
    const npmProbe = () => {
      const c = npmCommand(ws, ['--version'], plat, process.execPath);
      return c ? probe(c.cmd, c.args) : Promise.resolve(null);
    };
    const run = (res: Resolved | null, extra: string[]) => (res ? probe(res.cmd, [...res.args, ...extra]) : Promise.resolve(null));
    const bs = r('symbol-bootstrap', ['symbol-bootstrap']);
    const nw = r('symbol-node-watcher', ['symbol-node-watcher']);
    const ss = r('shoestring', ['shoestring']);
    const dk = r('docker', ['docker']);
    const [bsV, ssV, nwV, dkV, nodeV, npmV, pyV, gitV] = await Promise.all([
      run(bs, ['--version']),
      ss ? (ss.args[0] === '-m' ? probe(ss.cmd, ['-m', 'pip', 'show', 'symbol-shoestring']) : probe(ss.cmd, ['--help'])) : Promise.resolve(null),
      // symbol-node-watcher は --version を持たないかもしれないので、実行ファイルの有無で見る
      Promise.resolve(nw && resolvedToFile(nw, 'symbol-node-watcher') ? 'installed' : null),
      run(dk, ['--version']),
      probe(process.execPath, ['--version']),
      npmProbe(),
      probe(isWin ? 'python' : 'python3', ['--version']),
      probe('git', ['--version']),
    ]);
    const nwOnPath = nw && !resolvedToFile(nw, 'symbol-node-watcher') ? await probe('symbol-node-watcher', ['--help']) : null;
    // local: 「入れる」で作業場所の tools/ に入れたもの（画面の「削除」で消せる）。PATH にある別のインストールは、ここでは消せない。
    const tool = (v: string | null, version?: string | null, local?: boolean) => ({ found: v !== null, version: v === null ? null : (version === undefined ? firstLine(v) : version), ...(local === undefined ? {} : { local: v !== null && local }) });
    return {
      agent: AGENT_VERSION,
      platform: process.platform,
      arch: process.arch,
      workspace: ws,
      tools: {
        docker: tool(dkV),
        git: tool(gitV, gitV === null ? null : (/git version\s+(\S+)/.exec(gitV)?.[1] ?? firstLine(gitV))),
        node: tool(nodeV, undefined, existsSync(localNodeExe(ws, plat))),
        npm: tool(npmV),
        python: tool(pyV, undefined, existsSync(localPythonExe(ws, plat))),
        'symbol-bootstrap': tool(bsV, undefined, bs?.local === true),
        shoestring: tool(ssV, firstLine(ssV, /^Version:\s*(\S+)/m), ss?.local === true || (ss !== null && ss.args[0] === '-m')),
        'symbol-node-watcher': tool(nwV ?? nwOnPath, null, nw?.local === true),
      },
      running: [...jobs.values()].filter((j) => j.running).length,
      pty: await ptyAvailable(),
    };
  };

  /** Docker のコンテナ一覧（読むだけ。`docker ps -a` の出力を整える）。docker が無い・動いていないときは available: false。 */
  const containers = async (): Promise<{ available: boolean; containers: Array<{ name: string; image: string; state: string; status: string }> }> => {
    const dk = resolve('docker', ['docker', 'ps'], ws);
    const out = dk ? await probe(dk.cmd, [...dk.args, 'ps', '-a', '--no-trunc', '--format', '{{json .}}']) : null;
    if (out === null) return { available: false, containers: [] };
    const list: Array<{ name: string; image: string; state: string; status: string }> = [];
    for (const line of out.split('\n')) {
      let j: { Names?: unknown; Image?: unknown; State?: unknown; Status?: unknown };
      try { j = JSON.parse(line) as typeof j; } catch { continue; }
      if (typeof j.Names !== 'string') continue;
      const cut = (v: unknown) => (typeof v === 'string' ? v.slice(0, 120) : '');
      list.push({ name: cut(j.Names), image: cut(j.Image), state: cut(j.State), status: cut(j.Status) });
      if (list.length >= 50) break;
    }
    return { available: true, containers: list };
  };

  // ---- 作業場所の設定ファイル ----
  /** 作業場所の中の、許可された拡張子のファイルだけ。シンボリックリンク経由で外へ出る指定は断る。 */
  const filePath = (rel: string): { ok: true; full: string } | { ok: false; reason: string } => {
    const v = validateWorkspaceFile(rel);
    if (!v.ok) return v;
    const full = join(ws, v.value);
    try {
      mkdirSync(ws, { recursive: true });
      const root = realpathSync(ws);
      // 既にある一番近い親の実体が、作業場所の中にあること
      let dir = dirname(full);
      while (!existsSync(dir) && dir !== ws) dir = dirname(dir);
      const real = realpathSync(dir);
      if (!isInside(root, real, plat, true)) return { ok: false, reason: 'path_invalid' };
      if (existsSync(full) && lstatSync(full).isSymbolicLink()) return { ok: false, reason: 'path_invalid' };
      // 作業場所の中のシンボリックリンクで target/addresses.yml に寄せる抜け道も塞ぐ（実体のパスでも、もう一度判定する）
      const realParts = [...relative(root, real).split(sep), ...relative(dir, full).split(sep)].filter((x) => x !== '');
      if (isKeyMaterialPath(realParts)) return { ok: false, reason: 'key_file' };
    } catch { return { ok: false, reason: 'path_invalid' }; }
    return { ok: true, full };
  };

  const listFiles = (): Array<{ path: string; size: number }> => {
    const out: Array<{ path: string; size: number }> = [];
    const walk = (dir: string, rel: string, depth: number) => {
      if (depth > 3 || out.length >= 200) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isSymbolicLink() || e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (r === 'tools' || e.name === 'node_modules') continue; walk(join(dir, e.name), r, depth + 1); continue; }
        if (!e.isFile() || !validateWorkspaceFile(r).ok) continue;
        try { out.push({ path: r, size: lstatSync(join(dir, e.name)).size }); } catch { /* 消えたものは飛ばす */ }
      }
    };
    walk(ws, '', 0);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  };

  // ---- ノードの鍵（公開鍵だけ）----
  /**
   * 作業場所の中の `target/addresses.yml`（symbol-bootstrap が作る）から、ノードの公開鍵だけを読んで返す。
   * 秘密鍵の行は値を読まず、返す形にも入れ場所が無い。シンボリックリンクは辿らない。tools/ と node_modules の中は見ない。
   */
  const readNodeKeys = (): Array<NodeKeySet & { source: string }> => {
    const out: Array<NodeKeySet & { source: string }> = [];
    const walk = (dir: string, rel: string, depth: number) => {
      if (depth > 4 || out.length >= 50) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isSymbolicLink() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (r === 'tools') continue; walk(join(dir, e.name), r, depth + 1); continue; }
        if (!e.isFile() || e.name !== 'addresses.yml' || !/(^|\/)target\/addresses\.yml$/.test(r)) continue;
        try {
          const full = join(dir, e.name);
          if (lstatSync(full).size > MAX_FILE_BYTES) continue;
          for (const set of parseAddressesYml(readFileSync(full, 'utf8'))) { if (out.length < 50) out.push({ ...set, source: r }); }
        } catch { /* 読めないものは飛ばす */ }
      }
    };
    walk(ws, '', 0);
    // Shoestring の作業場所など、addresses.yml が無いものは、証明書からノード鍵（と main）だけ読む（addresses.yml で既に出たノード鍵は、重ねない）
    const have = new Set(out.map((k) => k.node).filter((k): k is string => k !== null));
    for (const k of readCertKeys(ws)) { if (out.length < 50 && !(k.node && have.has(k.node))) out.push(k); }
    // 投票鍵: 木のファイル（private_key_tree*.dat）の先頭ヘッダ（80 バイト）だけから、公開鍵と期間を足す（子の秘密鍵は読まない）
    const withTrees = attachVotingTrees(out, readVotingTrees(ws), (name, source): NodeKeySet & { source: string } => ({ name, main: null, node: null, remote: null, vrf: null, voting: null, votings: [], source }));
    return withTrees.slice(0, 50).map((k) => withVotings(k, []) as NodeKeySet & { source: string });
  };

  // ---- HTTP ----
  const send = (res: http.ServerResponse, code: number, body: unknown, headers: http.OutgoingHttpHeaders = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(text);
  };

  const readBody = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((ok, ng) => {
      let size = 0;
      let over = false;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        if (over) return; // 上限を超えたら、溜めずに読み捨てる（413 を返し終えてから接続を切る）
        size += c.length;
        if (size > MAX_BODY) { over = true; chunks.length = 0; ng(new Error('body_too_large')); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (chunks.length === 0) { ok({}); return; }
        try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { ng(new Error('bad_json')); }
      });
      req.on('error', ng);
    });

  // 常駐ウォッチドッグ（画面を閉じていても見て、止まったら再起動する）。流すコマンドは固定で、画面からの実行と同じ許可リストを通る。
  const watchdogRestart = async (dir: string): Promise<RestartResult> => {
    if ([...jobs.values()].filter((j) => j.running).length >= MAX_RUNNING) return 'busy';
    const parsed = parseCommandLine(AUTO_RESTART_LINE);
    const sub = validateSubdir(dir);
    if (!parsed.ok || !sub.ok || !validateArgv(parsed.argv).ok) return 'failed';
    const r = resolve(parsed.tool, parsed.argv, ws);
    if (!r) return 'failed';
    const cwd = sub.value ? join(ws, sub.value) : ws;
    try { mkdirSync(cwd, { recursive: true }); } catch { return 'failed'; }
    const job = startJob(AUTO_RESTART_LINE, [{ label: AUTO_RESTART_LINE, cmd: r.cmd, args: r.args, cwd }], false);
    const until = Date.now() + AUTO_RESTART_LIMITS.jobTimeoutMs;
    while (job.running) {
      if (Date.now() > until) { stopJob(job); break; }
      await new Promise<void>((ok) => setTimeout(ok, 500));
    }
    return job.exitCode === 0 ? 'ok' : 'failed';
  };
  const watchdog = createWatchdog({ workspace: ws, restart: watchdogRestart, ...(opts.watchdogProbe ? { probe: opts.watchdogProbe } : {}), ...(opts.watchdogFetch ? { fetchImpl: opts.watchdogFetch } : {}) });
  watchdog.load();

  const server = http.createServer((req, res) => {
    void (async () => {
      if (!hostAllowed(req.headers.host)) { send(res, 403, { error: 'bad_host' }); return; }
      const origin = req.headers.origin;
      const cors: http.OutgoingHttpHeaders = {};
      if (origin !== undefined) {
        if (!originAllowed(origin, opts.origins)) { send(res, 403, { error: 'origin_not_allowed' }); return; }
        cors['Access-Control-Allow-Origin'] = origin;
        cors['Vary'] = 'Origin';
        cors['Access-Control-Allow-Headers'] = 'authorization, content-type';
        cors['Access-Control-Allow-Methods'] = 'GET, POST, PUT, OPTIONS';
        cors['Access-Control-Max-Age'] = '600';
        // 公開ページ（GitHub Pages）からローカルのエージェントへ繋ぐときの、ブラウザの事前確認（Private Network Access）
        if (req.headers['access-control-request-private-network'] === 'true') cors['Access-Control-Allow-Private-Network'] = 'true';
      }
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      if (!tokenOk(req.headers.authorization, opts.token)) { send(res, 401, { error: 'unauthorized' }, cors); return; }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      try {
        if (req.method === 'GET' && path === '/v1/status') { send(res, 200, await status(), cors); return; }
        if (req.method === 'GET' && path === '/v1/containers') { send(res, 200, await containers(), cors); return; }

        if (req.method === 'POST' && path === '/v1/jobs') {
          const body = (await readBody(req)) as { line?: unknown; cwd?: unknown; wizard?: unknown; emulate?: unknown; secret?: unknown };
          if (typeof body.line !== 'string') { send(res, 400, { error: 'line_required' }, cors); return; }
          // wizard（対話式）は、使う人が画面で有効にしたとき（wizard: true）だけ通す。それ以外は、これまでどおりの判定。
          // 秘密鍵が出る形（--show-private・openssl pkey … -text）は、画面の確認ポップアップで同意したとき（secret: true）だけ通す。同意の印が無ければ secret_confirm_required で断る。
          const vopts = { wizard: body.wizard === true, secret: body.secret === true };
          const parsed = parseCommandLine(body.line, vopts);
          if (!parsed.ok) { send(res, 400, { error: 'command_rejected', reason: parsed.reason }, cors); return; }
          // 念のため、引数の配列でもう一度判定する（トークナイザの抜けがあっても、許可リストは必ず通る）
          const again = validateArgv(parsed.argv, vopts);
          if (!again.ok) { send(res, 400, { error: 'command_rejected', reason: again.reason }, cors); return; }
          const sub = validateSubdir(typeof body.cwd === 'string' ? body.cwd : '');
          if (!sub.ok) { send(res, 400, { error: 'command_rejected', reason: sub.reason }, cors); return; }
          // cd は、画面の「作業フォルダ」を変えるだけ（画面が処理する）。エージェントには、実行するものが無い。
          if (parsed.tool === 'cd') { send(res, 400, { error: 'command_rejected', reason: 'cd_ui_only' }, cors); return; }
          if (parsed.tool === 'mkdir') {
            const made = validateSubdir([sub.value, parsed.argv[parsed.argv.length - 1]].filter(Boolean).join('/'));
            if (!made.ok) { send(res, 400, { error: 'command_rejected', reason: made.reason }, cors); return; }
          }
          if ([...jobs.values()].filter((j) => j.running).length >= MAX_RUNNING) { send(res, 429, { error: 'too_many_jobs' }, cors); return; }
          const cwd = sub.value ? join(ws, sub.value) : ws;
          mkdirSync(cwd, { recursive: true });
          let steps: Step[];
          if (parsed.tool === 'irome' && parsed.argv[1] === 'nem') {
            // NEM（NIS1）ノード（公式の nem-docker）。作業フォルダ（cwd）の中で、固定の手順だけ動かす。tools/ の中では動かさない
            if (sub.value.split('/')[0].toLowerCase() === 'tools') { send(res, 400, { error: 'command_rejected', reason: 'subdir_invalid' }, cors); return; }
            steps = nemSteps(parsed.argv[2] as NemAction, cwd, { platform: opts.platform });
          } else if (parsed.tool === 'irome') {
            steps = parsed.argv[1] === 'uninstall' ? uninstallSteps(parsed.argv[2] as InstallTarget, ws)
              : parsed.argv[1] === 'upgrade' ? upgradeSteps(parsed.argv[2] as InstallTarget, ws, { platform: opts.platform })
              : installSteps(parsed.argv[2] as InstallTarget, ws, { fetch: opts.fetch, platform: opts.platform, arch: opts.arch });
          } else if (parsed.tool === 'openssl' && parsed.argv[1] === 'genpkey') {
            steps = genpkeySteps(parsed.argv, cwd, opts.platform);
          } else if (parsed.tool === 'openssl' && parsed.argv[1] === 'pkey') {
            steps = pkeySteps(parsed.argv, cwd);
          } else if (parsed.tool === 'mkdir') {
            steps = mkdirSteps(parsed.argv, ws, cwd, opts.platform);
          } else {
            const r = resolve(parsed.tool, parsed.argv, ws);
            if (!r) { send(res, 400, { error: 'command_rejected', reason: 'tool_not_allowed' }, cors); return; }
            steps = [{
              label: body.line, cmd: r.cmd, args: r.args, cwd,
              pty: parsed.tool === 'symbol-bootstrap' || parsed.tool === 'shoestring' || parsed.tool === 'symbol-node-watcher',
              // 生の出力を返すのは、wizard を有効にして、画面が簡易ターミナルで描くと頼んだ、wizard の実行だけ
              raw: vopts.wizard && body.emulate === true && isWizardArgv(parsed.argv),
            }];
          }
          mkdirSync(toolsDir(ws), { recursive: true });
          const job = startJob(body.line, steps, await ptyAvailable(), isSecretArgv(parsed.argv));
          send(res, 200, { id: job.id, raw: job.raw }, cors);
          return;
        }

        // すでにあるノード（symbol-bootstrap 製・Shoestring 製）のフォルダを、名前だけで探す（中身は開かない）
        if (req.method === 'GET' && path === '/v1/existing-nodes') { send(res, 200, { nodes: findExistingNodes(ws) }, cors); return; }
        if (req.method === 'GET' && path === '/v1/compose-dirs') { send(res, 200, { dirs: findComposeDirs(ws) }, cors); return; }
        if (path === '/v1/watchdog') {
          if (req.method === 'GET') { send(res, 200, watchdog.snapshot(), cors); return; }
          if (req.method === 'PUT') {
            // 受け取った設定は、形と範囲を確かめる（コマンドは固定で、ここでは変えられない）
            const c = sanitizeWatchdogConfig(await readBody(req));
            if (!c.ok) { send(res, 400, { error: 'watchdog_rejected', reason: c.reason }, cors); return; }
            try { watchdog.configure(c.config); } catch { send(res, 500, { error: 'watchdog_save_failed' }, cors); return; }
            send(res, 200, watchdog.snapshot(), cors);
            return;
          }
        }
        if (req.method === 'GET' && path === '/v1/host') { send(res, 200, await collectHostStats(ws), cors); return; }
        if (req.method === 'GET' && path === '/v1/node-keys') { send(res, 200, { nodes: readNodeKeys() }, cors); return; }
        // Shoestring の鍵ファイル（remote.key.pem / vrf.key.pem / config-harvesting.properties）から、公開鍵だけを読む。
        // 秘密鍵のファイルを開くので、画面で利用者が確認したとき（confirm: true）だけ。公開鍵を作ったら、秘密鍵はその場で捨てる。
        if (req.method === 'POST' && path === '/v1/node-keys/shoestring') {
          const body = (await readBody(req)) as { confirm?: unknown };
          if (body.confirm !== true) { send(res, 400, { error: 'confirm_required' }, cors); return; }
          const merged = mergeShoestringKeys(readNodeKeys(), readShoestringKeys(ws));
          send(res, 200, merged, cors);
          return;
        }
        if (req.method === 'GET' && path === '/v1/files') { send(res, 200, { files: listFiles(), extensions: EDITABLE_EXTENSIONS }, cors); return; }
        if (path === '/v1/file') {
          if (req.method === 'GET') {
            const f = filePath(url.searchParams.get('path') ?? '');
            if (!f.ok) { send(res, 400, { error: 'path_rejected', reason: f.reason }, cors); return; }
            if (!existsSync(f.full)) { send(res, 404, { error: 'file_not_found' }, cors); return; }
            const st = lstatSync(f.full);
            if (!st.isFile()) { send(res, 400, { error: 'path_rejected', reason: 'path_invalid' }, cors); return; }
            if (st.size > MAX_FILE_BYTES) { send(res, 400, { error: 'path_rejected', reason: 'too_large' }, cors); return; }
            send(res, 200, { content: readFileSync(f.full, 'utf8') }, cors);
            return;
          }
          if (req.method === 'PUT') {
            const body = (await readBody(req)) as { path?: unknown; content?: unknown };
            if (typeof body.path !== 'string' || typeof body.content !== 'string') { send(res, 400, { error: 'bad_request' }, cors); return; }
            if (Buffer.byteLength(body.content, 'utf8') > MAX_FILE_BYTES) { send(res, 400, { error: 'path_rejected', reason: 'too_large' }, cors); return; }
            const f = filePath(body.path);
            if (!f.ok) { send(res, 400, { error: 'path_rejected', reason: f.reason }, cors); return; }
            mkdirSync(dirname(f.full), { recursive: true });
            writeFileSync(f.full, body.content, { encoding: 'utf8', mode: 0o600 });
            send(res, 200, { ok: true }, cors);
            return;
          }
        }

        const m = /^\/v1\/jobs\/([0-9a-f]{12})(?:\/(output|stdin|stop))?$/.exec(path);
        if (m) {
          const job = jobs.get(m[1]);
          if (!job) { send(res, 404, { error: 'no_such_job' }, cors); return; }
          const action = m[2];
          if (req.method === 'GET' && action === 'output') {
            const from = Math.max(0, Number(url.searchParams.get('from') ?? '0') || 0);
            const start = Math.max(from, job.base);
            send(res, 200, { text: job.buf.slice(start - job.base), next: job.base + job.buf.length, truncated: from < job.base, done: !job.running, exitCode: job.exitCode }, cors);
            return;
          }
          if (req.method === 'POST' && action === 'stdin') {
            const body = (await readBody(req)) as { text?: unknown; key?: unknown };
            if (typeof body.key === 'string') {
              // キー（矢印・Enter・スペース・Tab）: 端末で動いているジョブだけ。改行は足さない。
              const seq = Object.prototype.hasOwnProperty.call(TTY_KEYS, body.key) ? TTY_KEYS[body.key] : undefined;
              if (seq === undefined) { send(res, 400, { error: 'bad_key' }, cors); return; }
              if (!job.running || !job.child?.stdin?.writable) { send(res, 409, { error: 'not_running' }, cors); return; }
              if (!job.pty) { send(res, 409, { error: 'no_pty' }, cors); return; }
              job.child.stdin.write(seq);
              send(res, 200, { ok: true }, cors);
              return;
            }
            if (typeof body.text !== 'string' || body.text.length > 1024) { send(res, 400, { error: 'bad_text' }, cors); return; }
            if (!job.running || !job.child?.stdin?.writable) { send(res, 409, { error: 'not_running' }, cors); return; }
            job.child.stdin.write(`${body.text}\n`);
            send(res, 200, { ok: true }, cors);
            return;
          }
          if (req.method === 'POST' && action === 'stop') { stopJob(job); send(res, 200, { ok: true }, cors); return; }
          if (req.method === 'GET' && action === undefined) {
            send(res, 200, { id: job.id, line: job.line, running: job.running, exitCode: job.exitCode, startedAt: job.startedAt, endedAt: job.endedAt }, cors);
            return;
          }
        }
        send(res, 404, { error: 'not_found' }, cors);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === 'body_too_large') {
          res.once('finish', () => req.destroy());
          send(res, 413, { error: msg }, { ...cors, Connection: 'close' });
          return;
        }
        send(res, 400, { error: msg === 'bad_json' ? msg : 'bad_request' }, cors);
      }
    })();
  });

  return {
    server,
    close: () => new Promise((ok) => {
      watchdog.close();
      for (const j of jobs.values()) if (j.running) stopJob(j);
      server.closeAllConnections?.();
      server.close(() => ok());
    }),
  };
}
