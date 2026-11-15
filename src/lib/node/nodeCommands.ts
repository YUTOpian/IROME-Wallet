// ノード構築コンソール: 「打ってよいコマンド」の決まり。ウォレットの画面（入力の事前チェック）と、
// ローカルのエージェント（src/server/node-agent/）の両方が同じものを使う。エージェント側は画面を信用せず、必ずもう一度この判定にかける。
//
// 方針:
// - シェルは使わない。1 行を引数の配列に分けて、そのまま実行ファイルに渡す（`|` `;` `&` `>` `$` `` ` `` は使えない）。
// - 実行できるのは、決まった 5 種類（symbol-bootstrap / shoestring / symbol-node-watcher / docker の確認系 / node --version）と、
//   エージェントが用意した導入・削除のレシピ（irome install … / irome uninstall …）だけ。任意のコマンドは通さない。
// - docker は `run` `exec` `rm` などを通さない（`docker run -v /:/host …` は、ホスト全体を触れてしまうため）。見る系（ps / logs / info / stats）だけ。
// - 秘密鍵を画面に出すフラグ（--show-private）は通さない。
// - symbol-bootstrap の `wizard`（対話式）は、使う人が画面で「有効」にしたときだけ通す（opts.wizard）。初期値は無効。

export type ToolName = 'symbol-bootstrap' | 'shoestring' | 'symbol-node-watcher' | 'docker' | 'node' | 'irome';
export type InstallTarget = 'bootstrap' | 'shoestring' | 'nodewatch';

export const MAX_LINE_LENGTH = 2000;
export const MAX_ARGS = 40;
export const INSTALL_TARGETS: readonly InstallTarget[] = ['bootstrap', 'shoestring', 'nodewatch'];
/** `irome install …` / `irome uninstall …` の動詞。uninstall は、作業場所の tools/ に入れたものを消すだけ（画面では、確認の注意を出してから実行する）。 */
export const IROME_VERBS = ['install', 'uninstall'] as const;

/**
 * サブコマンドを持つツールの、実行を許すサブコマンド。symbol-bootstrap の `encrypt` `decrypt`（設定・鍵の暗号化と復号）も、使う人が決めることとして通す。
 * `wizard`（対話式）もこの一覧にあるが、通るのは使う人が画面で有効にしたとき（ValidateOptions.wizard）だけ。
 */
export const SUBCOMMANDS: Readonly<Record<'symbol-bootstrap' | 'shoestring' | 'symbol-node-watcher', readonly string[]>> = {
  'symbol-bootstrap': ['config', 'compose', 'run', 'start', 'stop', 'clean', 'healthCheck', 'resetData', 'report', 'verify', 'updateVotingKeys', 'link', 'pack', 'wizard', 'encrypt', 'decrypt'],
  shoestring: ['init', 'setup', 'upgrade', 'health', 'import-bootstrap', 'import-harvesters', 'renew-certificates', 'renew-voting-keys', 'reset-data', 'pemtool', 'signer', 'announce-transaction', 'min-cosignatures-count'],
  'symbol-node-watcher': ['start', 'stop'],
};

const HELP_FLAGS = new Set(['--help', '-h', '--version']);
/** どのツールでも通さないフラグ（秘密鍵をコンソールに出す）。`--flag=value` の形も同じく拒否する。 */
const DENIED_FLAGS = new Set(['--show-private']);
const DOCKER_TOP = new Set(['--version', 'version', 'info', 'ps', 'logs', 'stats', 'compose']);
const DOCKER_COMPOSE_SUB = new Set(['version', 'ps', 'logs']);
const DOCKER_FLAGS_NOVALUE = new Set(['-a', '--all', '-f', '--follow', '-t', '--timestamps', '--no-stream']);
const DOCKER_FLAGS_VALUE = new Set(['--tail', '-n', '--since']);
const DOCKER_VALUE = /^[0-9A-Za-z:.+-]{1,40}$/;
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** 判定の設定。wizard: true のときだけ `symbol-bootstrap wizard` を通す（画面の「wizard を有効にする」）。 */
export interface ValidateOptions { wizard?: boolean }
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
  if (sub === 'compose') {
    const c = rest[0];
    if (!c || !DOCKER_COMPOSE_SUB.has(c)) return bad('docker_compose_subcommand');
    rest = rest.slice(1);
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (DOCKER_FLAGS_NOVALUE.has(a)) continue;
    if (DOCKER_FLAGS_VALUE.has(a)) {
      if (!DOCKER_VALUE.test(rest[i + 1] ?? '')) return bad('docker_flag_value');
      i++;
      continue;
    }
    if (a.startsWith('-')) return bad('docker_flag');
    // 位置引数は、logs のコンテナ名・compose のサービス名だけ。
    if (!(sub === 'logs' || sub === 'compose') || !DOCKER_NAME.test(a)) return bad('docker_argument');
  }
  return { ok: true, tool: 'docker', argv };
}

