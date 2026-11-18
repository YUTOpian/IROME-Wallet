// 証明書からノードの公開鍵を読む（addresses.yml が無い Shoestring の作業場所向け）。実行: npx tsx dev-tests/node-certkeys.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAgent } from '../src/server/node-agent/agent';
import { ed25519KeyOfCert, readCertKeys } from '../src/server/node-agent/certKeys';
import { fetchNodeKeys } from '../src/lib/node/agentClient';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { console.log('openssl not available: skipped'); process.exit(0); }

const ws = mkdtempSync(join(tmpdir(), 'irome-ck-'));
const sh = (...a: string[]) => execFileSync('openssl', a, { stdio: 'ignore' });
const dir = join(ws, 'my-node', 'cert');
mkdirSync(dir, { recursive: true });
// CA と、CA が署名したノードの証明書（どちらも Ed25519）
sh('genpkey', '-algorithm', 'ed25519', '-out', join(dir, 'ca.key.pem'));
sh('req', '-x509', '-new', '-key', join(dir, 'ca.key.pem'), '-out', join(dir, 'ca.crt.pem'), '-days', '300', '-subj', '/CN=ca');
sh('genpkey', '-algorithm', 'ed25519', '-out', join(dir, 'node.key.pem'));
sh('req', '-new', '-key', join(dir, 'node.key.pem'), '-out', join(dir, 'node.csr'), '-subj', '/CN=node');
sh('x509', '-req', '-in', join(dir, 'node.csr'), '-CA', join(dir, 'ca.crt.pem'), '-CAkey', join(dir, 'ca.key.pem'), '-CAcreateserial', '-out', join(dir, 'node.crt.pem'), '-days', '200');
// 期待する公開鍵は、openssl で秘密鍵から別の方法で出す
const expect = (key: string) => execFileSync('openssl', ['pkey', '-in', join(dir, key), '-pubout', '-outform', 'DER']).subarray(12).toString('hex').toUpperCase();
const expNode = expect('node.key.pem'), expCa = expect('ca.key.pem');

ok(ed25519KeyOfCert(readFileSync(join(dir, 'node.crt.pem'), 'utf8')) === expNode, 'node cert → node public key matches openssl');
ok(ed25519KeyOfCert('garbage') === null, 'garbage → null');
sh('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(ws, 'rsa.key'), '-out', join(ws, 'rsa.crt'), '-subj', '/CN=r', '-days', '5');
ok(ed25519KeyOfCert(readFileSync(join(ws, 'rsa.crt'), 'utf8')) === null, 'RSA cert → null (not an Ed25519 node key)');

// tools/・シンボリックリンク・鍵ファイルは見ない
mkdirSync(join(ws, 'tools', 'x'), { recursive: true });
writeFileSync(join(ws, 'tools', 'x', 'node.crt.pem'), readFileSync(join(dir, 'node.crt.pem')));
const outside = mkdtempSync(join(tmpdir(), 'irome-ck-out-'));
writeFileSync(join(outside, 'node.crt.pem'), readFileSync(join(dir, 'node.crt.pem')));
symlinkSync(outside, join(ws, 'link'));
const sets = readCertKeys(ws);
ok(sets.length === 1, 'one node found (tools/ and symlink skipped)', sets);
ok(sets[0]?.node === expNode && sets[0]?.main === expCa, 'node key and main key (from CA cert)', sets[0]);
ok(sets[0]?.name === 'my-node' && sets[0]?.source === 'my-node/cert/node.crt.pem', 'name and source', sets[0]);
ok(sets[0]?.remote === null && sets[0]?.vrf === null && sets[0]?.voting === null, 'remote / vrf / voting are not invented');
ok(!JSON.stringify(sets).includes('PRIVATE'), 'no private material');

// エージェント経由。addresses.yml が同じノード鍵を持っているときは、重ねない
async function main() {
  const TOKEN = 't'.repeat(40);
  const agent = createAgent({ token: TOKEN, workspace: ws, origins: ['null'], resolve: () => null });
  await new Promise<void>((r) => agent.server.listen(0, '127.0.0.1', r));
  const conn = { url: `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`, token: TOKEN };
  let keys = await fetchNodeKeys(conn);
  ok(keys.length === 1 && keys[0].node === expNode && keys[0].source.endsWith('node.crt.pem'), 'agent returns the cert-derived key when there is no addresses.yml', keys);
  mkdirSync(join(ws, 'target'), { recursive: true });
  writeFileSync(join(ws, 'target', 'addresses.yml'), `nodes:\n  - name: my-node\n    transport:\n      publicKey: ${expNode}\n      privateKey: ${'A'.repeat(64)}\n    remote:\n      publicKey: ${'B'.repeat(64)}\n`);
  keys = await fetchNodeKeys(conn);
  ok(keys.length === 1 && keys[0].remote === 'B'.repeat(64), 'addresses.yml wins; the same node key is not listed twice', keys);
  await agent.close();
  rmSync(ws, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
  console.log(`${checks} checks, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
void main();
