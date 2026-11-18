// ノードの鍵の「公開鍵」だけを取り出す決まり（通信なし・依存なし。エージェントと画面の両方が使う）。
// symbol-bootstrap が作る target/addresses.yml には、ノードの main / transport / remote / vrf の各アカウントが、
// 公開鍵（publicKey）と秘密鍵（privateKey）の両方で入っている。ここでは `publicKey:` の行だけを読み、
// 秘密鍵の行は値を取り込まない（返す型にも、秘密鍵を入れる場所が無い）。
//
// symbol-bootstrap の用語と、Symbol のリンクの種類の対応:
//   transport → ノード鍵（NodeKeyLink）… ノードの通信用。`node` として返す
//   remote    → ハーベスト鍵（AccountKeyLink）… リモートハーベスト用
//   vrf       → VRF 鍵（VrfKeyLink）
//   voting    → 投票鍵（VotingKeyLink）… 32 バイトの公開鍵（64 文字。symbol-sdk の VotingPublicKey）。addresses.yml に入っているときと、
//               投票鍵の木のファイル（private_key_tree*.dat）の先頭ヘッダ（公開鍵と有効なエポックの範囲）から
//   main      → ノードの持ち主のアカウント（ウォレットのアカウントとは別物。リンクには使わない）

/** 投票鍵 1 つ。start / end は、分かるとき（鍵の木のファイルのヘッダ）だけ。無ければ、ウォレット側の画面で決める。 */
export interface VotingEntry { key: string; start: number | null; end: number | null }

export interface NodeKeySet {
  /** addresses.yml の `- name:`（無ければ空） */
  name: string;
  /** ノードの main アカウントの公開鍵（表示用。リンクには使わない） */
  main: string | null;
  /** transport の公開鍵 → ノード鍵 */
  node: string | null;
  /** remote の公開鍵 → ハーベスト鍵 */
  remote: string | null;
  vrf: string | null;
  /** 投票鍵の公開鍵（64 文字）。addresses.yml か鍵の木のファイルに無ければ null。複数あるときは、votings の先頭と同じ */
  voting: string | null;
  /** 見つかった投票鍵（期間が新しい順）。同じ鍵と期間の重複は 1 つにする */
  votings: VotingEntry[];
}

export const isHex64 = (s: string): boolean => /^[0-9a-fA-F]{64}$/.test(s);
export const isEpoch = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 0xffffffff;

/** 投票鍵の木のファイルの、ヘッダの大きさ（先頭 80 バイトだけを読む。その先には、エポックごとの子の秘密鍵が続く。読まない）。 */
export const VOTING_TREE_HEADER = 80;
/**
 * 投票鍵の木のファイル（private_key_tree*.dat）の先頭 80 バイトから、ルートの投票公開鍵と、有効なエポックの範囲を取り出す。
 * ヘッダ: 0..8 開始エポック（リトルエンディアン）/ 8..16 終了エポック / 16..32 予約 / 32..64 ルートの投票公開鍵 / 64..80 木の段の範囲
 * （symbol-sdk の VotingKeysGenerator と同じ並び）。形が合わないもの（エポックの範囲・全ゼロの鍵）は null。
 */
export function parseVotingTreeHeader(head: Uint8Array): VotingEntry | null {
  if (head.length < VOTING_TREE_HEADER) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const start = view.getBigUint64(0, true);
  const end = view.getBigUint64(8, true);
  if (start < 1n || end < start || end > 0xffffffffn) return null;
  const key = head.subarray(32, 64);
  if (key.every((b) => b === 0)) return null;
  return { key: Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase(), start: Number(start), end: Number(end) };
}

/** voting（先頭）と votings を、重複なしで揃える。 */
export function withVotings(set: Omit<NodeKeySet, 'votings'> & { votings?: VotingEntry[] }, extra: VotingEntry[]): NodeKeySet {
  const seen = new Set<string>();
  const all: VotingEntry[] = [];
  for (const v of [...(set.votings ?? []), ...(set.voting ? [{ key: set.voting, start: null, end: null }] : []), ...extra]) {
    const id = `${v.key}:${v.start ?? ''}:${v.end ?? ''}`;
    if (!seen.has(id)) { seen.add(id); all.push(v); }
  }
  // 同じ鍵で、期間の分かるものがあるときは、期間の無い（addresses.yml 由来の）ものは重ねない
  const merged = all.filter((v) => v.start !== null || !all.some((o) => o.key === v.key && o.start !== null));
  merged.sort((a, b) => (b.end ?? 0) - (a.end ?? 0));
  return { ...set, votings: merged.slice(0, 16), voting: merged[0]?.key ?? null };
}

