// Shoestring の作業場所の鍵ファイルから、リモート・VRF（・ノード）鍵の「公開鍵」だけを取り出す。
// 証明書（certKeys.ts）からはノード鍵しか分からないので、画面で利用者が確認したときだけ、秘密鍵のファイルを開く:
//   remote.key.pem / vrf.key.pem / node.key.pem（Ed25519 の PEM。`.pem` だけの名前も）と、
//   config-harvesting.properties の harvesterSigningPrivateKey（リモート）・harvesterVrfPrivateKey（VRF）。
// 秘密鍵は、公開鍵を作った時点で捨てる。返事にも、ログにも、例外の文言にも入れない（返す型にも入れ場所が無い）。
// 暗号化された PEM は開けない（パスワードは聞かない）。シンボリックリンクは辿らない。tools/ と node_modules の中、`.` で始まるものは見ない。
// 投票鍵は、鍵の木のファイルから公開鍵を取り出す手順が決まっていないので、扱わない（ハーベスト画面で手入力）。
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeKeySet } from '../../lib/node/nodeKeys';

const MAX = 64 * 1024;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PEM_NAMES: Record<'remote' | 'vrf' | 'node', RegExp> = {
  remote: /^remote(\.key)?\.pem$/i,
  vrf: /^vrf(\.key)?\.pem$/i,
  node: /^node(\.key)?\.pem$/i,
};
const PROPS_NAME = /^config-harvesting\.properties$/i;

export type ShoestringNote = 'pem_encrypted' | 'pem_unsupported';
export type ShoestringKind = 'remote' | 'vrf' | 'node';
export interface ShoestringFailure { note: ShoestringNote; kind: ShoestringKind; folder: string }
export type DerivedKey = { ok: true; key: string } | { ok: false; reason: 'encrypted' | 'unsupported' };

const publicHexOf = (priv: ReturnType<typeof createPrivateKey>): DerivedKey => {
  if (priv.asymmetricKeyType !== 'ed25519') return { ok: false, reason: 'unsupported' };
  const jwk = createPublicKey(priv).export({ format: 'jwk' }) as { x?: string };
  return jwk.x ? { ok: true, key: Buffer.from(jwk.x, 'base64url').toString('hex').toUpperCase() } : { ok: false, reason: 'unsupported' };
};

/** 16 進 64 文字の秘密鍵（Symbol の鍵はこの形）から、公開鍵（大文字の 16 進 64 文字）。 */
export function publicKeyFromSeedHex(hex: string): DerivedKey {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return { ok: false, reason: 'unsupported' };
  try { return publicHexOf(createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'pkcs8' })); } catch { return { ok: false, reason: 'unsupported' }; }
}

/** Ed25519 の秘密鍵の PEM から、公開鍵。暗号化されているものは理由だけを返す（鍵の中身は、返さない）。 */
export function publicKeyFromPem(pem: string): DerivedKey {
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(pem) || /Proc-Type:\s*4,ENCRYPTED/.test(pem)) return { ok: false, reason: 'encrypted' };
  try { return publicHexOf(createPrivateKey({ key: pem, format: 'pem' })); } catch { return { ok: false, reason: 'unsupported' }; }
}

/** config-harvesting.properties の、リモート（harvesterSigningPrivateKey）と VRF（harvesterVrfPrivateKey）の公開鍵。 */
export function publicKeysFromHarvestingProperties(text: string): { remote?: string; vrf?: string } {
  const out: { remote?: string; vrf?: string } = {};
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const m = /^\s*(harvesterSigningPrivateKey|harvesterVrfPrivateKey)\s*=\s*([0-9A-Fa-f]{64})\s*$/.exec(line);
    if (!m) continue;
    const d = publicKeyFromSeedHex(m[2]);
    if (d.ok) out[m[1] === 'harvesterSigningPrivateKey' ? 'remote' : 'vrf'] = d.key;
  }
  return out;
}

const STRIP = ['userconfig/resources', 'userconfig', 'resources', 'cert', 'keys'];
/**
 * ファイルのあるフォルダ（作業場所からの相対パス）を、ノード 1 つ分のまとまりの名前にする。
 * `…/cert` `…/keys` `…/userconfig/resources` などの末尾は落とす（証明書と鍵ファイルが、同じノードのものになるように）。
 */
export function nodeFolderOf(dirRel: string): string {
  let d = dirRel.replace(/^\/+|\/+$/g, '');
  for (let again = true; again && d !== ''; ) {
    again = false;
    for (const tail of STRIP) {
      if (d === tail) { d = ''; again = true; break; }
      if (d.endsWith(`/${tail}`)) { d = d.slice(0, -(tail.length + 1)); again = true; break; }
    }
  }
  return d;
}

