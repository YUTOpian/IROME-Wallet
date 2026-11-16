// ノード構築コンソール: 「打ってよいコマンド」の決まり。ウォレットの画面（入力の事前チェック）と、
// ローカルのエージェント（src/server/node-agent/）の両方が同じものを使う。エージェント側は画面を信用せず、必ずもう一度この判定にかける。
//
// 方針:
// - シェルは使わない。1 行を引数の配列に分けて、そのまま実行ファイルに渡す（`|` `;` `&` `>` `$` `` ` `` は使えない）。
// - 実行できるのは、決まった 6 種類（symbol-bootstrap / shoestring / symbol-node-watcher / docker の確認系 / node --version / openssl の 2 つの形）と、
//   エージェントが用意した導入・削除・更新のレシピ（irome install … / irome uninstall … / irome upgrade shoestring / bootstrap / nodewatch）だけ。任意のコマンドは通さない。
// - docker は、見る系（ps / logs / info / stats）と、ノードの運用に要る操作（コンテナの start / stop / restart / rm、pull、compose の up / down / start / stop / restart / pull）だけ。
//   `run` `exec` `cp` `build` と、`-f`（compose ファイルの指定）・`-v`（ボリューム削除）・`--privileged` などのフラグは通さない
//   （`docker run -v /:/host …` は、ホスト全体を触れてしまうため）。compose は、実行する作業フォルダの compose ファイルだけを使う。
//   ただし 1 つだけ、Shoestring の復旧用の形（`docker compose -f docker-compose-recovery.yaml up --abort-on-container-exit`）を通す。
//   ファイル名はこの 1 つに固定で、パスや別の名前は通さない（作業フォルダの、Shoestring が作ったファイルだけを指す）。
// - openssl は、3 つの形だけ: `openssl version` と、`openssl genpkey -algorithm ed25519 -out <名前>.pem`（Shoestring のメインキーを新しく作る）と、
//   `openssl pkey -in <名前>.pem -text [-noout]`（鍵の中身を見る。秘密鍵が画面に出るので、確認を通したときだけ）。
//   名前は作業フォルダの中の、`.pem` だけ（パス区切り・先頭の `-` は通さない）。エージェントは、genpkey では同じ名前のファイルがあれば上書きせず断り、pkey ではシンボリックリンクを辿らない。
// - `mkdir [-p] <名前>`（作業フォルダの中にフォルダを作る）と `cd [<フォルダ>]`（画面の「作業フォルダ」を変える。エージェントには送らず、画面が処理する）。どちらも作業場所の外（`..` の先・絶対パス・ドライブ名）は通さない。
// - 公式ドキュメントの書き方 `python3 -m shoestring <コマンド>`（`python` も同じ）は、`shoestring <コマンド>` に読み替えて判定する（`-m` の相手が `shoestring` のときだけ。
//   ほかのモジュール・`python3` 単体は通さない）。
// - 公式ドキュメントの pip の 3 つの形だけ、`python3 -m pip install symbol-shoestring` / `python3 -m pip install --upgrade symbol-shoestring` / `python3 -m pip show symbol-shoestring` を、そのまま通す
//   （パッケージ名は symbol-shoestring に固定。ほかのパッケージ・オプションは通さない）。エージェントは、tools/venv があればその Python の pip、なければ PC の python3 の pip で動かす。
// - 秘密鍵を画面に出すもの（`--show-private` と `openssl pkey … -text`）は、使う人が画面の確認ポップアップで同意したとき（opts.secret）だけ通す。
//   同意がなければ secret_confirm_required で断る。エージェントも画面を信用せず、同意の印（secret: true）が無ければ同じ理由で断る。
// - `wizard`（対話式。symbol-bootstrap の wizard と、Shoestring の wizard = `python3 -m shoestring.wizard`）は、使う人が画面で「有効」にしたときだけ通す（opts.wizard）。初期値は無効。
//   `shoestring wizard` は、この画面の呼び名で、エージェントが Shoestring の wizard モジュールに置き換えて動かす（引数は付けられない）。

export type ToolName = 'symbol-bootstrap' | 'shoestring' | 'symbol-node-watcher' | 'docker' | 'node' | 'irome' | 'openssl' | 'pip' | 'mkdir' | 'cd';
export type InstallTarget = 'bootstrap' | 'shoestring' | 'nodewatch' | 'node' | 'python';

