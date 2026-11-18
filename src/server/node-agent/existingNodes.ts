// 作業場所の中から、すでにあるノードのフォルダ（symbol-bootstrap 製・Shoestring 製）を探す（読むだけ）。
// 見るのは**ファイル・フォルダの名前だけ**で、中身は開かない（鍵・設定の中身は読まない）。tools/・node_modules・「.」で始まるフォルダ・シンボリックリンクは見ない。深さは 4 まで。
//
// - symbol-bootstrap 製: そのフォルダの `target/docker/` に compose ファイルがある。`symbol-bootstrap` のコマンドは、`target/` のあるフォルダで動かす。
// - Shoestring 製: そのフォルダに compose ファイルがあり、`userconfig/`・`cert/`・`keys/`・`config.ini`・`overrides.ini` のどれかもある。
//   （Shoestring の置き場所は、公式ドキュメントの構成に基づく見分け方で、実物では確かめていない。見つからないときは、画面の「作業フォルダ」に直接入れる。）
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ExistingNode } from '../../lib/node/existingNodes';

const COMPOSE_NAMES = new Set(['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']);
const SHOESTRING_DIRS = new Set(['userconfig', 'cert', 'keys']);
const SHOESTRING_FILES = new Set(['config.ini', 'overrides.ini']);
const SKIP_DIRS = new Set(['tools', 'node_modules']);
const MAX_DEPTH = 4;
const MAX_NODES = 20;
const MAX_ENTRIES = 5000;

const kindOf = (p: string): 'file' | 'dir' | 'other' => {
  try { const s = lstatSync(p); return s.isSymbolicLink() ? 'other' : s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other'; } catch { return 'other'; }
};
const hasCompose = (abs: string): boolean => {
  let names: string[];
  try { names = readdirSync(abs); } catch { return false; }
  return names.some((n) => COMPOSE_NAMES.has(n) && kindOf(join(abs, n)) === 'file');
};

/** 作業場所からの相対パス（'/' 区切り。直下は ''）で、見つけたノードを返す。浅いものが先。 */
export function findExistingNodes(ws: string): ExistingNode[] {
  const found: ExistingNode[] = [];
  let seen = 0;
  const walk = (abs: string, rel: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(abs); } catch { return; }
    let skipTarget = false;
    if (names.includes('target') && kindOf(join(abs, 'target')) === 'dir' && kindOf(join(abs, 'target', 'docker')) === 'dir' && hasCompose(join(abs, 'target', 'docker'))) {
      found.push({ kind: 'bootstrap', dir: rel, composeDir: rel === '' ? 'target/docker' : `${rel}/target/docker` });
      skipTarget = true; // target/docker を、別のノードとして数えない
    } else if (hasCompose(abs) && names.some((n) => (SHOESTRING_DIRS.has(n) && kindOf(join(abs, n)) === 'dir') || (SHOESTRING_FILES.has(n) && kindOf(join(abs, n)) === 'file'))) {
      found.push({ kind: 'shoestring', dir: rel, composeDir: rel });
    }
    if (depth >= MAX_DEPTH) return;
    for (const n of names.sort()) {
      if (found.length >= MAX_NODES || ++seen > MAX_ENTRIES) return;
      if (n.startsWith('.') || SKIP_DIRS.has(n) || (skipTarget && n === 'target')) continue;
      if (kindOf(join(abs, n)) !== 'dir') continue;
      walk(join(abs, n), rel === '' ? n : `${rel}/${n}`, depth + 1);
    }
  };
  walk(ws, '', 0);
  return found.sort((a, b) => a.dir.split('/').length - b.dir.split('/').length || a.dir.localeCompare(b.dir)).slice(0, MAX_NODES);
}