export interface ShoestringKeys {
  /** まとまり（ノードのフォルダ）ごとの公開鍵。見つかったものだけ。source は、最初に使ったファイルの相対パス。 */
  sets: Array<NodeKeySet & { source: string; folder: string }>;
  /** 読めなかった PEM（暗号化・Ed25519 でない）。どのノードの、どの鍵か。 */
  failures: ShoestringFailure[];
}

export function readShoestringKeys(ws: string): ShoestringKeys {
  const byFolder = new Map<string, NodeKeySet & { source: string; folder: string }>();
  const failures: ShoestringFailure[] = [];
  const setOf = (folder: string, source: string) => {
    let s = byFolder.get(folder);
    if (!s) {
      const parts = folder.split('/').filter(Boolean);
      s = { name: (parts[parts.length - 1] ?? '').slice(0, 100), main: null, node: null, remote: null, vrf: null, voting: null, votings: [], source, folder };
      byFolder.set(folder, s);
    }
    return s;
  };

  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 7 || byFolder.size >= 50) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const readSmall = (name: string): string | null => {
      try {
        const full = join(dir, name);
        const st = lstatSync(full);
        if (!st.isFile() || st.isSymbolicLink() || st.size > MAX) return null;
        return readFileSync(full, 'utf8');
      } catch { return null; }
    };
    const folder = nodeFolderOf(rel);
    for (const e of entries) {
      if (!e.isFile() || e.isSymbolicLink()) continue;
      const src = rel ? `${rel}/${e.name}` : e.name;
      for (const kind of ['remote', 'vrf', 'node'] as const) {
        if (!PEM_NAMES[kind].test(e.name)) continue;
        const pem = readSmall(e.name);
        if (pem === null) continue;
        const d = publicKeyFromPem(pem);
        if (!d.ok) { failures.push({ note: d.reason === 'encrypted' ? 'pem_encrypted' : 'pem_unsupported', kind, folder }); continue; }
        const s = setOf(folder, src);
        if (s[kind] === null) s[kind] = d.key;
      }
      if (PROPS_NAME.test(e.name)) {
        const text = readSmall(e.name);
        if (text === null) continue;
        const p = publicKeysFromHarvestingProperties(text);
        if (p.remote || p.vrf) {
          const s = setOf(folder, src);
          // PEM で取れているものを優先する
          if (s.remote === null && p.remote) s.remote = p.remote;
          if (s.vrf === null && p.vrf) s.vrf = p.vrf;
        }
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
  return { sets: [...byFolder.values()], failures };
}

/**
 * 証明書などから読んだノードの一覧（existing）に、鍵ファイルから取れた公開鍵を足す。
 * 同じノードのフォルダ（証明書の cert/ の 1 つ上など）なら、空いている種類だけを埋める。無ければ、別のノードとして足す。
 * addresses.yml から読んだものには足さない（そちらに、すでに揃っている）。
 * 読めなかった PEM の理由は、その種類がまだ空のときだけ返す。
 */
export function mergeShoestringKeys<T extends NodeKeySet & { source: string }>(existing: T[], found: ShoestringKeys): { nodes: Array<NodeKeySet & { source: string }>; notes: Array<{ code: ShoestringNote; kind: ShoestringKind }> } {
  const nodes: Array<NodeKeySet & { source: string }> = existing.map((e) => ({ ...e }));
  const folderOf = (e: { source: string }) => {
    const i = e.source.lastIndexOf('/');
    return nodeFolderOf(i < 0 ? '' : e.source.slice(0, i));
  };
  const isYml = (e: { source: string }) => /(^|\/)addresses\.ya?ml$/i.test(e.source);
  const target = new Map<string, NodeKeySet & { source: string }>();
  for (const e of nodes) if (!isYml(e) && !target.has(folderOf(e))) target.set(folderOf(e), e);
  for (const f of found.sets) {
    const t = target.get(f.folder);
    if (t) {
      if (t.remote === null) t.remote = f.remote;
      if (t.vrf === null) t.vrf = f.vrf;
      if (t.node === null) t.node = f.node;
    } else {
      const { folder, ...rest } = f;
      const created = { ...rest };
      nodes.push(created);
      target.set(folder, created);
    }
  }
  const seen = new Set<string>();
  const notes: Array<{ code: ShoestringNote; kind: ShoestringKind }> = [];
  for (const fl of found.failures) {
    const t = target.get(fl.folder);
    if (t && t[fl.kind] !== null) continue;
    const id = `${fl.note}:${fl.kind}`;
    if (seen.has(id)) continue;
    seen.add(id);
    notes.push({ code: fl.note, kind: fl.kind });
  }
  return { nodes: nodes.slice(0, 50), notes };
}
