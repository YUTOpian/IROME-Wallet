// ノード構築エージェントの常駐化（サーバー専用）。ログインしたときに自動で起動し、落ちたら起こし直す。
//
//   npm run node-agent-service -- install      登録して、すぐ起動する
//   npm run node-agent-service -- status       登録と、接続できるかを見る
//   npm run node-agent-service -- token        トークンを表示する（`--rotate` で作り直す）
//   npm run node-agent-service -- restart      再起動する
//   npm run node-agent-service -- uninstall    登録を外す（`--purge` で、設定とトークンも消す）
//
// OS ごとの仕組み（どれも「いまのユーザー」の権限で動かす。root・管理者では登録しない）:
//   Linux   : systemd のユーザーサービス（~/.config/systemd/user/irome-node-agent.service）
//   macOS   : launchd の LaunchAgent（~/Library/LaunchAgents/app.irome.node-agent.plist）
//   Windows : タスク スケジューラ（ログオン時に起動。タスク名 "IROME Node Agent"）
//
// 常駐させると、起動のたびに作る使い捨てトークンでは困る（再起動のたびに貼り直しになる）。そこで、トークンは
// 設定フォルダのファイル（agent-token。自分だけが読める権限）に 1 回だけ作り、エージェントはそこから読む。
// トークンは、ユニットファイル・plist・ログ・環境変数には入れない（`systemctl show` や `ps` に出さないため）。
// 待ち受けは、これまでどおり 127.0.0.1 だけ（常駐させても、外には開けない）。
// このファイルは、組み込みのモジュールだけを使う（ブラウザのウォレットは読み込まない）。
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SERVICE_NAME = 'irome-node-agent';
export const LAUNCHD_LABEL = 'app.irome.node-agent';
export const TASK_NAME = 'IROME Node Agent';
export const DEFAULT_PORT = 7391;
export const MIN_TOKEN = 32;

// ---------------------------------------------------------------------------------------------------------------
// 設定ファイル（agent.json）とトークンのファイル

/** 設定フォルダ。Linux: ~/.config/irome-node-agent、macOS: ~/Library/Application Support/irome-node-agent、Windows: %APPDATA%\irome-node-agent。 */
export function configDirOf(plat: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (plat === 'win32') return join(env.APPDATA && env.APPDATA !== '' ? env.APPDATA : join(home, 'AppData', 'Roaming'), 'irome-node-agent');
  if (plat === 'darwin') return join(home, 'Library', 'Application Support', 'irome-node-agent');
  return join(env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith('/') ? env.XDG_CONFIG_HOME : join(home, '.config'), 'irome-node-agent');
}

export interface AgentFileConfig { port?: number; workspace?: string; origins?: string[]; tokenFile?: string }
const CONFIG_KEYS = new Set(['port', 'workspace', 'origins', 'tokenFile']);

export const validPort = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1024 && n <= 65535;
/** 許可する Origin（`https://example.com` の形。パス・クエリ・空白は不可）。 */
export function validOrigin(s: string): boolean {
  if (!/^https?:\/\/[^\s,/?#]+$/i.test(s)) return false;
  try { return new URL(s).origin === s; } catch { return false; }
}

export type ParsedConfig = { ok: true; config: AgentFileConfig } | { ok: false; reason: string };
/** agent.json の中身を、決まった形だけ受け入れて読む（知らない項目・型違いは、黙って無視せず断る）。 */
export function parseAgentConfig(text: string): ParsedConfig {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ok: false, reason: '設定ファイルが JSON として読めません。' }; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, reason: '設定ファイルは、{ ... } の形にしてください。' };
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!CONFIG_KEYS.has(k)) return { ok: false, reason: `設定ファイルに、知らない項目「${k.slice(0, 40)}」があります。` };
  const config: AgentFileConfig = {};
  if (o.port !== undefined) { if (!validPort(o.port)) return { ok: false, reason: 'port は 1024〜65535 の整数です。' }; config.port = o.port; }
  if (o.workspace !== undefined) { if (typeof o.workspace !== 'string' || o.workspace.trim() === '' || o.workspace.length > 1000) return { ok: false, reason: 'workspace は、フォルダの場所（文字列）です。' }; config.workspace = o.workspace; }
  if (o.tokenFile !== undefined) { if (typeof o.tokenFile !== 'string' || o.tokenFile.trim() === '' || o.tokenFile.length > 1000) return { ok: false, reason: 'tokenFile は、ファイルの場所（文字列）です。' }; config.tokenFile = o.tokenFile; }
  if (o.origins !== undefined) {
    if (!Array.isArray(o.origins) || o.origins.length > 20 || !o.origins.every((s) => typeof s === 'string' && validOrigin(s))) return { ok: false, reason: 'origins は、https://example.com の形の文字列の配列です（20 個まで）。' };
    config.origins = o.origins as string[];
  }
  return { ok: true, config };
}

