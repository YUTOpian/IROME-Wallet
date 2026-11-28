// 作業場所の中から、compose ファイルのあるフォルダを探す（読むだけ）。再起動の作業フォルダの候補として、画面に出す。
// 見るのは名前だけで、ファイルの中身は開かない。tools/・node_modules・「.」で始まるフォルダ・シンボリックリンクは見ない。深さは 4 まで。
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const COMPOSE_NAMES = new Set(['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']);
const SKIP_DIRS = new Set(['tools', 'node_modules']);
const MAX_DEPTH = 4;
const MAX_DIRS = 20;
const MAX_ENTRIES = 5000;

/** 作業場所からの相対パス（'/' 区切り。直下は ''）の一覧。浅いものが先。 */
export function findComposeDirs(ws: string): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (abs: string, rel: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(abs); } catch { return; }
    if (names.some((n) => COMPOSE_NAMES.has(n))) {
      // 名前が合っても、普通のファイルのときだけ（リンク・フォルダは数えない）
      const hit = names.some((n) => COMPOSE_NAMES.has(n) && (() => { try { return lstatSync(join(abs, n)).isFile(); } catch { return false; } })());
      if (hit) found.push(rel);
    }
    if (depth >= MAX_DEPTH) return;
    for (const n of names.sort()) {
      if (found.length >= MAX_DIRS || ++seen > MAX_ENTRIES) return;
      if (n.startsWith('.') || SKIP_DIRS.has(n)) continue;
      const child = join(abs, n);
      try { if (!lstatSync(child).isDirectory()) continue; } catch { continue; }
      walk(child, rel === '' ? n : `${rel}/${n}`, depth + 1);
    }
  };
  walk(ws, '', 0);
  return found.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, MAX_DIRS);
}
