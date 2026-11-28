// Shoestring の鍵ファイル（remote.key.pem / vrf.key.pem / config-harvesting.properties）から、リモート・VRF 鍵の公開鍵だけを読む。
// 確認（confirm: true）なしでは読まない・秘密鍵が返事のどこにも出ない・暗号化された PEM・シンボリックリンク・tools/ を確かめる。
// 実行: npx tsx dev-tests/node-shoestring-keys.test.ts
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAgent } from '../src/server/node-agent/agent';
import { mergeShoestringKeys, nodeFolderOf, publicKeyFromPem, publicKeyFromSeedHex, publicKeysFromHarvestingProperties, readShoestringKeys } from '../src/server/node-agent/shoestringKeys';
import { AgentError, fetchNodeKeys, fetchNodeKeysFromKeyFiles } from '../src/lib/node/agentClient';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const pair = () => {
  const p = generateKeyPairSync('ed25519');
  const pem = p.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const seed = (p.privateKey.export({ format: 'jwk' }) as { d: string }).d;
  const pub = Buffer.from((p.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('hex').toUpperCase();
  return { p, pem, seedHex: Buffer.from(seed, 'base64url').toString('hex'), pub };
};

// --- 純粋な部分
ok(nodeFolderOf('my-node/cert') === 'my-node' && nodeFolderOf('my-node/userconfig/resources') === 'my-node' && nodeFolderOf('my-node/keys') === 'my-node' && nodeFolderOf('cert') === '' && nodeFolderOf('a/b') === 'a/b', 'nodeFolderOf strips cert / keys / userconfig/resources');
{
  const v = publicKeyFromSeedHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'); // RFC 8032 のテストベクタ 1
  ok(v.ok && v.key === 'D75A980182B10AB7D54BFED3C964073A0EE172F3DAA62325AF021A68F707511A', 'seed → public key (RFC 8032)', v);
  ok(!publicKeyFromSeedHex('zz').ok, 'bad seed refused');
  const a = pair();
  const d = publicKeyFromPem(a.pem);
  ok(d.ok && d.key === a.pub, 'PEM → public key', d);
  const enc = a.p.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'SECRETWORD' }) as string;
  const e = publicKeyFromPem(enc);
  ok(!e.ok && e.reason === 'encrypted' && !JSON.stringify(e).includes('SECRETWORD'), 'encrypted PEM → reason only', e);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  ok(!publicKeyFromPem(rsa).ok && !publicKeyFromPem('not a pem').ok, 'non-Ed25519 / garbage refused');
  const props = publicKeysFromHarvestingProperties(`harvesterSigningPrivateKey = ${a.seedHex}\nharvesterVrfPrivateKey=${'7'.repeat(64)}\nharvesterName = x\n`);
  ok(props.remote === a.pub && props.vrf?.length === 64, 'properties → remote / vrf public keys', props);
}

