// 投票鍵の木のファイル（private_key_tree*.dat）の「先頭ヘッダ」だけを読んで、投票公開鍵と有効なエポックの範囲を取り出す（symbol-bootstrap・Shoestring 共通）。
// ファイルの先頭 80 バイトより先には、エポックごとの子の秘密鍵が続く。それは読まない（読む量を 80 バイトに固定する）ので、確認なしで使える。
// シンボリックリンクは辿らない。tools/ と node_modules の中、`.` で始まるものは見ない。
import { closeSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { VOTING_TREE_HEADER, parseVotingTreeHeader } from '../../lib/node/nodeKeys';
import type { VotingEntry } from '../../lib/node/nodeKeys';

const TREE_NAME = /^private_key_tree\d*\.dat$/i;
/** ヘッダ 80 バイト + 子の鍵 1 つ（96 バイト）に満たないものは、木のファイルではない。 */
const MIN_SIZE = VOTING_TREE_HEADER + 96;

export interface VotingTree { /** 作業場所からの相対パス（ファイルのあるフォルダ） */ dir: string; entry: VotingEntry }

export function readHeader(full: string): VotingEntry | null {
  let fd: number | null = null;
  try {
    const st = lstatSync(full);
    if (!st.isFile() || st.isSymbolicLink() || st.size < MIN_SIZE) return null;
    fd = openSync(full, 'r');
    const buf = Buffer.alloc(VOTING_TREE_HEADER);
    if (readSync(fd, buf, 0, VOTING_TREE_HEADER, 0) !== VOTING_TREE_HEADER) return null;
    return parseVotingTreeHeader(buf);
  } catch { return null; } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* 閉じられないものは、そのまま */ } }
  }
}

export function readVotingTrees(ws: string): VotingTree[] {
  const out: VotingTree[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 8 || out.length >= 50) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (r !== 'tools') walk(join(dir, e.name), r, depth + 1); continue; }
      if (!e.isFile() || !TREE_NAME.test(e.name) || out.length >= 50) continue;
      const entry = readHeader(join(dir, e.name));
      if (entry) out.push({ dir: rel, entry });
    }
  };
  walk(ws, '', 0);
  return out;
}

/** フォルダ（作業場所からの相対）の中の名前を、パスの区切りで分けたもの。 */
const parts = (p: string) => p.split('/').filter(Boolean);

/**
 * 見つけた投票鍵の木を、ノードの一覧（existing）に足す。どのノードのものかは、次の順で決める。
 *  1. 木のファイルの場所に `nodes/<名前>/` が含まれ（symbol-bootstrap の target/nodes/<名前>/…）、その名前のノードがあるとき。
 *  2. 鍵のあるフォルダ（証明書のある cert/ の 1 つ上など）が、既存のノードのファイルと同じとき（Shoestring）。
 *  3. どれでもなければ、投票鍵だけのノードとして足す（名前はフォルダ名）。
 * source は、そのノードの元のファイルのまま（木のファイルは、source に書かない）。
 */
export function attachVotingTrees<T extends { name: string; source: string; votings: VotingEntry[] }>(existing: T[], trees: VotingTree[], blank: (name: string, source: string) => T): T[] {
  const nodes = existing.map((e) => ({ ...e, votings: [...e.votings] }));
  const folderOf = (source: string) => {
    const i = source.lastIndexOf('/');
    return i < 0 ? '' : source.slice(0, i).replace(/(^|\/)(cert|keys|userconfig\/resources|userconfig|resources|votingkeys)$/i, '');
  };
  const created = new Map<string, T>();
  for (const tree of trees) {
    const p = parts(tree.dir);
    const ni = p.lastIndexOf('nodes');
    const nodeName = ni >= 0 ? p[ni + 1] : undefined;
    const treeFolder = p.join('/').replace(/(^|\/)(votingkeys|keys|userconfig\/resources|userconfig|resources)$/i, '');
    let target: T | undefined = nodeName !== undefined ? nodes.find((n) => n.name === nodeName && /(^|\/)addresses\.ya?ml$/i.test(n.source)) : undefined;
    target ??= nodes.find((n) => folderOf(n.source) === treeFolder && folderOf(n.source) !== '' && !/(^|\/)addresses\.ya?ml$/i.test(n.source));
    if (!target) {
      const key = nodeName ?? treeFolder;
      target = created.get(key);
      if (!target) {
        target = blank((nodeName ?? p[p.length - 1] ?? '').slice(0, 100), tree.dir || '');
        created.set(key, target);
        nodes.push(target);
      }
    }
    target.votings.push(tree.entry);
  }
  return nodes;
}
