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
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { EDITABLE_EXTENSIONS, MAX_FILE_BYTES, isWizardArgv, parseCommandLine, validateArgv, validateSubdir, validateWorkspaceFile } from '../../lib/node/nodeCommands';
import type { InstallTarget, ToolName } from '../../lib/node/nodeCommands';

export const AGENT_VERSION = 1;
const MAX_BODY = 400 * 1024; // 設定ファイルの保存（最大 256KB）が入る大きさ
const MAX_OUTPUT = 1_000_000;
const MAX_RUNNING = 3;
const MAX_JOBS_KEPT = 30;
const KILL_GRACE_MS = 5000;

export interface AgentOptions {
  token: string;
  workspace: string;
  /** 許可する Origin。'null'（file://）を含められる。localhost / 127.0.0.1 の http は常に許可。 */
  origins: string[];
  /** テスト用: 実行ファイルの解決を差し替える。 */
  resolve?: (tool: ToolName, argv: string[], ws: string) => Resolved | null;
  /** 本物の端末（pty）で動かすか。省略は自動（Linux / macOS で python3 の pty が使えるときだけ）。false で、これまでどおりパイプだけにする。 */
  pty?: boolean;
}

export interface Resolved { cmd: string; args: string[] }
/** run があるときは、外部コマンドを起動せず、この関数を実行する（tools/ の中の削除・確認だけに使う）。戻り値は終了コード。 */
interface Step { label: string; cmd: string; args: string[]; cwd: string; run?: (out: (text: string) => void) => number; /** 端末（pty）で動かす（symbol-bootstrap / shoestring / symbol-node-watcher の、画面から打ったコマンドだけ） */ pty?: boolean; /** 出力を、エスケープ列を消さずに生のまま返す（画面の簡易ターミナルが描く。wizard を有効にして、画面が頼んだときだけ） */ raw?: boolean }

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
const npmBin = (ws: string, name: string) => join(toolsDir(ws), 'node_modules', '.bin', name);
const venvPython = (ws: string) => join(toolsDir(ws), 'venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');

/** ツール名を、実行ファイルと引数に解決する。ワークスペースの tools/ に入れたものを先に探し、なければ PATH の名前をそのまま使う。 */
export function defaultResolve(tool: ToolName, argv: string[], ws: string): Resolved | null {
  const rest = argv.slice(1);
  switch (tool) {
    case 'symbol-bootstrap':
    case 'symbol-node-watcher': {
      const local = npmBin(ws, tool);
      return { cmd: existsSync(local) ? local : tool, args: rest };
    }
    case 'shoestring': {
      const py = venvPython(ws);
      return existsSync(py) ? { cmd: py, args: ['-m', 'shoestring', ...rest] } : { cmd: 'shoestring', args: rest };
    }
    case 'docker': return { cmd: 'docker', args: rest };
    case 'node': return { cmd: process.execPath, args: rest };
    default: return null;
  }
}

/** `irome install …` の手順。エージェントが固定で組む（画面から任意の引数は入らない）。 */
export function installSteps(target: InstallTarget, ws: string): Step[] {
  const tools = toolsDir(ws);
  switch (target) {
    case 'bootstrap': return [
      { label: 'symbol-bootstrap をワークスペースの tools/ に入れます', cmd: 'npm', args: ['install', '--prefix', tools, 'symbol-bootstrap'], cwd: ws },
      { label: '入ったか確認します', cmd: npmBin(ws, 'symbol-bootstrap'), args: ['--version'], cwd: ws },
    ];
    case 'nodewatch': return [
      { label: 'symbol-node-watcher をワークスペースの tools/ に入れます', cmd: 'npm', args: ['install', '--prefix', tools, 'symbol-node-watcher'], cwd: ws },
    ];
    case 'shoestring': return [
      { label: 'Python の仮想環境（tools/venv）を作ります', cmd: 'python3', args: ['-m', 'venv', join(tools, 'venv')], cwd: ws },
      { label: 'symbol-shoestring を入れます', cmd: venvPython(ws), args: ['-m', 'pip', 'install', 'symbol-shoestring'], cwd: ws },
      { label: '入ったか確認します', cmd: venvPython(ws), args: ['-m', 'pip', 'show', 'symbol-shoestring'], cwd: ws },
    ];
  }
}

