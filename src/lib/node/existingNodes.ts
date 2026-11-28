// 既に動いているノード（symbol-bootstrap 製・Shoestring 製）を、この画面で操るための、画面に依らない部品。
// エージェント（src/server/node-agent/existingNodes.ts）が、作業場所の中から「ノードのフォルダ」を名前だけで見つけて返す。
// ここでは、受け取ったものの形を確かめる・よく使うコマンドを決める・既存のノードで打つと危ないコマンドを見分ける。
import { validateSubdir } from './nodeCommands';

export type ExistingKind = 'bootstrap' | 'shoestring';
export interface ExistingNode {
  kind: ExistingKind;
  /** ノードのフォルダ（作業場所からの相対。'/' 区切り。直下は ''）。symbol-bootstrap のコマンドは、ここで動かす（target/ の置き場所）。 */
  dir: string;
  /** `docker compose` を動かすフォルダ（bootstrap は <dir>/target/docker、Shoestring は <dir>）。 */
  composeDir: string;
}

const MAX_NODES = 20;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** エージェントから届いたものを信用せず、形・パスをもう一度確かめる（定義に無い項目は落ちる）。 */
export function sanitizeExistingNodes(raw: unknown): ExistingNode[] {
  if (!Array.isArray(raw)) return [];
  const out: ExistingNode[] = [];
  for (const x of raw) {
    if (!isRec(x) || (x.kind !== 'bootstrap' && x.kind !== 'shoestring')) continue;
    if (typeof x.dir !== 'string' || typeof x.composeDir !== 'string') continue;
    const d = validateSubdir(x.dir);
    const c = validateSubdir(x.composeDir);
    if (!d.ok || !c.ok) continue;
    out.push({ kind: x.kind, dir: d.value, composeDir: c.value });
    if (out.length >= MAX_NODES) break;
  }
  return out;
}

export interface ExistingPreset { line: string; /** この行を動かすフォルダ（作業場所からの相対） */ cwd: string }

/** 既存のノードで、ふだん使うコマンド（確認・ログ・再起動。ノードの設定やデータを作り直さないものだけ）。 */
export function existingPresets(n: ExistingNode): ExistingPreset[] {
  const compose = (line: string): ExistingPreset => ({ line, cwd: n.composeDir });
  const common = [compose('docker compose ps -a'), compose('docker compose logs --tail=50'), compose('docker compose restart')];
  if (n.kind === 'bootstrap') {
    return [...common, { line: 'symbol-bootstrap healthCheck', cwd: n.dir }, { line: 'symbol-bootstrap --version', cwd: n.dir }];
  }
  return [...common, { line: 'shoestring health --config config.ini --directory .', cwd: n.dir }, { line: 'shoestring --help', cwd: n.dir }];
}

const within = (cwd: string, d: string): boolean => (d === '' ? cwd === '' : cwd === d || cwd.startsWith(`${d}/`));

/** 作業フォルダ cwd が、見つかった既存のノードのフォルダ（またはその docker compose のフォルダ）の中なら、そのノード。 */
export function nodeAt(cwd: string, nodes: readonly ExistingNode[]): ExistingNode | null {
  const c = validateSubdir(cwd);
  if (!c.ok) return null;
  return nodes.find((n) => within(c.value, n.dir) || within(c.value, n.composeDir)) ?? null;
}

// 既存のノードで打つと、設定・鍵・データを作り直したり、消したりするもの。symbol-bootstrap は、config / start が設定を作り直し、
// clean / resetData がデータを消し、encrypt / decrypt が鍵ファイルを書き換える。Shoestring は、init / setup が設定を作り直し、
// reset-data がデータを消し、import-bootstrap / import-harvesters が鍵を取り込む（renew-* / upgrade は、ふだんの保守なので対象にしない）。
const RISKY: Record<'symbol-bootstrap' | 'shoestring', ReadonlySet<string>> = {
  'symbol-bootstrap': new Set(['config', 'start', 'clean', 'resetData', 'encrypt', 'decrypt']),
  shoestring: new Set(['init', 'setup', 'reset-data', 'import-bootstrap', 'import-harvesters']),
};

/** 既存のノードのフォルダで、作り直す・消すおそれのあるコマンドか。そうなら、そのノードと、コマンド名（確認の画面に出す）。 */
export function riskOnExisting(argv: readonly string[], cwd: string, nodes: readonly ExistingNode[]): { node: ExistingNode; command: string } | null {
  const tool = argv[0];
  if ((tool !== 'symbol-bootstrap' && tool !== 'shoestring') || typeof argv[1] !== 'string' || !RISKY[tool].has(argv[1])) return null;
  const node = nodeAt(cwd, nodes);
  return node ? { node, command: `${tool} ${argv[1]}` } : null;
}