export const MAX_LINE_LENGTH = 2000;
export const MAX_ARGS = 40;
export const INSTALL_TARGETS: readonly InstallTarget[] = ['bootstrap', 'shoestring', 'nodewatch', 'node', 'python'];
/** `irome install …` / `irome uninstall …` / `irome upgrade …` の動詞。uninstall は、作業場所の tools/ に入れたものを消すだけ（画面では、確認の注意を出してから実行する）。 */
export const IROME_VERBS = ['install', 'uninstall', 'upgrade'] as const;
/** `irome upgrade …` で更新できるもの。Shoestring（tools/venv の pip install --upgrade symbol-shoestring）と、symbol-bootstrap（公式の手順どおり、git clone → build → pack して tools/ に入れる）と、symbol-node-watcher（tools/ に npm の最新版を入れ直す）だけ。 */
export const UPGRADE_TARGETS: readonly InstallTarget[] = ['shoestring', 'bootstrap', 'nodewatch'];
/** `python3 -m pip …` で通す、3 つの形だけ（公式ドキュメントのとおり。パッケージ名は symbol-shoestring に固定）。 */
export const PIP_ALLOWED: readonly string[] = ['install symbol-shoestring', 'install --upgrade symbol-shoestring', 'show symbol-shoestring'];
/** `docker compose -f …` で通す、たった 1 つのファイル名（Shoestring が作業フォルダに作る復旧用の compose）。 */
export const RECOVERY_COMPOSE_FILE = 'docker-compose-recovery.yaml';
/** `openssl genpkey … -out <名前>` の名前: 作業フォルダの中の `.pem` だけ（パス区切りなし・先頭は英数字）。 */
export const OPENSSL_KEY_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.pem$/;

/**
 * サブコマンドを持つツールの、実行を許すサブコマンド。symbol-bootstrap の `encrypt` `decrypt`（設定・鍵の暗号化と復号）も、使う人が決めることとして通す。
 * `wizard`（対話式）もこの一覧にあるが、通るのは使う人が画面で有効にしたとき（ValidateOptions.wizard）だけ。
 */
export const SUBCOMMANDS: Readonly<Record<'symbol-bootstrap' | 'shoestring' | 'symbol-node-watcher', readonly string[]>> = {
  'symbol-bootstrap': ['config', 'compose', 'run', 'start', 'stop', 'clean', 'healthCheck', 'resetData', 'report', 'verify', 'updateVotingKeys', 'link', 'pack', 'wizard', 'encrypt', 'decrypt'],
  shoestring: ['init', 'setup', 'upgrade', 'health', 'import-bootstrap', 'import-harvesters', 'renew-certificates', 'renew-voting-keys', 'reset-data', 'pemtool', 'pemview', 'signer', 'announce-transaction', 'min-cosignatures-count', 'wizard'],
  'symbol-node-watcher': ['start', 'stop'],
};

const HELP_FLAGS = new Set(['--help', '-h', '--version']);
/** 秘密鍵をコンソールに出すフラグ。確認（opts.secret）を通したときだけ通す。`--flag=value` の形も同じに扱う。 */
const SECRET_FLAGS = new Set(['--show-private']);
/** 同意（opts.secret）が無いときの、断る理由。 */
export const SECRET_CONFIRM_REQUIRED = 'secret_confirm_required';
const DOCKER_TOP = new Set(['--version', 'version', 'info', 'ps', 'logs', 'stats', 'compose', 'start', 'stop', 'restart', 'rm', 'pull']);
/** compose の見る系と、運用の操作。`exec` `run` `build` `config` `cp` などは通さない。 */
const DOCKER_COMPOSE_SUB = new Set(['version', 'ps', 'logs', 'up', 'down', 'start', 'stop', 'restart', 'pull']);
const DOCKER_FLAGS_NOVALUE = new Set(['-a', '--all', '-f', '--follow', '-t', '--timestamps', '--no-stream']);
const DOCKER_FLAGS_VALUE = new Set(['--tail', '-n', '--since']);
/** 運用の操作ごとに通すフラグ（値なし）。`down -v`（ボリューム削除）・`--rmi`・`rm -f`・`-f <ファイル>` は通さない。 */
const DOCKER_OPS_NOVALUE: Readonly<Record<string, ReadonlySet<string>>> = {
  start: new Set(),
  stop: new Set(),
  restart: new Set(),
  rm: new Set(),
  pull: new Set(['-q', '--quiet']),
  'compose up': new Set(['-d', '--detach', '--remove-orphans', '--force-recreate', '--no-recreate', '--wait', '--no-build', '--abort-on-container-exit']),
  'compose down': new Set(['--remove-orphans']),
  'compose start': new Set(),
  'compose stop': new Set(),
  'compose restart': new Set(),
  'compose pull': new Set(['-q', '--quiet']),
};
/** 秒数を取るフラグ（停止の待ち時間）。 */
const DOCKER_OPS_SECONDS: Readonly<Record<string, ReadonlySet<string>>> = {
  start: new Set(),
  stop: new Set(['-t', '--time']),
  restart: new Set(['-t', '--time']),
  rm: new Set(),
  pull: new Set(),
  'compose up': new Set(['-t', '--timeout']),
  'compose down': new Set(['-t', '--timeout']),
  'compose start': new Set(),
  'compose stop': new Set(['-t', '--timeout']),
  'compose restart': new Set(['-t', '--timeout']),
  'compose pull': new Set(),
};
const DOCKER_VALUE = /^[0-9A-Za-z:.+-]{1,40}$/;
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** pull の対象（イメージ名。`registry/名前:タグ`）。ダイジェスト（@）・URL の記号・`..` は通さない。 */
const DOCKER_IMAGE = /^[a-z0-9][a-z0-9._/-]{0,127}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/;
const DOCKER_SECONDS = /^[0-9]{1,4}$/;