export type TokenRead = { ok: true; token: string } | { ok: false; reason: string };
/**
 * トークンのファイルを読む。Linux / macOS では、自分以外が読める権限（group / other に何か付いている）なら、使わずに断る
 * （ssh の鍵と同じ。漏れうるトークンを黙って使わない）。シンボリックリンクは辿らない。Windows は権限ビットが効かないので見ない。
 */
export function readTokenFile(path: string, plat: NodeJS.Platform = process.platform): TokenRead {
  let st;
  try { st = lstatSync(path); } catch { return { ok: false, reason: `トークンのファイルが見つかりません: ${path}` }; }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: `トークンのファイルは、普通のファイルにしてください（シンボリックリンクは使いません）: ${path}` };
  if (plat !== 'win32' && (st.mode & 0o077) !== 0) return { ok: false, reason: `トークンのファイルの権限が広すぎます（自分だけが読める 600 にしてください: chmod 600 "${path}"）。` };
  if (st.size > 4096) return { ok: false, reason: 'トークンのファイルが大きすぎます。' };
  const token = readFileSync(path, 'utf8').trim();
  if (token.length < MIN_TOKEN) return { ok: false, reason: `トークンは ${MIN_TOKEN} 文字以上にしてください。` };
  if (!/^[\x21-\x7e]+$/.test(token)) return { ok: false, reason: 'トークンに、空白や読めない文字が入っています。' };
  return { ok: true, token };
}

export const newServiceToken = (): string => randomBytes(32).toString('hex');