// --- フォルダの読み取り（本物の openssl の証明書と並べる）
const SECRETS: string[] = ['SECRETWORD'];
const ws = mkdtempSync(join(tmpdir(), 'irome-sk-'));
let hasOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenssl = false; }
const remote = pair(), vrf = pair(), node = pair(), other = pair();
SECRETS.push(remote.seedHex, vrf.seedHex, node.seedHex, other.seedHex, 'PRIVATE KEY');
{
  // 1 つめのノード: cert/ に証明書、同じノードのフォルダに remote / vrf の PEM
  const nd = join(ws, 'my-node');
  mkdirSync(join(nd, 'cert'), { recursive: true });
  mkdirSync(join(nd, 'keys'), { recursive: true });
  writeFileSync(join(nd, 'keys', 'remote.key.pem'), remote.pem);
  writeFileSync(join(nd, 'keys', 'vrf.key.pem'), vrf.pem);
  writeFileSync(join(nd, 'cert', 'node.key.pem'), node.pem);
  // 2 つめのノード: config-harvesting.properties だけ
  mkdirSync(join(ws, 'node2', 'userconfig', 'resources'), { recursive: true });
  writeFileSync(join(ws, 'node2', 'userconfig', 'resources', 'config-harvesting.properties'), `harvesterSigningPrivateKey = ${other.seedHex}\nharvesterVrfPrivateKey = ${vrf.seedHex}\n`);
  // 3 つめ: 暗号化された PEM
  mkdirSync(join(ws, 'node3'), { recursive: true });
  writeFileSync(join(ws, 'node3', 'remote.key.pem'), other.p.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'SECRETWORD' }) as string);
  // 見ないもの: tools/、シンボリックリンク、ドット始まり、CA の鍵
  mkdirSync(join(ws, 'tools', 'x'), { recursive: true });
  writeFileSync(join(ws, 'tools', 'x', 'remote.key.pem'), other.pem);
  mkdirSync(join(ws, '.hidden'), { recursive: true });
  writeFileSync(join(ws, '.hidden', 'remote.key.pem'), other.pem);
  writeFileSync(join(ws, 'my-node', 'cert', 'ca.key.pem'), other.pem);
  const outside = mkdtempSync(join(tmpdir(), 'irome-sk-out-'));
  mkdirSync(join(outside, 'k'), { recursive: true });
  writeFileSync(join(outside, 'k', 'remote.key.pem'), other.pem);
  symlinkSync(outside, join(ws, 'linked'));
  mkdirSync(join(ws, 'sl'), { recursive: true });
  symlinkSync(join(outside, 'k', 'remote.key.pem'), join(ws, 'sl', 'remote.key.pem'));

  const r = readShoestringKeys(ws);
  const byName = Object.fromEntries(r.sets.map((s) => [s.folder, s]));
  ok(byName['my-node']?.remote === remote.pub && byName['my-node']?.vrf === vrf.pub && byName['my-node']?.node === node.pub, 'folder: remote / vrf / node PEM → public keys (keys/ and cert/ belong to my-node)', r.sets);
  ok(byName['node2']?.remote === other.pub && byName['node2']?.vrf === vrf.pub, 'folder: config-harvesting.properties → remote / vrf', r.sets);
  ok(!byName['node3'] && r.failures.some((f) => f.folder === 'node3' && f.note === 'pem_encrypted' && f.kind === 'remote'), 'folder: encrypted PEM → failure only', r);
  ok(!r.sets.some((s) => ['tools/x', '.hidden', 'linked/k', 'sl', 'linked'].includes(s.folder)), 'folder: tools/, dot folders and symlinks are not read', r.sets.map((s) => s.folder));
  ok(!JSON.stringify(r).includes('SECRETWORD') && !SECRETS.slice(1).some((x) => JSON.stringify(r).includes(x)), 'folder: no private material in the result');

  // 証明書（本物の openssl）と同じノードに重ねる
  if (hasOpenssl) {
    const sh = (...a: string[]) => execFileSync('openssl', a, { stdio: 'ignore' });
    const dir = join(nd, 'cert');
    sh('genpkey', '-algorithm', 'ed25519', '-out', join(dir, 'ca.key.pem'));
    sh('req', '-x509', '-new', '-key', join(dir, 'ca.key.pem'), '-out', join(dir, 'ca.crt.pem'), '-days', '300', '-subj', '/CN=ca');
    sh('req', '-new', '-key', join(dir, 'node.key.pem'), '-out', join(dir, 'node.csr'), '-subj', '/CN=node');
    sh('x509', '-req', '-in', join(dir, 'node.csr'), '-CA', join(dir, 'ca.crt.pem'), '-CAkey', join(dir, 'ca.key.pem'), '-CAcreateserial', '-out', join(dir, 'node.crt.pem'), '-days', '200');
  }
}