/**
 * 判定の設定。wizard: true のときだけ `symbol-bootstrap wizard` / `shoestring wizard` を通す（画面の「wizard を有効にする」）。
 * secret: true のときだけ、秘密鍵が画面に出る形（`--show-private`・`openssl pkey … -text`）を通す（画面の確認ポップアップで同意したとき）。
 */
export interface ValidateOptions { wizard?: boolean; secret?: boolean }
/** wizard を有効にしていないときの、断る理由。 */
export const WIZARD_DISABLED = 'wizard_disabled';

export type Tokenized = { ok: true; argv: string[] } | { ok: false; reason: string };
export type Validated = { ok: true; tool: ToolName; argv: string[] } | { ok: false; reason: string };

const SHELL_CHARS = new Set(['|', '&', ';', '<', '>', '$', '`', '(', ')', '\\']);

/** 1 行を引数に分ける。'…' と "…" の中の空白は区切りにしない。引用の外のシェル記号は、効かないので最初から断る。 */
export function tokenize(line: string): Tokenized {
  if (line.length > MAX_LINE_LENGTH) return { ok: false, reason: 'line_too_long' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(line)) return { ok: false, reason: 'control_char' };
  const argv: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (ch === ' ' || ch === '\t') {
      if (started) { argv.push(cur); cur = ''; started = false; }
      continue;
    }
    if (SHELL_CHARS.has(ch)) return { ok: false, reason: 'shell_char' };
    cur += ch;
    started = true;
  }
  if (quote) return { ok: false, reason: 'unclosed_quote' };
  if (started) argv.push(cur);
  if (argv.length === 0) return { ok: false, reason: 'empty' };
  if (argv.length > MAX_ARGS) return { ok: false, reason: 'too_many_args' };
  return { ok: true, argv };
}

const bad = (reason: string): Validated => ({ ok: false, reason });

function validateDocker(argv: string[]): Validated {
  const sub = argv[1];
  if (!sub || !DOCKER_TOP.has(sub)) return bad('docker_subcommand');
  let rest = argv.slice(2);
  let opKey: string = sub;
  if (sub === 'compose') {
    // 復旧用の 1 つだけ: `-f docker-compose-recovery.yaml up …`（ファイル名は固定。ほかの -f・別の名前・パスは通さない）
    if (rest[0] === '-f' || rest[0] === '--file') {
      if (rest[1] !== RECOVERY_COMPOSE_FILE || rest[2] !== 'up') return bad('docker_compose_file');
      rest = rest.slice(2);
    }
    const c = rest[0];
    if (!c || !DOCKER_COMPOSE_SUB.has(c)) return bad('docker_compose_subcommand');
    rest = rest.slice(1);
    opKey = `compose ${c}`;
  }
  const noValue = DOCKER_OPS_NOVALUE[opKey];
  if (noValue) {
    // 運用の操作: フラグは操作ごとの決まったものだけ。コンテナ名・サービス名・イメージ名は位置引数。
    const seconds = DOCKER_OPS_SECONDS[opKey];
    let positional = 0;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (noValue.has(a)) continue;
      if (seconds.has(a)) {
        if (!DOCKER_SECONDS.test(rest[i + 1] ?? '')) return bad('docker_flag_value');
        i++;
        continue;
      }
      if (a.startsWith('-')) return bad('docker_flag');
      if (!(sub === 'pull' ? DOCKER_IMAGE.test(a) : DOCKER_NAME.test(a))) return bad('docker_argument');
      positional++;
    }
    // コンテナの start / stop / restart / rm と pull は、対象が要る（引数なしで全部には効かせない）。
    if (!opKey.startsWith('compose') && positional === 0) return bad('docker_target_required');
    return { ok: true, tool: 'docker', argv };
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (DOCKER_FLAGS_NOVALUE.has(a)) continue;
    if (DOCKER_FLAGS_VALUE.has(a)) {
      if (!DOCKER_VALUE.test(rest[i + 1] ?? '')) return bad('docker_flag_value');
      i++;
      continue;
    }
    // `--tail=50` の形（公式ドキュメントの `docker compose logs --tail=50`）も、`--tail 50` と同じに通す
    if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      if (!DOCKER_FLAGS_VALUE.has(a.slice(0, eq))) return bad('docker_flag');
      if (!DOCKER_VALUE.test(a.slice(eq + 1))) return bad('docker_flag_value');
      continue;
    }
    if (a.startsWith('-')) return bad('docker_flag');
    // 位置引数は、logs のコンテナ名・compose のサービス名だけ。
    if (!(sub === 'logs' || sub === 'compose') || !DOCKER_NAME.test(a)) return bad('docker_argument');
  }
  return { ok: true, tool: 'docker', argv };
}