/** 自分だけが読み書きできる権限でファイルを書く（一時ファイルに書いてから置き換える。途中で切れた半端なファイルを残さない）。 */
export function writePrivateFile(path: string, text: string, plat: NodeJS.Platform = process.platform): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  if (plat !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------------------------------------------
// 登録ファイルの中身

export interface Launch { node: string; script: string; cli: string; cwd: string; configFile: string }

/** エージェントを起動する引数（`node <tsx の cli> <run.ts> --config <agent.json>`）。 */
export function launchOf(repoRoot: string, nodeExe: string, configFile: string): Launch {
  return {
    node: nodeExe,
    cli: join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    script: join(repoRoot, 'src', 'server', 'node-agent', 'run.ts'),
    cwd: repoRoot,
    configFile,
  };
}
const argvOf = (l: Launch): string[] => [l.node, l.cli, l.script, '--config', l.configFile];

/** systemd の ExecStart の 1 語。`%` と `$` は、systemd が展開するので二重にする。 */
const sdWord = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
/** systemd の Environment= の 1 項目（`%` を二重にする）。 */
const sdEnv = (k: string, v: string): string => `Environment="${k}=${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
const hasNewline = (s: string): boolean => /[\r\n\0]/.test(s);

/** 改行・NUL を含む値は、ファイルの別の行を書き足せてしまうので、登録ファイルには入れない。 */
export function unsafeForUnit(values: string[]): string | null {
  return values.find(hasNewline) ?? null;
}

export function renderSystemdUnit(l: Launch, pathEnv: string | undefined): string {
  return [
    '[Unit]',
    'Description=IROME ノード構築エージェント（127.0.0.1 だけで待ち受け）',
    'Documentation=https://github.com/YUTOpian/IROME-Wallet/blob/main/docs/NODE.md',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${l.cwd.replace(/%/g, '%%')}`,
    ...(pathEnv ? [sdEnv('PATH', pathEnv)] : []),
    `ExecStart=${argvOf(l).map(sdWord).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function renderLaunchdPlist(l: Launch, pathEnv: string | undefined, logFile: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xml(LAUNCHD_LABEL)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...argvOf(l).map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
    `  <key>WorkingDirectory</key><string>${xml(l.cwd)}</string>`,
    ...(pathEnv ? ['  <key>EnvironmentVariables</key>', `  <dict><key>PATH</key><string>${xml(pathEnv)}</string></dict>`] : []),
    '  <key>RunAtLoad</key><true/>',
    // 正常終了（停止）のときは起こし直さない。異常終了なら、10 秒あけて起こし直す。
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>ThrottleInterval</key><integer>10</integer>',
    `  <key>StandardOutPath</key><string>${xml(logFile)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Windows のコマンドラインの 1 語（`"` は Windows のパスに使えないので、入っていたら呼ぶ前に断る）。 */
const winWord = (s: string): string => `"${s}"`;

export function renderTaskXml(l: Launch, user: string | null): string {
  const uid = user ? `<UserId>${xml(user)}</UserId>` : '';
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo><Description>IROME ノード構築エージェント（127.0.0.1 だけで待ち受け）</Description></RegistrationInfo>',
    `  <Triggers><LogonTrigger><Enabled>true</Enabled>${uid}</LogonTrigger></Triggers>`,
    `  <Principals><Principal id="Author">${uid}<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>',
    '    <Enabled>true</Enabled>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xml(l.node)}</Command>`,
    `      <Arguments>${xml([l.cli, l.script, '--config', l.configFile].map(winWord).join(' '))}</Arguments>`,
    `      <WorkingDirectory>${xml(l.cwd)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n');
}

/** schtasks に渡す XML は UTF-16 LE（BOM つき）で書く。 */
export const utf16le = (text: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

// ---------------------------------------------------------------------------------------------------------------
// 登録・解除・状態

export interface ExecResult { status: number | null; stdout: string; stderr: string }
export interface ServiceHost {
  plat: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  /** 実行しているユーザーの uid（Windows は null） */
  uid: number | null;
  /** 実行しているユーザー名（loginctl の確認用）。無ければ null */
  user: string | null;
  /** このリポジトリのフォルダ（node_modules と src の親） */
  repoRoot: string;
  nodeExe: string;
  exec: (cmd: string, args: string[]) => ExecResult;
  /** エージェントに繋がるか。ok: トークンが合って応答あり / unauthorized: 応答はあるがトークンが違う / down: 繋がらない */
  probe: (port: number, token: string | null) => Promise<'ok' | 'unauthorized' | 'down'>;
  out: (text: string) => void;
  exists?: (path: string) => boolean;
}

export interface Paths { dir: string; configFile: string; tokenFile: string; logFile: string; unit: string | null; plist: string | null; taskXml: string | null }
export function pathsOf(h: Pick<ServiceHost, 'plat' | 'home' | 'env'>): Paths {
  const dir = configDirOf(h.plat, h.env, h.home);
  const sd = h.env.XDG_CONFIG_HOME && h.env.XDG_CONFIG_HOME.startsWith('/') ? h.env.XDG_CONFIG_HOME : join(h.home, '.config');
  return {
    dir,
    configFile: join(dir, 'agent.json'),
    tokenFile: join(dir, 'agent-token'),
    logFile: join(dir, 'agent.log'),
    unit: h.plat === 'linux' ? join(sd, 'systemd', 'user', `${SERVICE_NAME}.service`) : null,
    plist: h.plat === 'darwin' ? join(h.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`) : null,
    taskXml: h.plat === 'win32' ? join(dir, 'task.xml') : null,
  };
}