/** 引数の配列が、許すコマンドかどうかを判定する。 */
export function validateArgv(argv: string[], opts: ValidateOptions = {}): Validated {
  if (argv.length === 0) return bad('empty');
  if (argv.some((a) => a.length > 500 || a.includes('\0'))) return bad('arg_too_long');
  const tool = argv[0];
  const flagName = (a: string) => (a.startsWith('--') ? a.split('=')[0] : a);
  if (argv.slice(1).some((a) => DENIED_FLAGS.has(flagName(a)))) return bad('denied_flag');

  if (tool === 'node') {
    return argv.length === 2 && (argv[1] === '--version' || argv[1] === '-v') ? { ok: true, tool, argv } : bad('node_only_version');
  }
  if (tool === 'docker') return validateDocker(argv);
  if (tool === 'irome') {
    return argv.length === 3 && (IROME_VERBS as readonly string[]).includes(argv[1]) && (INSTALL_TARGETS as readonly string[]).includes(argv[2])
      ? { ok: true, tool, argv }
      : bad('irome_usage');
  }
  if (tool === 'symbol-bootstrap' || tool === 'shoestring' || tool === 'symbol-node-watcher') {
    if (argv.length === 1) return bad('missing_subcommand');
    const sub = argv[1];
    if (HELP_FLAGS.has(sub) && argv.length === 2) return { ok: true, tool, argv };
    if (!SUBCOMMANDS[tool].includes(sub)) return bad('subcommand_not_allowed');
    if (tool === 'symbol-bootstrap' && sub === 'wizard' && opts.wizard !== true) return bad(WIZARD_DISABLED);
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

/** `symbol-bootstrap wizard` の行かどうか（引数の配列で見る）。 */
export const isWizardArgv = (argv: readonly string[]): boolean => argv[0] === 'symbol-bootstrap' && argv[1] === 'wizard';

/** 作業フォルダ（ワークスペースの中の相対パス）。空は「ワークスペース直下」。`..`・絶対パス・ドライブ名は断る。 */
export function validateSubdir(sub: string): { ok: true; value: string } | { ok: false; reason: string } {
  const v = sub.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (v === '' || v === '.') return { ok: true, value: '' };
  if (v.length > 200) return { ok: false, reason: 'subdir_invalid' };
  if (v.startsWith('/') || /^[A-Za-z]:/.test(v) || v.split('/').some((p) => p === '..' || p === '' || p === '.')) return { ok: false, reason: 'subdir_invalid' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(v)) return { ok: false, reason: 'subdir_invalid' };
  return { ok: true, value: v };
}

/** 画面の「入れる」ボタン用のひな型（クリックしたら入力欄に入るだけ。実行は Enter）。 */
export interface CommandPreset { group: 'check' | 'install' | 'bootstrap' | 'shoestring' | 'nodewatch'; line: string; noteKey: string }
export const COMMAND_PRESETS: readonly CommandPreset[] = [
  { group: 'check', line: 'docker --version', noteKey: 'service.node_pre_docker' },
  { group: 'check', line: 'node --version', noteKey: 'service.node_pre_node' },
  { group: 'install', line: 'irome install bootstrap', noteKey: 'service.node_pre_install_bootstrap' },
  { group: 'install', line: 'irome install shoestring', noteKey: 'service.node_pre_install_shoestring' },
  { group: 'install', line: 'irome install nodewatch', noteKey: 'service.node_pre_install_nodewatch' },
  { group: 'bootstrap', line: 'symbol-bootstrap config -p testnet -a dual --noPassword', noteKey: 'service.node_pre_bs_config' },
  { group: 'bootstrap', line: 'symbol-bootstrap config -p mainnet -a dual -c custom-preset.yml --noPassword', noteKey: 'service.node_pre_bs_config_mainnet' },
  { group: 'bootstrap', line: 'symbol-bootstrap compose', noteKey: 'service.node_pre_bs_compose' },
  { group: 'bootstrap', line: 'symbol-bootstrap run -d', noteKey: 'service.node_pre_bs_run' },
  { group: 'bootstrap', line: 'symbol-bootstrap healthCheck', noteKey: 'service.node_pre_bs_health' },
  { group: 'bootstrap', line: 'symbol-bootstrap stop', noteKey: 'service.node_pre_bs_stop' },
  { group: 'bootstrap', line: 'symbol-bootstrap --version', noteKey: 'service.node_pre_bs_version' },
  { group: 'bootstrap', line: 'symbol-bootstrap start -p mainnet -a dual -d --upgrade', noteKey: 'service.node_pre_bs_upgrade' },
  { group: 'shoestring', line: 'shoestring init config.ini --package sai', noteKey: 'service.node_pre_ss_init' },
  { group: 'shoestring', line: 'shoestring init config.ini --package mainnet', noteKey: 'service.node_pre_ss_init_mainnet' },
  { group: 'shoestring', line: 'shoestring health --config config.ini', noteKey: 'service.node_pre_ss_health' },
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

export function validateWorkspaceFile(path: string): { ok: true; value: string } | { ok: false; reason: string } {
  const sub = validateSubdir(path);
  if (!sub.ok || sub.value === '') return { ok: false, reason: 'path_invalid' };
  const parts = sub.value.split('/');
  // tools/（導入したツール）と node_modules の中は触らせない
  if (parts[0] === 'tools' || parts.includes('node_modules') || parts.includes('.git')) return { ok: false, reason: 'path_invalid' };
  const name = parts[parts.length - 1].toLowerCase();
  if (!EDITABLE_EXTENSIONS.some((e) => name.endsWith(e)) || name.startsWith('.')) return { ok: false, reason: 'ext_not_allowed' };
  return { ok: true, value: sub.value };
}