const SECTION_TO_FIELD = { main: 'main', transport: 'node', remote: 'remote', vrf: 'vrf', voting: 'voting' } as const;
type Section = keyof typeof SECTION_TO_FIELD;
const isSection = (s: string): s is Section => Object.prototype.hasOwnProperty.call(SECTION_TO_FIELD, s);

const emptySet = (name: string): NodeKeySet => ({ name, main: null, node: null, remote: null, vrf: null, voting: null, votings: [] });

const unquote = (v: string): string => v.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * addresses.yml の文章から、ノードごとの公開鍵を取り出す。
 * 「`nodes:` の中の、`- name:` で始まる各ノードの、main / transport / remote / vrf / voting の `publicKey:`」だけを読む。
 * 長さが合わない値（どれも 64 文字の 16 進数でないもの）は捨てる。見つからなければ空の配列。
 */
export function parseAddressesYml(text: string): NodeKeySet[] {
  const out: NodeKeySet[] = [];
  let inNodes = false;
  let current: NodeKeySet | null = null;
  let section: Section | null = null;
  let sectionIndent = -1;
  let itemIndent = -1; // 最初のノードの `-` の字下げ。同じか浅い字下げの `-` が、次のノード

  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const indent = indentOf(raw);
    const line = raw.trim();

    // 一番外側のキー（nodes: など）
    if (indent === 0 && !line.startsWith('-')) {
      inNodes = /^nodes\s*:/.test(line);
      current = null;
      section = null;
      continue;
    }
    if (!inNodes) continue;

    // 新しいノード（`- name: xxx`、または名前の無い `-`）
    const item = /^-\s*(?:name\s*:\s*(.*))?$/.exec(line);
    if (item && (current === null || indent <= itemIndent)) {
      current = emptySet(item[1] === undefined ? '' : unquote(item[1]));
      if (itemIndent < 0) itemIndent = indent;
      out.push(current);
      section = null;
      continue;
    }
    if (current === null) continue;

    // `name:` がハイフンの次の行にあるとき
    const nameLine = /^name\s*:\s*(.*)$/.exec(line);
    if (nameLine && section === null) { current.name = unquote(nameLine[1]); continue; }

    // 節の見出し（`main:` `transport:` `remote:` `vrf:` `voting:`）
    const head = /^([A-Za-z_]+)\s*:\s*$/.exec(line);
    if (head) {
      if (isSection(head[1])) { section = head[1]; sectionIndent = indent; } else { section = null; }
      continue;
    }
    // 節の外へ出た（同じか浅いインデントの別のキー）
    if (section !== null && indent <= sectionIndent) section = null;
    if (section === null) continue;

    const pub = /^publicKey\s*:\s*(.*)$/.exec(line);
    if (!pub) continue; // privateKey などの行は、値を読まない
    const value = unquote(pub[1].replace(/\s+#.*$/, ''));
    if (isHex64(value)) current[SECTION_TO_FIELD[section]] = value.toUpperCase();
  }
  return out.map((k) => withVotings(k, []));
}

/** エージェントの返事が、この形か（画面は、受け取ったものを信用せず、もう一度形と長さを確かめる）。 */
export type NodeKeysEntry = NodeKeySet & { source: string };
export function sanitizeNodeKeySets(value: unknown): NodeKeysEntry[] {
  if (!Array.isArray(value)) return [];
  const pick = (v: unknown, ok: (s: string) => boolean): string | null => (typeof v === 'string' && ok(v) ? v.toUpperCase() : null);
  const out: NodeKeysEntry[] = [];
  for (const item of value.slice(0, 50)) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const entry = {
      name: typeof o.name === 'string' ? o.name.slice(0, 100) : '',
      source: typeof o.source === 'string' ? o.source.slice(0, 200) : '',
      main: pick(o.main, isHex64),
      node: pick(o.node, isHex64),
      remote: pick(o.remote, isHex64),
      vrf: pick(o.vrf, isHex64),
      voting: pick(o.voting, isHex64),
      votings: [],
    };
    const raw = Array.isArray(o.votings) ? o.votings.slice(0, 16) : [];
    const votings: VotingEntry[] = [];
    for (const v of raw) {
      if (typeof v !== 'object' || v === null) continue;
      const r = v as Record<string, unknown>;
      const key = pick(r.key, isHex64);
      if (key === null) continue;
      const ranged = isEpoch(r.start) && isEpoch(r.end) && r.end >= r.start;
      votings.push({ key, start: ranged ? (r.start as number) : null, end: ranged ? (r.end as number) : null });
    }
    out.push({ ...withVotings(entry, votings), source: entry.source });
  }
  return out;
}