export interface InstallOptions { port?: number; workspace?: string; origins?: string[] }
export type Outcome = { ok: true } | { ok: false; message: string };
const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });
const supported = (p: NodeJS.Platform): boolean => p === 'linux' || p === 'darwin' || p === 'win32';
const uidOf = (h: ServiceHost): string => String(h.uid ?? 0);
const readConfig = (p: Paths): AgentFileConfig | null => {
  try { const r = parseAgentConfig(readFileSync(p.configFile, 'utf8')); return r.ok ? r.config : null; } catch { return null; }
};
const readToken = (h: ServiceHost, p: Paths): string | null => {
  const t = readTokenFile(p.tokenFile, h.plat);
  return t.ok ? t.token : null;
};

/** 登録を、OS に反映して起動する。すでに登録されていれば、設定を上書きして起こし直す。 */
export function registerAndStart(h: ServiceHost, p: Paths): Outcome {
  const sh = (cmd: string, args: string[]) => h.exec(cmd, args);
  if (h.plat === 'linux') {
    if (sh('systemctl', ['--user', '--version']).status !== 0) return fail('systemd のユーザーサービスが使えません（`systemctl --user` が動きません）。systemd の無い環境では、`npm run node-agent` を tmux・screen などの中で動かしてください。');
    for (const args of [['daemon-reload'], ['enable', `${SERVICE_NAME}.service`], ['restart', `${SERVICE_NAME}.service`]]) {
      const r = sh('systemctl', ['--user', ...args]);
      if (r.status !== 0) return fail(`systemctl --user ${args.join(' ')} に失敗しました: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
    return { ok: true };
  }
  if (h.plat === 'darwin') {
    const target = `gui/${uidOf(h)}`;
    sh('launchctl', ['bootout', `${target}/${LAUNCHD_LABEL}`]); // 未登録なら失敗するが、構わない
    const r = sh('launchctl', ['bootstrap', target, p.plist as string]);
    if (r.status !== 0) return fail(`launchctl bootstrap に失敗しました: ${(r.stderr || r.stdout).trim().slice(0, 300)}（macOS にログインした状態で実行してください。ssh だけで入っていると、gui のドメインが無いことがあります）`);
    sh('launchctl', ['kickstart', '-k', `${target}/${LAUNCHD_LABEL}`]);
    return { ok: true };
  }
  const c = sh('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', p.taskXml as string, '/F']);
  if (c.status !== 0) return fail(`schtasks /Create に失敗しました: ${(c.stderr || c.stdout).trim().slice(0, 300)}`);
  sh('schtasks', ['/End', '/TN', TASK_NAME]); // 動いていれば止めて、新しい設定で起こし直す
  const r = sh('schtasks', ['/Run', '/TN', TASK_NAME]);
  if (r.status !== 0) return fail(`schtasks /Run に失敗しました: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return { ok: true };
}

export function isRegistered(h: ServiceHost, p: Paths): boolean {
  const ex = h.exists ?? existsSync;
  const file = p.unit ?? p.plist ?? null;
  if (h.plat === 'win32') return h.exec('schtasks', ['/Query', '/TN', TASK_NAME]).status === 0;
  return file !== null && ex(file);
}

export function installService(h: ServiceHost, opts: InstallOptions): Outcome {
  if (!supported(h.plat)) return fail(`この OS（${h.plat}）の常駐化には対応していません。`);
  if (h.uid === 0) return fail('root では登録しません（ウォレットからの操作が、そのまま root の権限になってしまうため）。一般ユーザーで実行してください。');
  if (opts.port !== undefined && !validPort(opts.port)) return fail('--port は 1024〜65535 の整数です。');
  for (const o of opts.origins ?? []) if (!validOrigin(o)) return fail(`--origin は https://example.com の形で指定してください: ${o.slice(0, 80)}`);
  const ex = h.exists ?? existsSync;
  const p = pathsOf(h);
  const l = launchOf(h.repoRoot, h.nodeExe, p.configFile);
  if (!ex(l.cli)) return fail('node_modules/tsx が見つかりません。先に、このフォルダで `npm ci` を実行してください。');
  if (!ex(l.script)) return fail('エージェントの本体（src/server/node-agent/run.ts）が見つかりません。このリポジトリのフォルダで実行してください。');
  const bad = unsafeForUnit([l.node, l.cli, l.script, l.cwd, p.configFile, p.logFile, h.env.PATH ?? '', opts.workspace ?? '']);
  if (bad !== null) return fail('パスに改行などの制御文字が入っているため、登録できません。');
  if (h.plat === 'win32' && [l.node, l.cli, l.script, l.cwd, p.configFile].some((s) => s.includes('"'))) return fail('パスに `"` が入っているため、登録できません。');

  // 設定（agent.json）。前に登録したときの値は、指定が無い項目だけ引き継ぐ（トークンのファイルは、あれば作り直さない）。
  const prev = readConfig(p) ?? {};
  const config: AgentFileConfig = {
    port: opts.port ?? prev.port ?? DEFAULT_PORT,
    ...(opts.workspace !== undefined ? { workspace: opts.workspace } : prev.workspace !== undefined ? { workspace: prev.workspace } : {}),
    ...((opts.origins ?? prev.origins) !== undefined ? { origins: opts.origins ?? prev.origins } : {}),
    tokenFile: p.tokenFile,
  };
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  if (!ex(p.tokenFile)) writePrivateFile(p.tokenFile, `${newServiceToken()}\n`, h.plat);
  else {
    const t = readTokenFile(p.tokenFile, h.plat);
    if (!t.ok) return fail(t.reason);
  }
  writePrivateFile(p.configFile, `${JSON.stringify(config, null, 2)}\n`, h.plat);

  if (h.plat === 'linux') {
    mkdirSync(join(p.unit as string, '..'), { recursive: true });
    writeFileSync(p.unit as string, renderSystemdUnit(l, h.env.PATH));
  } else if (h.plat === 'darwin') {
    mkdirSync(join(p.plist as string, '..'), { recursive: true });
    writeFileSync(p.plist as string, renderLaunchdPlist(l, h.env.PATH, p.logFile));
  } else {
    const user = h.env.USERDOMAIN && h.env.USERNAME ? `${h.env.USERDOMAIN}\\${h.env.USERNAME}` : null;
    writeFileSync(p.taskXml as string, utf16le(renderTaskXml(l, user)));
  }
  const r = registerAndStart(h, p);
  if (!r.ok) return r;

  h.out(`登録して、起動しました（${h.plat === 'linux' ? 'systemd のユーザーサービス' : h.plat === 'darwin' ? 'launchd' : 'タスク スケジューラ'}）。\n`);
  h.out(`  接続先 : http://127.0.0.1:${config.port}\n`);
  h.out(`  トークン: ${p.tokenFile} に入っています。表示するには: npm run node-agent-service -- token\n`);
  h.out('  ウォレットの「サービス > ノード」に、接続先とトークンを入れてください。トークンは、再起動しても変わりません。\n');
  if (h.plat === 'linux') {
    const lg = h.user ? h.exec('loginctl', ['show-user', h.user, '-p', 'Linger']) : null;
    if (lg !== null && /Linger=no/.test(lg.stdout)) {
      h.out('  注意: いまのままだと、ログアウトすると止まり、再起動後はログインするまで起動しません。ログインしなくても動かし続けるには、次を 1 回実行してください（管理者の権限が要ることがあります）:\n');
      h.out(`    loginctl enable-linger ${h.user}\n`);
    }
  }
  if (h.plat === 'win32') h.out('  注意: ログオンしたときに起動します。起動のコンソール画面が出ますが、閉じるとエージェントが止まります（最小化しておいてください）。\n');
  if (h.plat === 'darwin') h.out(`  ログ: ${p.logFile}\n`);
  return { ok: true };
}

export function uninstallService(h: ServiceHost, purge: boolean): Outcome {
  if (!supported(h.plat)) return fail(`この OS（${h.plat}）の常駐化には対応していません。`);
  const p = pathsOf(h);
  if (h.plat === 'linux') {
    h.exec('systemctl', ['--user', 'disable', '--now', `${SERVICE_NAME}.service`]);
    if (p.unit) rmSync(p.unit, { force: true });
    h.exec('systemctl', ['--user', 'daemon-reload']);
  } else if (h.plat === 'darwin') {
    h.exec('launchctl', ['bootout', `gui/${uidOf(h)}/${LAUNCHD_LABEL}`]);
    if (p.plist) rmSync(p.plist, { force: true });
  } else {
    h.exec('schtasks', ['/End', '/TN', TASK_NAME]);
    h.exec('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
  }
  if (purge) {
    for (const f of [p.configFile, p.tokenFile, p.logFile, ...(p.taskXml ? [p.taskXml] : [])]) rmSync(f, { force: true });
    h.out('登録を外し、設定とトークンも消しました。\n');
  } else {
    h.out('登録を外しました。設定とトークンは残しています（また登録すれば、同じトークンで使えます）。消すには、`uninstall --purge`。\n');
  }
  h.out('作業場所（ノードの設定・鍵・データ）には、触っていません。\n');
  return { ok: true };
}

export function restartService(h: ServiceHost): Outcome {
  if (!supported(h.plat)) return fail(`この OS（${h.plat}）の常駐化には対応していません。`);
  const p = pathsOf(h);
  if (!isRegistered(h, p)) return fail('登録されていません。先に `install` を実行してください。');
  return registerAndStart(h, p);
}

/** トークンを返す。rotate なら、作り直して（登録されていれば起こし直して）新しいものを返す。 */
export function tokenOf(h: ServiceHost, rotate: boolean): { ok: true; token: string; restarted: boolean } | { ok: false; message: string } {
  if (!supported(h.plat)) return fail(`この OS（${h.plat}）の常駐化には対応していません。`);
  const p = pathsOf(h);
  if (!rotate) {
    const t = readTokenFile(p.tokenFile, h.plat);
    return t.ok ? { ok: true, token: t.token, restarted: false } : fail(`${t.reason}\n先に \`install\` を実行してください。`);
  }
  const token = newServiceToken();
  writePrivateFile(p.tokenFile, `${token}\n`, h.plat);
  let restarted = false;
  if (isRegistered(h, p)) {
    const r = registerAndStart(h, p);
    if (!r.ok) return r;
    restarted = true;
  }
  return { ok: true, token, restarted };
}

export interface ServiceStatus { registered: boolean; detail: string; port: number; reachable: 'ok' | 'unauthorized' | 'down'; tokenFile: string; tokenOk: boolean; configOk: boolean }
export async function statusOf(h: ServiceHost): Promise<ServiceStatus> {
  const p = pathsOf(h);
  const registered = isRegistered(h, p);
  const cfg = readConfig(p);
  const port = cfg?.port ?? DEFAULT_PORT;
  let detail = '';
  if (registered) {
    if (h.plat === 'linux') {
      const a = h.exec('systemctl', ['--user', 'is-active', `${SERVICE_NAME}.service`]).stdout.trim();
      const e = h.exec('systemctl', ['--user', 'is-enabled', `${SERVICE_NAME}.service`]).stdout.trim();
      detail = `active: ${a || '?'} / enabled: ${e || '?'}`;
    } else if (h.plat === 'darwin') {
      const r = h.exec('launchctl', ['print', `gui/${uidOf(h)}/${LAUNCHD_LABEL}`]);
      detail = /state = (\w+)/.exec(r.stdout)?.[0] ?? (r.status === 0 ? '登録済み' : 'ロードされていません（再ログインか restart）');
    } else detail = 'タスクあり';
  }
  const token = readToken(h, p);
  return { registered, detail, port, reachable: await h.probe(port, token), tokenFile: p.tokenFile, tokenOk: token !== null, configOk: cfg !== null };
}