/** `irome uninstall …` の手順。消すのは、作業場所の tools/ に「入れる」で入れたものだけ。PATH にある別のインストール・ノードの設定・鍵・Docker のデータには触らない。 */
export function uninstallSteps(target: InstallTarget, ws: string): Step[] {
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
    case 'bootstrap': return [
      { label: 'symbol-bootstrap を tools/ から削除します', cmd: 'npm', args: ['uninstall', '--prefix', tools, 'symbol-bootstrap'], cwd: ws },
      gone('消えたか確認します', npmBin(ws, 'symbol-bootstrap'), 'symbol-bootstrap'),
    ];
    case 'nodewatch': return [
      { label: 'symbol-node-watcher を tools/ から削除します', cmd: 'npm', args: ['uninstall', '--prefix', tools, 'symbol-node-watcher'], cwd: ws },
      gone('消えたか確認します', npmBin(ws, 'symbol-node-watcher'), 'symbol-node-watcher'),
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
            if (!real.startsWith(root + sep)) { out('tools/venv が作業場所の外を指しているので、削除しません。\n'); return 1; }
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
    ptyProbe ??= probe('python3', ['-c', 'import pty, termios, select, fcntl']).then((v) => v !== null);
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
      if (step.run) {
        try { done(step.run((text) => append(job, text))); } catch (e) { append(job, `実行できません: ${(e as Error).message}\n`); done(1); }
        return;
      }
      let child: ChildProcess;
      const viaPty = step.pty === true && ptyOn;
      const spawnCmd = viaPty ? 'python3' : step.cmd;
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
          env: { ...process.env, PATH: [join(toolsDir(ws), 'node_modules', '.bin'), process.env.PATH ?? ''].join(isWin ? ';' : ':'), FORCE_COLOR: '0', NO_COLOR: '1', ...(viaPty ? { TERM: job.raw ? 'xterm-256color' : 'dumb' } : {}) },
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

  const startJob = (line: string, steps: Step[], ptyOn: boolean): Job => {
    const id = randomBytes(6).toString('hex');
    const job: Job = { id, line, cwd: steps[0]?.cwd ?? ws, startedAt: Date.now(), endedAt: null, exitCode: null, running: true, buf: '', base: 0, child: null, stopRequested: false, dec: null, rest: '', pty: false, raw: false };
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
    })();
    return job;
  };

  const stopJob = (job: Job) => {
    job.stopRequested = true;
    const c = job.child;
    if (!c) return;
    c.kill('SIGTERM');
    setTimeout(() => { if (job.running && job.child === c) c.kill('SIGKILL'); }, KILL_GRACE_MS).unref();
  };

  const probe = (cmd: string, args: string[]): Promise<string | null> =>
    new Promise((done) => {
      let out = '';
      let finished = false;
      const end = (v: string | null) => { if (!finished) { finished = true; done(v); } };
      try {
        const c = spawn(cmd, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: ws, env: { ...process.env, PATH: [join(toolsDir(ws), 'node_modules', '.bin'), process.env.PATH ?? ''].join(isWin ? ';' : ':') } });
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
    const run = (res: Resolved | null, extra: string[]) => (res ? probe(res.cmd, [...res.args, ...extra]) : Promise.resolve(null));
    const bs = r('symbol-bootstrap', ['symbol-bootstrap']);
    const nw = r('symbol-node-watcher', ['symbol-node-watcher']);
    const ss = r('shoestring', ['shoestring']);
    const dk = r('docker', ['docker']);
    const [bsV, ssV, nwV, dkV, nodeV, npmV, pyV] = await Promise.all([
      run(bs, ['--version']),
      ss ? (ss.args[0] === '-m' ? probe(ss.cmd, ['-m', 'pip', 'show', 'symbol-shoestring']) : probe(ss.cmd, ['--help'])) : Promise.resolve(null),
      // symbol-node-watcher は --version を持たないかもしれないので、実行ファイルの有無で見る
      Promise.resolve(nw && (nw.cmd !== 'symbol-node-watcher' ? 'installed' : null)),
      run(dk, ['--version']),
      probe(process.execPath, ['--version']),
      probe('npm', ['--version']),
      probe(isWin ? 'python' : 'python3', ['--version']),
    ]);
    const nwOnPath = nw && nw.cmd === 'symbol-node-watcher' ? await probe('symbol-node-watcher', ['--help']) : null;
    // local: 「入れる」で作業場所の tools/ に入れたもの（画面の「削除」で消せる）。PATH にある別のインストールは、ここでは消せない。
    const tool = (v: string | null, version?: string | null, local?: boolean) => ({ found: v !== null, version: v === null ? null : (version === undefined ? firstLine(v) : version), ...(local === undefined ? {} : { local: v !== null && local }) });
    return {
      agent: AGENT_VERSION,
      platform: process.platform,
      arch: process.arch,
      workspace: ws,
      tools: {
        docker: tool(dkV),
        node: tool(nodeV),
        npm: tool(npmV),
        python: tool(pyV),
        'symbol-bootstrap': tool(bsV, undefined, bs !== null && bs.cmd !== 'symbol-bootstrap'),
        shoestring: tool(ssV, firstLine(ssV, /^Version:\s*(\S+)/m), ss !== null && ss.args[0] === '-m'),
        'symbol-node-watcher': tool(nwV ?? nwOnPath, null, nw !== null && nw.cmd !== 'symbol-node-watcher'),
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
      if (real !== root && !real.startsWith(root + sep)) return { ok: false, reason: 'path_invalid' };
      if (existsSync(full) && lstatSync(full).isSymbolicLink()) return { ok: false, reason: 'path_invalid' };
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
          const body = (await readBody(req)) as { line?: unknown; cwd?: unknown; wizard?: unknown; emulate?: unknown };
          if (typeof body.line !== 'string') { send(res, 400, { error: 'line_required' }, cors); return; }
          // wizard（対話式）は、使う人が画面で有効にしたとき（wizard: true）だけ通す。それ以外は、これまでどおりの判定。
          const vopts = { wizard: body.wizard === true };
          const parsed = parseCommandLine(body.line, vopts);
          if (!parsed.ok) { send(res, 400, { error: 'command_rejected', reason: parsed.reason }, cors); return; }
          // 念のため、引数の配列でもう一度判定する（トークナイザの抜けがあっても、許可リストは必ず通る）
          const again = validateArgv(parsed.argv, vopts);
          if (!again.ok) { send(res, 400, { error: 'command_rejected', reason: again.reason }, cors); return; }
          const sub = validateSubdir(typeof body.cwd === 'string' ? body.cwd : '');
          if (!sub.ok) { send(res, 400, { error: 'command_rejected', reason: sub.reason }, cors); return; }
          if ([...jobs.values()].filter((j) => j.running).length >= MAX_RUNNING) { send(res, 429, { error: 'too_many_jobs' }, cors); return; }
          const cwd = sub.value ? join(ws, sub.value) : ws;
          mkdirSync(cwd, { recursive: true });
          let steps: Step[];
          if (parsed.tool === 'irome') {
            steps = parsed.argv[1] === 'uninstall' ? uninstallSteps(parsed.argv[2] as InstallTarget, ws) : installSteps(parsed.argv[2] as InstallTarget, ws);
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
          const job = startJob(body.line, steps, await ptyAvailable());
          send(res, 200, { id: job.id, raw: job.raw }, cors);
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
      for (const j of jobs.values()) if (j.running) stopJob(j);
      server.closeAllConnections?.();
      server.close(() => ok());
    }),
  };
}