// --- エージェントの HTTP
const TOKEN = 'c'.repeat(64);
const agent = createAgent({ token: TOKEN, workspace: ws, origins: ['null'], resolve: () => null });
async function main() {
  await new Promise<void>((r) => agent.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`;
  const c = { url: base, token: TOKEN };
  const raw = async (path: string, init: RequestInit = {}, token = TOKEN) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) } });
    return { status: res.status, text: await res.text() };
  };

  // 確認なしでは、秘密鍵のファイルを開かない
  const get = await raw('/v1/node-keys');
  ok(get.status === 200 && !get.text.includes(remote.pub) && !get.text.includes(vrf.pub), 'GET /v1/node-keys never reads the private key files', get.text);
  ok((await raw('/v1/node-keys/shoestring', { method: 'POST', body: '{}' })).status === 400, 'POST without confirm → 400');
  ok((await raw('/v1/node-keys/shoestring', { method: 'POST', body: JSON.stringify({ confirm: 'true' }) })).status === 400, 'confirm must be the boolean true');
  ok((await raw('/v1/node-keys/shoestring', { method: 'POST', body: JSON.stringify({ confirm: true }), headers: {} }, 'wrong')).status === 401, 'needs the token');
  ok((await fetch(`${base}/v1/node-keys/shoestring`, { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } })).status === 404, 'GET is not allowed on the key-file route');

  const res = await raw('/v1/node-keys/shoestring', { method: 'POST', body: JSON.stringify({ confirm: true }) });
  ok(res.status === 200, 'POST with confirm → 200', res);
  ok(!SECRETS.some((s) => res.text.includes(s)) && !/PRIVATE|privateKey|harvester/i.test(res.text), 'the raw response body holds no private material', res.text);
  ok(res.text.includes(remote.pub) && res.text.includes(vrf.pub) && res.text.includes(other.pub), 'the public keys are in the body');

  const got = await fetchNodeKeysFromKeyFiles(c);
  const my = got.nodes.find((n) => n.source.startsWith('my-node/'));
  ok(my !== undefined && my.remote === remote.pub && my.vrf === vrf.pub && my.node === node.pub, 'client: my-node has remote / vrf / node', got.nodes);
  if (hasOpenssl) ok(my?.source === 'my-node/cert/node.crt.pem' && my?.main !== null, 'client: merged into the certificate entry of the same node (main from the CA cert)', my);
  ok(got.notes.some((n) => n.code === 'pem_encrypted' && n.kind === 'remote'), 'client: encrypted PEM note', got.notes);
  ok(got.nodes.some((n) => n.remote === other.pub && n.vrf === vrf.pub), 'client: node2 from config-harvesting.properties');

  // 通常の読み込み（証明書）には、鍵ファイル由来の公開鍵は混ざらない
  if (hasOpenssl) {
    const plain = await fetchNodeKeys(c);
    ok(plain.some((n) => n.node === node.pub) && plain.every((n) => n.remote === null && n.vrf === null), 'client: the normal read still has no remote / vrf', plain);
  }
  // 受け取り側の再検証: 長さの違う鍵と未知の項目は落ちる
  const { sanitizeNodeKeySets } = await import('../src/lib/node/nodeKeys');
  const dirty = sanitizeNodeKeySets([{ name: 'x', source: 's', remote: 'abc', vrf: vrf.pub.toLowerCase(), node: null, main: null, voting: null, privateKey: 'LEAK' }]);
  ok(dirty[0].remote === null && dirty[0].vrf === vrf.pub && !JSON.stringify(dirty).includes('LEAK'), 'client: sanitize drops bad keys and unknown fields', dirty);
  ok((await fetchNodeKeysFromKeyFiles({ url: base, token: 'wrong' }).catch((e: unknown) => (e instanceof AgentError ? e.kind : 'other'))) === 'unauthorized', 'client: unauthorized');

  // mergeShoestringKeys: addresses.yml から読んだものには足さない
  const merged = mergeShoestringKeys(
    [{ name: 'a', main: null, node: null, remote: null, vrf: null, voting: null, source: 'target/addresses.yml' }],
    { sets: [{ name: 'target', main: null, node: null, remote: 'R'.repeat(64), vrf: null, voting: null, source: 'target/remote.key.pem', folder: 'target' }], failures: [] },
  );
  ok(merged.nodes.length === 2 && merged.nodes[0].remote === null, 'merge: an addresses.yml entry is left as it is', merged.nodes);

  await agent.close();
  rmSync(ws, { recursive: true, force: true });
  console.log(`${checks} checks, ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
