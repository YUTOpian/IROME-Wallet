// 証明書から、ノードの公開鍵を取り出す（Shoestring の作業場所には addresses.yml が無いため）。
// Symbol のノードの証明書は、ノード鍵（NodeKeyLink の鍵）の Ed25519 公開鍵を持つ（node.crt.pem）。CA の証明書（ca.crt.pem / ca.cert.pem）は、
// ノードの main アカウントの公開鍵を持つ。どちらも「証明書」（公開のもの）から読むだけで、秘密鍵のファイル（*.key.pem）は開かない。
// ハーベスト鍵（remote）・VRF 鍵・投票鍵の公開鍵は、証明書に入っていないので、ここでは返さない。
// シンボリックリンクは辿らない。tools/ と node_modules の中、`.` で始まるものは見ない。
import { X509Certificate } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeKeySet } from '../../lib/node/nodeKeys';

const BLOCK = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/;
const NODE_CERT = /^node(\.full)?\.crt\.pem$/i;
const CA_CERT = /^ca\.(crt|cert)\.pem$/i;
const MAX = 64 * 1024;

/** 証明書（最初のブロックだけ）の Ed25519 公開鍵（64 文字の大文字 16 進数）。Ed25519 でない・壊れているときは null。 */
export function ed25519KeyOfCert(pem: string): string | null {
  const block = BLOCK.exec(pem);
  if (!block) return null;
  try {
    const key = new X509Certificate(block[0]).publicKey;
    if (key.asymmetricKeyType !== 'ed25519') return null;
    const der = key.export({ type: 'spki', format: 'der' });
    // Ed25519 の SubjectPublicKeyInfo は、先頭 12 バイトが固定の見出しで、残りの 32 バイトが公開鍵
    if (der.length !== 44) return null;
    return der.subarray(12).toString('hex').toUpperCase();
  } catch { return null; }
}

export function readCertKeys(ws: string): Array<NodeKeySet & { source: string }> {
  const out: Array<NodeKeySet & { source: string }> = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 6 || out.length >= 50) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const readKey = (name: string): string | null => {
      try {
        const full = join(dir, name);
        if (lstatSync(full).size > MAX) return null;
        return ed25519KeyOfCert(readFileSync(full, 'utf8'));
      } catch { return null; }
    };
    const files = entries.filter((e) => e.isFile() && !e.isSymbolicLink());
    // 同じフォルダの node.crt.pem（なければ node.full.crt.pem）と、CA の証明書を 1 組にする
    const nodeFile = files.find((e) => /^node\.crt\.pem$/i.test(e.name)) ?? files.find((e) => NODE_CERT.test(e.name));
    if (nodeFile) {
      const node = readKey(nodeFile.name);
      const caFile = files.find((e) => CA_CERT.test(e.name));
      const main = caFile ? readKey(caFile.name) : null;
      if (node) {
        const parts = rel.split('/').filter(Boolean);
        // …/<ノード名>/cert/ のように、cert の 1 つ上のフォルダ名をノード名にする
        const name = (parts[parts.length - 1]?.toLowerCase() === 'cert' ? parts[parts.length - 2] : parts[parts.length - 1]) ?? '';
        out.push({ name: name.slice(0, 100), main, node, remote: null, vrf: null, voting: null, votings: [], source: rel ? `${rel}/${nodeFile.name}` : nodeFile.name });
      }
    }
    for (const e of entries) {
      if (e.isSymbolicLink() || e.name.startsWith('.') || e.name === 'node_modules' || !e.isDirectory()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === 'tools') continue;
      walk(join(dir, e.name), r, depth + 1);
    }
  };
  walk(ws, '', 0);
  return out;
}