/** `mkdir` / `cd` の名前（相対パス）。`..` と絶対パスは、作業場所の外に出るので通さない（cd の `..` は resolveCd が、今の作業フォルダを見て扱う）。 */
function validateMkdir(argv: string[]): Validated {
  const rest = argv.slice(1);
  const p = rest[0] === '-p';
  const names = p ? rest.slice(1) : rest;
  if (names.length !== 1) return bad('mkdir_usage');
  const v = validateSubdir(names[0]);
  // 空・`.` は作る意味が無い。`..`・絶対パス・ドライブ名・Windows で別の意味になる名前は、validateSubdir が断る。
  if (!v.ok || v.value === '') return bad('mkdir_usage');
  return { ok: true, tool: 'mkdir', argv: p ? ['mkdir', '-p', v.value] : ['mkdir', v.value] };
}

function validateCd(argv: string[]): Validated {
  if (argv.length > 2) return bad('cd_usage');
  if (argv.length === 1) return { ok: true, tool: 'cd', argv };
  // 形だけ見る（今の作業フォルダを使った行き先の判定は、resolveCd が行う）
  const r = resolveCd('a/b/c/d/e/f/g/h', argv[1]);
  return r.ok ? { ok: true, tool: 'cd', argv } : bad('cd_usage');
}

/**
 * `cd` の行き先を、今の作業フォルダ（作業場所の中の相対パス。空は直下）から決める。`cd` 単体・`cd ~`・`cd /` は直下、`cd ..` は 1 つ上、`cd 名前` は今のフォルダの中。
 * 作業場所の外に出る指定（直下より上・絶対パス・ドライブ名）は断る。行き先は validateSubdir にもかけ、画面の「作業フォルダ」と同じ決まりにそろえる。
 * フォルダが実際にあるかは見ない（作業フォルダは、実行のときに無ければ自動で作られる）。
 */
export function resolveCd(current: string, arg?: string): { ok: true; value: string } | { ok: false; reason: string } {
  const a = (arg ?? '').trim().replace(/\\/g, '/');
  if (a === '' || a === '~' || a === '~/') return { ok: true, value: '' };
  if (a.startsWith('/') || a.startsWith('~') || /^[A-Za-z]:/.test(a)) return { ok: false, reason: 'subdir_invalid' };
  const stack = current === '' ? [] : current.split('/');
  for (const seg of a.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (stack.length === 0) return { ok: false, reason: 'subdir_invalid' }; stack.pop(); continue; }
    stack.push(seg);
  }
  return validateSubdir(stack.join('/'));
}

const flagNameOf = (a: string) => (a.startsWith('--') ? a.split('=')[0] : a);

/** 秘密鍵が画面に出る形か（`--show-private` を含む、または `openssl pkey -in <名前>.pem -text`）。画面とエージェントが、確認が要るかを決めるのに使う。 */
export function isSecretArgv(argv: readonly string[]): boolean {
  if (argv.slice(1).some((a) => SECRET_FLAGS.has(flagNameOf(a)))) return true;
  return argv[0] === 'openssl' && argv[1] === 'pkey';
}

/** 引数の配列が、許すコマンドかどうかを判定する。秘密鍵が出る形は、opts.secret が true のときだけ通す。 */
export function validateArgv(argv: string[], opts: ValidateOptions = {}): Validated {
  const r = validateArgvInner(argv, opts);
  // 形そのものが許されないものは、その理由のまま断る（確認を求めるのは、確認すれば通る形だけ）
  if (r.ok && isSecretArgv(r.argv) && opts.secret !== true) return bad(SECRET_CONFIRM_REQUIRED);
  return r;
}

