// ノード構築エージェント（src/server/node-agent/）への、ブラウザ側の接続。
// 接続先はこの PC 自身（127.0.0.1 / localhost）だけ。トークンは画面を閉じる・再読み込みすると消える（保存しない）。
import { isLoopbackAgentUrl } from './nodeCommands';

export interface AgentConn { url: string; token: string }
/** local: 作業場所の tools/ に「入れる」で入れたもの（画面から削除できる）。symbol-bootstrap / shoestring / symbol-node-watcher だけが持つ。 */
export interface ToolState { found: boolean; version: string | null; local?: boolean }
export interface AgentStatus {
  agent: number;
  platform: string;
  arch: string;
  workspace: string;
  tools: Record<'docker' | 'node' | 'npm' | 'python' | 'symbol-bootstrap' | 'shoestring' | 'symbol-node-watcher', ToolState>;
  running: number;
  /** 本物の端末（pty）で動かせる（パスワードを聞くコマンドが使える）。古いエージェントには無い。 */
  pty?: boolean;
}
export interface ContainerInfo { name: string; image: string; state: string; status: string }
export interface ContainersResult { available: boolean; containers: ContainerInfo[] }
export interface JobChunk { text: string; next: number; truncated: boolean; done: boolean; exitCode: number | null }

export type AgentErrorKind = 'bad_url' | 'unreachable' | 'unauthorized' | 'rejected' | 'busy' | 'gone' | 'other';
export class AgentError extends Error {
  // erasableSyntaxOnly のため、コンストラクタの引数プロパティ（public kind）は使わず、フィールドを明示する。
  kind: AgentErrorKind;
  reason?: string;
  constructor(kind: AgentErrorKind, reason?: string) {
    super(reason ? `${kind}:${reason}` : kind);
    this.kind = kind;
    this.reason = reason;
  }
}

export const DEFAULT_AGENT_URL = 'http://127.0.0.1:7391';

// 同じタブの中で、別の画面に移って戻っても繋ぎ直さなくて済むように、メモリにだけ持つ。
let remembered: AgentConn | null = null;
export const rememberConn = (c: AgentConn | null) => { remembered = c; };
export const rememberedConn = () => remembered;

async function call<T>(c: AgentConn, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  if (!isLoopbackAgentUrl(c.url)) throw new AgentError('bad_url');
  let res: Response;
  try {
    res = await fetch(`${c.url.replace(/\/+$/, '')}${path}`, {
      method: init?.method ?? 'GET',
      headers: { Authorization: `Bearer ${c.token.trim()}`, ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AgentError('unreachable');
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
  if (res.ok) return body as T;
  if (res.status === 401) throw new AgentError('unauthorized');
  if (res.status === 429) throw new AgentError('busy');
  if (res.status === 404 && body.error === 'no_such_job') throw new AgentError('gone');
  if (res.status === 404 && body.error === 'file_not_found') throw new AgentError('rejected', 'not_found');
  if (res.status === 400 && (body.error === 'command_rejected' || body.error === 'path_rejected')) throw new AgentError('rejected', body.reason);
  throw new AgentError('other', body.error);
}

export const fetchStatus = (c: AgentConn) => call<AgentStatus>(c, '/v1/status');
export const fetchContainers = (c: AgentConn) => call<ContainersResult>(c, '/v1/containers');
/** wizard: 画面で wizard を有効にしている（true のときだけ、エージェントは `symbol-bootstrap wizard` を通す）。emulate: 出力を生のまま返してほしい（画面の簡易ターミナルで描く）。 */
export interface StartJobOptions { wizard?: boolean; emulate?: boolean }
/** raw: 出力が生（エスケープ列つき）で届く。古いエージェントや、端末（pty）が使えないときは付かない（その場合は、これまでどおり整形済みの出力）。 */
export const startJob = (c: AgentConn, line: string, cwd: string, opts: StartJobOptions = {}) =>
  call<{ id: string; raw?: boolean }>(c, '/v1/jobs', { method: 'POST', body: { line, cwd, ...(opts.wizard === true ? { wizard: true } : {}), ...(opts.emulate === true ? { emulate: true } : {}) } });
export const readJob = (c: AgentConn, id: string, from: number) => call<JobChunk>(c, `/v1/jobs/${id}/output?from=${from}`);
export const sendStdin = (c: AgentConn, id: string, text: string) => call<{ ok: true }>(c, `/v1/jobs/${id}/stdin`, { method: 'POST', body: { text } });
export type TtyKey = 'up' | 'down' | 'left' | 'right' | 'enter' | 'space' | 'tab';
/** 端末（pty）で動いているコマンドに、キーを送る（対話式の選択画面用）。pty でないジョブには 'other:no_pty' で断られる。 */
export const sendKey = (c: AgentConn, id: string, key: TtyKey) => call<{ ok: true }>(c, `/v1/jobs/${id}/stdin`, { method: 'POST', body: { key } });
export const stopJob = (c: AgentConn, id: string) => call<{ ok: true }>(c, `/v1/jobs/${id}/stop`, { method: 'POST', body: {} });

export const listFiles = (c: AgentConn) => call<{ files: Array<{ path: string; size: number }> }>(c, '/v1/files');
export const readFile = (c: AgentConn, path: string) => call<{ content: string }>(c, `/v1/file?path=${encodeURIComponent(path)}`);
export const writeFile = (c: AgentConn, path: string, content: string) => call<{ ok: true }>(c, '/v1/file', { method: 'PUT', body: { path, content } });
