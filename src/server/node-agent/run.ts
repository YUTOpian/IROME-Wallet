// ノード構築エージェントの起動（サーバー専用）。ウォレットの「ノード」画面から、許可されたコマンドを実行する橋。
//
//   npm run node-agent
//
// 起動すると、接続先の URL と、この起動だけで有効なトークンを表示する。ウォレットの「サービス > ノード」に貼り付けて繋ぐ。
// ブラウザのウォレット（src/）はこのファイルを読み込まない（ビルドにも入らない）。
//
// 環境変数:
//   IROME_NODE_AGENT_PORT=7391          待ち受けるポート（127.0.0.1 だけで待ち受ける）
//   IROME_NODE_AGENT_WORKSPACE=~/irome-node   作業フォルダ（ツールの導入先 tools/ と、コマンドの実行場所）
//   IROME_NODE_AGENT_ORIGINS=https://example.com,…   許可する Origin を足す（既定: file:// と https://yutopian.github.io。localhost の http は常に許可）
//   IROME_NODE_AGENT_TOKEN=…            トークンを固定する（省略すると、起動のたびにランダム。固定すると、画面に貼り直さなくて済むが、漏れたときの影響が長く残る）
//   IROME_NODE_AGENT_ALLOW_ROOT=1       root での起動を許す（非推奨）
//   IROME_NODE_AGENT_PTY=0              本物の端末（pty）を使わない（省略は自動。Linux / macOS で python3 の pty が使えるときだけ使う）
//   IROME_NODE_AGENT_TOKEN_FILE=…       トークンをファイルから読む（Linux / macOS は、自分だけが読める 600 のとき。1 行目から。32 文字以上）
//
// 引数:
//   --config <agent.json>               設定ファイルから、port / workspace / origins / tokenFile を読む（環境変数があれば、そちらが優先）。
//                                       常駐化（npm run node-agent-service -- install）が作るもの。
import { homedir } from 'node:os';
import { isElevatedWindows } from './platform';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createAgent, newToken } from './agent';
import { withLegacyEnv } from '../legacyEnv';
import { parseAgentConfig, readTokenFile } from './service';
import type { AgentFileConfig } from './service';

// 改名前の KASANE_NODE_AGENT_* も、当面は読む。
const env = withLegacyEnv(process.env);
const die = (msg: string): never => { console.error(`[node-agent] ${msg}`); process.exit(1); };

// 設定ファイル（--config）。環境変数が無い項目だけ、ここから取る。
const argv = process.argv.slice(2);
let fileConfig: AgentFileConfig = {};
if (argv.length > 0) {
  if (argv[0] !== '--config' || argv.length !== 2 || argv[1].startsWith('--')) die('引数は --config <設定ファイル> だけです。');
  try {
    const r = parseAgentConfig(readFileSync(argv[1], 'utf8'));
    if (!r.ok) die(`${argv[1]}: ${r.reason}`);
    else fileConfig = r.config;
  } catch (e) { die(`設定ファイルを読めません: ${(e as NodeJS.ErrnoException).code ?? 'error'}`); }
}

const port = Number(env.IROME_NODE_AGENT_PORT ?? fileConfig.port ?? '7391');
if (!Number.isInteger(port) || port < 1024 || port > 65535) die('IROME_NODE_AGENT_PORT は 1024〜65535 の整数です。');
if (process.platform === 'win32' && env.IROME_NODE_AGENT_ALLOW_ROOT !== '1' && isElevatedWindows()) {
  die('管理者として実行されています。ウォレットからの操作が、そのまま管理者の権限になってしまうため、起動しません。管理者ではない、普通のターミナル（PowerShell など）で起動してください。');
}
if (process.getuid?.() === 0 && env.IROME_NODE_AGENT_ALLOW_ROOT !== '1') {
  die('root では起動しません（ウォレットからの操作が、そのまま root の権限になってしまうため）。一般ユーザーで起動してください（Docker は、そのユーザーを docker グループに入れて使います）。');
}
// 既定の作業場所は ~/irome-node。改名前の ~/kasane-node がすでにあって、~/irome-node がないときは、そちらを使い続ける（入れたツールが見えなくならないように）。
const legacyHome = join(homedir(), 'kasane-node');
const defaultWorkspace = existsSync(legacyHome) && !existsSync(join(homedir(), 'irome-node')) ? legacyHome : join(homedir(), 'irome-node');
const workspace = (env.IROME_NODE_AGENT_WORKSPACE ?? fileConfig.workspace ?? defaultWorkspace).replace(/^~(?=$|[\\/])/, homedir());
mkdirSync(workspace, { recursive: true });

const fixed = env.IROME_NODE_AGENT_TOKEN?.trim();
if (fixed && fixed.length < 32) die('IROME_NODE_AGENT_TOKEN は 32 文字以上にしてください。');
// トークン: 環境変数 > トークンのファイル > 起動のたびのランダム。ファイルから読んだトークンは、画面にもログにも出さない。
const tokenFile = (env.IROME_NODE_AGENT_TOKEN_FILE ?? fileConfig.tokenFile)?.trim();
let fromFile = false;
let token = fixed || '';
if (!fixed && tokenFile) {
  const t = readTokenFile(tokenFile.replace(/^~(?=$|[\\/])/, homedir()));
  if (!t.ok) die(t.reason);
  else { token = t.token; fromFile = true; }
}
if (!token) token = newToken();
const extra = [...(fileConfig.origins ?? []), ...(env.IROME_NODE_AGENT_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
const origins = ['null', 'https://yutopian.github.io', ...extra];

const agent = createAgent({ token, workspace, origins, ...(env.IROME_NODE_AGENT_PTY === '0' ? { pty: false } : {}) });
agent.server.listen(port, '127.0.0.1', () => {
  console.log('IROME ノード構築エージェント');
  console.log(`  接続先 : http://127.0.0.1:${port}`);
  console.log(fromFile ? '  トークン: ファイルから読みました（ここには出しません。`npm run node-agent-service -- token` で表示）' : `  トークン: ${token}${fixed ? '（固定）' : '（この起動だけ有効）'}`);
  console.log(`  作業場所: ${workspace}`);
  console.log('  ウォレットの「サービス > ノード」に、接続先とトークンを入れてください。止めるときは Ctrl+C。');
  if (process.platform === 'win32') console.log('  ※ Windows ネイティブで動いています。パスワードを聞くコマンドと wizard は、本物の端末が要るため使えません（symbol-bootstrap は --noPassword で）。');
});
agent.server.on('error', (e: NodeJS.ErrnoException) => die(e.code === 'EADDRINUSE' ? `ポート ${port} は使用中です（別のエージェントが動いていませんか）。` : e.message));
const stop = () => { void agent.close().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