function validateArgvInner(argv: string[], opts: ValidateOptions): Validated {
  if (argv.length === 0) return bad('empty');
  if (argv.some((a) => a.length > 500 || a.includes('\0'))) return bad('arg_too_long');
  // `python3 -m pip …` は、公式ドキュメントの 3 つの形だけ（argv は、そのまま返す）
  if ((argv[0] === 'python3' || argv[0] === 'python') && argv[1] === '-m' && argv[2] === 'pip') return PIP_ALLOWED.includes(argv.slice(3).join(' ')) ? { ok: true, tool: 'pip', argv } : bad('pip_usage');
  // `python3 -m shoestring …` は `shoestring …` と同じ（読み替えた argv で判定し、返す argv も読み替えたもの）。ほかの `python3 -m …` は、下の tool_not_allowed になる
  if ((argv[0] === 'python3' || argv[0] === 'python') && argv[1] === '-m' && argv[2] === 'shoestring') return validateArgv(['shoestring', ...argv.slice(3)], opts);
  const tool = argv[0];

  if (tool === 'mkdir') return validateMkdir(argv);
  if (tool === 'cd') return validateCd(argv);
  if (tool === 'node') {
    return argv.length === 2 && (argv[1] === '--version' || argv[1] === '-v') ? { ok: true, tool, argv } : bad('node_only_version');
  }
  if (tool === 'docker') return validateDocker(argv);
  if (tool === 'irome') {
    const okShape = argv.length === 3 && (IROME_VERBS as readonly string[]).includes(argv[1]) && (INSTALL_TARGETS as readonly string[]).includes(argv[2]);
    // upgrade は、Shoestring・bootstrap・nodewatch だけ
    return okShape && (argv[1] !== 'upgrade' || (UPGRADE_TARGETS as readonly string[]).includes(argv[2])) ? { ok: true, tool, argv } : bad('irome_usage');
  }
  if (tool === 'openssl') {
    if (argv.length === 2 && argv[1] === 'version') return { ok: true, tool, argv };
    // 新しいメインキーを作る形だけ: openssl genpkey -algorithm ed25519 -out <名前>.pem
    if (argv.length === 6 && argv[1] === 'genpkey' && argv[2] === '-algorithm' && argv[3] === 'ed25519' && argv[4] === '-out' && OPENSSL_KEY_FILE.test(argv[5])) return { ok: true, tool, argv };
    // 鍵の中身を見る形だけ: openssl pkey -in <名前>.pem -text [-noout]（秘密鍵が出る。isSecretArgv が確認を求める）
    if ((argv.length === 5 || (argv.length === 6 && argv[5] === '-noout')) && argv[1] === 'pkey' && argv[2] === '-in' && OPENSSL_KEY_FILE.test(argv[3]) && argv[4] === '-text') return { ok: true, tool, argv };
    return bad('openssl_usage');
  }
  if (tool === 'symbol-bootstrap' || tool === 'shoestring' || tool === 'symbol-node-watcher') {
    if (argv.length === 1) return bad('missing_subcommand');
    const sub = argv[1];
    if (HELP_FLAGS.has(sub) && argv.length === 2) return { ok: true, tool, argv };
    if (!SUBCOMMANDS[tool].includes(sub)) return bad('subcommand_not_allowed');
    if (sub === 'wizard' && tool !== 'symbol-node-watcher') {
      if (opts.wizard !== true) return bad(WIZARD_DISABLED);
      if (tool === 'shoestring' && argv.length !== 2) return bad('too_many_args'); // Shoestring の wizard は、引数なしだけ
    }
    if (sub === 'start' && tool === 'symbol-node-watcher' && argv.length > 3) return bad('too_many_args');
    return { ok: true, tool, argv };
  }
  return bad('tool_not_allowed');
}

/** 1 行を、引数に分けて判定する（画面もエージェントもこれを使う）。 */
export function parseCommandLine(line: string, opts: ValidateOptions = {}): Validated {
  const t = tokenize(line);
  if (!t.ok) return t;
  return validateArgv(t.argv, opts);
}

/** `symbol-bootstrap wizard` / `shoestring wizard` の行かどうか（引数の配列で見る）。 */
export const isWizardArgv = (argv: readonly string[]): boolean => (argv[0] === 'symbol-bootstrap' || argv[0] === 'shoestring') && argv[1] === 'wizard';

/** 作業フォルダ（ワークスペースの中の相対パス）。空は「ワークスペース直下」。`..`・絶対パス・ドライブ名は断る。 */
export function validateSubdir(sub: string): { ok: true; value: string } | { ok: false; reason: string } {
  const v = sub.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (v === '' || v === '.') return { ok: true, value: '' };
  if (v.length > 200) return { ok: false, reason: 'subdir_invalid' };
  if (v.startsWith('/') || /^[A-Za-z]:/.test(v) || v.split('/').some((p) => p === '..' || p === '' || p === '.')) return { ok: false, reason: 'subdir_invalid' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(v)) return { ok: false, reason: 'subdir_invalid' };
  if (!windowsSafeSegments(v)) return { ok: false, reason: 'subdir_invalid' };
  return { ok: true, value: v };
}

/**
 * Windows で、別の意味になる名前を、どの OS でも断る（同じ作業場所を Windows と Linux で使っても、同じ判定になるように）。
 * - `:`（ドライブ名・NTFS の代替データストリーム `a.txt:x`）・`* ? " < > |`
 * - 末尾が `.` か空白のもの（Windows は黙って削る）
 * - `~1` のような短い名前の形（Windows が、長い名前の別名として扱う）
 * - 予約名（CON・PRN・AUX・NUL・COM1〜9・LPT1〜9。拡張子がついていても同じ）
 */
export function windowsSafeSegments(path: string): boolean {
  return path.split('/').every((seg) => {
    if (/[:*?"<>|]/.test(seg)) return false;
    if (/~\d/.test(seg)) return false; // Windows の短い名前（PROGRA~1 など）は、別の名前の別名になる
    if (/[. ]$/.test(seg)) return false;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(seg)) return false;
    return true;
  });
}

/** 画面の「入れる」ボタン用のひな型（クリックしたら入力欄に入るだけ。実行は Enter）。 */
/** secret: 実行すると秘密鍵が画面に出る（押して入力欄に入れたあと、Enter で実行するときに、確認ポップアップが出る）。 */
export interface CommandPreset { group: 'check' | 'docker' | 'install' | 'bootstrap' | 'shoestring' | 'nodewatch'; line: string; noteKey: string; secret?: true }
export const COMMAND_PRESETS: readonly CommandPreset[] = [
  { group: 'check', line: 'docker --version', noteKey: 'service.node_pre_docker' },
  { group: 'check', line: 'node --version', noteKey: 'service.node_pre_node' },
  { group: 'check', line: 'docker compose version', noteKey: 'service.node_pre_dk_compose_version' },
  { group: 'check', line: 'openssl version', noteKey: 'service.node_pre_openssl_version' },
  { group: 'docker', line: 'docker ps -a', noteKey: 'service.node_pre_dk_ps' },
  { group: 'docker', line: 'docker compose up -d', noteKey: 'service.node_pre_dk_up' },
  { group: 'docker', line: 'docker compose ps -a', noteKey: 'service.node_pre_dk_ps_compose' },
  { group: 'docker', line: 'docker compose down', noteKey: 'service.node_pre_dk_down' },
  { group: 'docker', line: 'docker compose restart', noteKey: 'service.node_pre_dk_restart' },
  { group: 'docker', line: 'docker compose pull', noteKey: 'service.node_pre_dk_pull' },
  { group: 'docker', line: 'docker compose ps', noteKey: 'service.node_pre_dk_ps_plain' },
  { group: 'docker', line: 'docker compose logs --tail=50', noteKey: 'service.node_pre_dk_logs' },
  { group: 'docker', line: 'docker compose logs -f', noteKey: 'service.node_pre_dk_logs_follow' },
  { group: 'docker', line: 'docker compose -f docker-compose-recovery.yaml up --abort-on-container-exit', noteKey: 'service.node_pre_dk_recovery' },
  { group: 'install', line: 'irome install bootstrap', noteKey: 'service.node_pre_install_bootstrap' },
  { group: 'install', line: 'python3 -m pip install symbol-shoestring', noteKey: 'service.node_pre_pip_install' },
  { group: 'install', line: 'python3 -m pip install --upgrade symbol-shoestring', noteKey: 'service.node_pre_pip_upgrade' },
  { group: 'install', line: 'python3 -m pip show symbol-shoestring', noteKey: 'service.node_pre_pip_show' },
  { group: 'install', line: 'irome install shoestring', noteKey: 'service.node_pre_install_shoestring' },
  { group: 'install', line: 'irome upgrade shoestring', noteKey: 'service.node_pre_upgrade_shoestring' },
  { group: 'install', line: 'irome upgrade bootstrap', noteKey: 'service.node_pre_upgrade_bootstrap' },
  { group: 'install', line: 'irome upgrade nodewatch', noteKey: 'service.node_pre_upgrade_nodewatch' },
  { group: 'install', line: 'irome install nodewatch', noteKey: 'service.node_pre_install_nodewatch' },
  { group: 'install', line: 'irome install node', noteKey: 'service.node_pre_install_node' },
  { group: 'install', line: 'irome install python', noteKey: 'service.node_pre_install_python' },
  { group: 'bootstrap', line: 'symbol-bootstrap config -p testnet -a dual --noPassword', noteKey: 'service.node_pre_bs_config' },
  { group: 'bootstrap', line: 'symbol-bootstrap config -p mainnet -a dual -c custom-preset.yml --noPassword', noteKey: 'service.node_pre_bs_config_mainnet' },
  { group: 'bootstrap', line: 'symbol-bootstrap compose', noteKey: 'service.node_pre_bs_compose' },
  { group: 'bootstrap', line: 'symbol-bootstrap run -d', noteKey: 'service.node_pre_bs_run' },
  { group: 'bootstrap', line: 'symbol-bootstrap healthCheck', noteKey: 'service.node_pre_bs_health' },
  { group: 'bootstrap', line: 'symbol-bootstrap stop', noteKey: 'service.node_pre_bs_stop' },
  { group: 'bootstrap', line: 'symbol-bootstrap --version', noteKey: 'service.node_pre_bs_version' },
  { group: 'bootstrap', line: 'symbol-bootstrap start -p mainnet -a dual -d --upgrade', noteKey: 'service.node_pre_bs_upgrade' },
  // Shoestring の公式手順（ノードの作成と実行・ノードの保守）に沿ったひな型。順番と説明は lib/node/shoestringGuide.ts
  { group: 'shoestring', line: 'mkdir symbol-node', noteKey: 'service.node_pre_mkdir' },
  { group: 'shoestring', line: 'cd symbol-node', noteKey: 'service.node_pre_cd' },
  { group: 'shoestring', line: 'python3 -m shoestring --help', noteKey: 'service.node_pre_ss_help' },
  { group: 'shoestring', line: 'python3 -m shoestring init --help', noteKey: 'service.node_pre_ss_help_cmd' },
  { group: 'shoestring', line: 'python3 -m shoestring init --package sai config.ini', noteKey: 'service.node_pre_ss_init' },
  { group: 'shoestring', line: 'python3 -m shoestring init --package mainnet config.ini', noteKey: 'service.node_pre_ss_init_mainnet' },
  { group: 'shoestring', line: 'shoestring wizard', noteKey: 'service.node_pre_ss_wizard' },
  { group: 'shoestring', line: 'openssl genpkey -algorithm ed25519 -out ca.key.pem', noteKey: 'service.node_pre_ss_genpkey' },
  { group: 'shoestring', line: 'python3 -m shoestring pemtool --output ca.key.pem', noteKey: 'service.node_pre_ss_pemtool' },
  { group: 'shoestring', line: 'python3 -m shoestring pemview --input ca.key.pem --network mainnet', noteKey: 'service.node_pre_ss_pemview' },
  { group: 'shoestring', line: 'python3 -m shoestring pemview --input ca.key.pem --network mainnet --show-private', noteKey: 'service.node_pre_ss_pemview_secret', secret: true },
  { group: 'shoestring', line: 'openssl pkey -in ca.key.pem -text', noteKey: 'service.node_pre_openssl_pkey', secret: true },
  { group: 'shoestring', line: 'python3 -m shoestring import-bootstrap --config config.ini --bootstrap ../bootstrap-node/target --include-node-key', noteKey: 'service.node_pre_ss_import_bootstrap' },
  { group: 'shoestring', line: 'python3 -m shoestring setup --config ./config.ini --overrides ./overrides.ini --package sai --directory . --ca-key-path ./ca.key.pem', noteKey: 'service.node_pre_ss_setup' },
  { group: 'shoestring', line: 'python3 -m shoestring setup --config ./config.ini --overrides ./overrides.ini --package mainnet --directory . --ca-key-path ./ca.key.pem', noteKey: 'service.node_pre_ss_setup_mainnet' },
  { group: 'shoestring', line: 'python3 -m shoestring setup --config ./config.ini --overrides ./overrides.ini --package mainnet --directory . --ca-key-path ./ca.key.pem --output-transaction-only', noteKey: 'service.node_pre_ss_setup_tx_only' },
  { group: 'shoestring', line: 'python3 -m shoestring signer --config config.ini --ca-key-path ca.key.pem --save linking_transaction.dat', noteKey: 'service.node_pre_ss_signer' },
  { group: 'shoestring', line: 'python3 -m shoestring announce-transaction --config config.ini --transaction linking_transaction.dat', noteKey: 'service.node_pre_ss_announce' },
  { group: 'shoestring', line: 'python3 -m shoestring health --config config.ini --directory .', noteKey: 'service.node_pre_ss_health' },
  { group: 'shoestring', line: 'python3 -m shoestring upgrade --config config.ini --directory . --overrides overrides.ini', noteKey: 'service.node_pre_ss_upgrade' },
  { group: 'shoestring', line: 'python3 -m shoestring renew-certificates --config config.ini --directory . --ca-key-path ca.key.pem', noteKey: 'service.node_pre_ss_renew_cert_plain' },
  { group: 'shoestring', line: 'python3 -m shoestring renew-certificates --config config.ini --directory . --ca-key-path ca.key.pem --retain-node-key', noteKey: 'service.node_pre_ss_renew_cert' },
  { group: 'shoestring', line: 'python3 -m shoestring renew-voting-keys --config config.ini --directory .', noteKey: 'service.node_pre_ss_renew_voting' },
  { group: 'shoestring', line: 'python3 -m shoestring reset-data --config ./config.ini --directory .', noteKey: 'service.node_pre_ss_reset' },
  { group: 'nodewatch', line: 'symbol-node-watcher start', noteKey: 'service.node_pre_nw_start' },
  { group: 'nodewatch', line: 'symbol-node-watcher stop', noteKey: 'service.node_pre_nw_stop' },
];

/** エージェントの URL として使ってよいか（この PC 自身だけ。別のマシンのノードは、SSH のポート転送で localhost に寄せて使う）。 */
export function isLoopbackAgentUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:') return false;
  const h = u.hostname.replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/** 画面から読み書きできる、作業場所の中のファイル（設定ファイルだけ。鍵（.pem / .key）や実行ファイルは対象外）。 */
export const EDITABLE_EXTENSIONS: readonly string[] = ['.ini', '.yml', '.yaml', '.json', '.properties', '.txt'];
export const MAX_FILE_BYTES = 256 * 1024;

/**
 * 秘密鍵が平文で入っている場所（symbol-bootstrap の target/addresses.yml と、target/addresses/ の中）。設定ファイルエディタでは開けない・書けない。
 * 大文字小文字の違い、Windows が無視する末尾の `.` と空白（`addresses.yml.` など）も同じものとして扱う。
 * パスは「作業場所の中の相対パス」を `/` で分けたもの。実体（シンボリックリンクの先）に直した形で渡しても使える。
 */
export function isKeyMaterialPath(parts: readonly string[]): boolean {
  const norm = parts.map((p) => p.toLowerCase().replace(/[. ]+$/, ''));
  for (let i = 0; i + 1 < norm.length; i++) {
    if (norm[i] !== 'target') continue;
    if (norm[i + 1] === 'addresses' || norm[i + 1] === 'addresses.yml' || norm[i + 1] === 'addresses.yaml') return true;
  }
  return false;
}

export function validateWorkspaceFile(path: string): { ok: true; value: string } | { ok: false; reason: string } {
  const sub = validateSubdir(path);
  if (!sub.ok || sub.value === '') return { ok: false, reason: 'path_invalid' };
  const parts = sub.value.split('/');
  // tools/（導入したツール）と node_modules の中は触らせない
  // 大文字・小文字を区別しない OS（Windows・macOS の標準）では、`Tools/` も `tools/` と同じ場所なので、小文字にそろえて見る
  const low = parts.map((x) => x.toLowerCase());
  if (low[0] === 'tools' || low.includes('node_modules') || low.includes('.git')) return { ok: false, reason: 'path_invalid' };
  // 秘密鍵が平文で入る target/addresses.yml（と target/addresses/）は、読めても書けても困るので、拡張子の判定より先に断る
  if (isKeyMaterialPath(parts)) return { ok: false, reason: 'key_file' };
  const name = parts[parts.length - 1].toLowerCase();
  // compose ファイルは、画面から書き換えさせない（`docker compose up` が通るため、任意のマウント・特権を書かれると、ホスト全体を触れてしまう。
  // symbol-bootstrap が作った（target/docker/docker-compose.yml）ものだけを動かす）。
  if (/^(docker-)?compose([.-][^/]*)?\.ya?ml$/.test(name)) return { ok: false, reason: 'compose_file_protected' };
  if (!EDITABLE_EXTENSIONS.some((e) => name.endsWith(e)) || name.startsWith('.')) return { ok: false, reason: 'ext_not_allowed' };
  return { ok: true, value: sub.value };
}
