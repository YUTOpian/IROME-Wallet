// 投票鍵の木のファイル（private_key_tree*.dat）の先頭ヘッダから、投票公開鍵と有効なエポックの範囲だけを読む（symbol-bootstrap・Shoestring 共通）。
// 本物の並びは、symbol-sdk の VotingKeysGenerator が作るファイルで確かめる。あわせて、その鍵が、ウォレットの投票鍵リンクの署名まで通ることも確かめる。
// 実行: npx tsx dev-tests/node-voting-trees.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PrivateKey } from 'symbol-sdk';
import { SymbolFacade, VotingKeysGenerator, KeyPair } from 'symbol-sdk/symbol';
import { createAgent } from '../src/server/node-agent/agent';
import { readHeader, readVotingTrees } from '../src/server/node-agent/votingTrees';
import { AgentError, fetchNodeKeys } from '../src/lib/node/agentClient';
import { VOTING_TREE_HEADER, parseVotingTreeHeader, sanitizeNodeKeySets } from '../src/lib/node/nodeKeys';
import { signVotingKeyLinks, votingLinkSize } from '../src/lib/symbol/tx';
import { useNodeKeysStore } from '../src/store/nodeKeysStore';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex').toUpperCase();
const root = new KeyPair(PrivateKey.random());
const ROOT = hexOf(root.publicKey.bytes);
/** 本物と同じ並びの木のファイル（子の秘密鍵は、ここで作る。返事に出ないことを後で確かめる）。 */
const children: string[] = [];
const tree = (start: bigint, end: bigint, rootPair = root) => new VotingKeysGenerator(rootPair, () => { const k = PrivateKey.random(); children.push(hexOf(k.bytes)); return k; }).generate(start, end);

// --- ヘッダの解析（純粋）
{
  const file = tree(100n, 127n);
  const h = parseVotingTreeHeader(file);
  ok(h !== null && h.key === ROOT && h.start === 100 && h.end === 127, 'header of a real VotingKeysGenerator file → root key and epoch range', h);
  ok(parseVotingTreeHeader(file.subarray(0, VOTING_TREE_HEADER))?.key === ROOT, 'only the 80-byte header is needed');
  ok(parseVotingTreeHeader(file.subarray(0, VOTING_TREE_HEADER - 1)) === null, 'a truncated header → null');
  const zero = Uint8Array.from(file); zero.fill(0, 32, 64);
  ok(parseVotingTreeHeader(zero) === null, 'an all-zero key → null');
  const reversed = Uint8Array.from(file); new DataView(reversed.buffer).setBigUint64(8, 50n, true);
  ok(parseVotingTreeHeader(reversed) === null, 'end before start → null');
  const zeroStart = Uint8Array.from(file); new DataView(zeroStart.buffer).setBigUint64(0, 0n, true);
  ok(parseVotingTreeHeader(zeroStart) === null, 'epoch 0 → null');
  const huge = Uint8Array.from(file); new DataView(huge.buffer).setBigUint64(8, 0x1_0000_0000n, true);
  ok(parseVotingTreeHeader(huge) === null, 'an epoch above uint32 → null');
}

// --- その鍵が、ウォレットの投票鍵リンク（署名・手数料のサイズ）まで通る
{
  const facade = new SymbolFacade('testnet');
  const seed = facade.network.generationHashSeed.toString();
  const signer = new KeyPair(PrivateKey.random());
  const mk = (n: number) => signVotingKeyLinks(hexOf(signer.privateKey.bytes), seed, {
    signerPublicKey: hexOf(signer.publicKey.bytes), networkByte: 0x98, feeMultiplier: 100, deadline: 1000n,
    links: Array.from({ length: n }, (_, i) => ({ publicKey: ROOT, startEpoch: 100 + i * 100, endEpoch: 127 + i * 100, link: true })),
  });
  let signed: ReturnType<typeof mk> | null = null;
  try { signed = mk(1); } catch (e) { console.log('sign error', (e as Error).message); }
  ok(signed !== null && signed.payload.length / 2 === votingLinkSize(1), 'a 64-hex voting key signs, and the fee size matches the real transaction (1 link)', signed && [signed.payload.length / 2, votingLinkSize(1)]);
  ok(signed !== null && signed.payload.toLowerCase().includes(ROOT.toLowerCase()), 'the signed payload carries the 32-byte voting key as is');
  ok(mk(2).payload.length / 2 === votingLinkSize(2) && mk(3).payload.length / 2 === votingLinkSize(3), 'fee size matches for 2 and 3 links');
  let refused = false;
  try { signVotingKeyLinks(hexOf(signer.privateKey.bytes), seed, { signerPublicKey: hexOf(signer.publicKey.bytes), networkByte: 0x98, feeMultiplier: 100, deadline: 1000n, links: [{ publicKey: 'AB'.repeat(48), startEpoch: 1, endEpoch: 28, link: true }] }); } catch { refused = true; }
  ok(refused, 'a 96-hex key is refused by the signer');
}

// --- ディスク上の読み取り（symbol-bootstrap・Shoestring の置き場所）
const ws = mkdtempSync(join(tmpdir(), 'irome-vt-'));
const outside = mkdtempSync(join(tmpdir(), 'irome-vt-out-'));
const put = (rel: string, data: Uint8Array) => { const full = join(ws, rel); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, data); };
const hex = (c: string, n: number) => c.repeat(n);
const root2 = new KeyPair(PrivateKey.random());
const ROOT2 = hexOf(root2.publicKey.bytes);

// symbol-bootstrap: target/addresses.yml と、target/nodes/<名前>/votingkeys/
writeFileSync(join(ws, 'placeholder'), '');
put('bs/target/addresses.yml', Buffer.from(`nodes:\n  - name: node\n    main:\n      publicKey: ${hex('1A', 32)}\n      privateKey: ${hex('A1', 32)}\n    transport:\n      publicKey: ${hex('2B', 32)}\n      privateKey: ${hex('B2', 32)}\n`));
put('bs/target/nodes/node/votingkeys/private_key_tree1.dat', tree(100n, 127n));
put('bs/target/nodes/node/votingkeys/private_key_tree2.dat', tree(128n, 160n, root2)); // 更新で足した、次の期間
// Shoestring: cert/ の証明書と、votingkeys/ が同じノードのフォルダ
const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
let NODE_KEY = '';
if (hasOpenssl) {
  const d = join(ws, 'ss', 'cert');
  mkdirSync(d, { recursive: true });
  const sh = (...a: string[]) => execFileSync('openssl', a, { stdio: 'ignore' });
  sh('genpkey', '-algorithm', 'ed25519', '-out', join(d, 'node.key.pem'));
  sh('req', '-x509', '-new', '-key', join(d, 'node.key.pem'), '-out', join(d, 'node.crt.pem'), '-days', '100', '-subj', '/CN=node');
  NODE_KEY = execFileSync('openssl', ['pkey', '-in', join(d, 'node.key.pem'), '-pubout', '-outform', 'DER']).subarray(12).toString('hex').toUpperCase();
}
const root3 = new KeyPair(PrivateKey.random());
put('ss/votingkeys/private_key_tree1.dat', tree(500n, 600n, root3));
// 読まないもの: tools/、シンボリックリンク、小さすぎるファイル、名前の違うファイル
put('tools/x/private_key_tree1.dat', tree(1n, 28n));
writeFileSync(join(outside, 'private_key_tree1.dat'), tree(1n, 28n, new KeyPair(PrivateKey.random())));
symlinkSync(outside, join(ws, 'linkdir'));
symlinkSync(join(outside, 'private_key_tree1.dat'), join(ws, 'ss', 'votingkeys', 'private_key_tree9.dat'));
put('small/private_key_tree1.dat', tree(1n, 28n).subarray(0, 100));
put('other/voting.dat', tree(1n, 28n));

{
  const found = readVotingTrees(ws);
  ok(found.length === 3, 'three trees found (tools/, symlinks, small and misnamed files are skipped)', found.map((f) => f.dir));
  ok(readHeader(join(ws, 'bs/target/nodes/node/votingkeys/private_key_tree1.dat'))?.key === ROOT, 'readHeader reads the root key');
  ok(readHeader(join(ws, 'small/private_key_tree1.dat')) === null && readHeader(join(ws, 'nope')) === null, 'readHeader: too small / missing → null');
}

const TOKEN = 'c'.repeat(64);
const agent = createAgent({ token: TOKEN, workspace: ws, origins: ['null'] });

async function main() {
  await new Promise<void>((r) => agent.server.listen(0, '127.0.0.1', r));
  const port = (agent.server.address() as AddressInfo).port;
  const conn = { url: `http://127.0.0.1:${port}`, token: TOKEN };
  try {
    const raw = await (await fetch(`${conn.url}/v1/node-keys`, { headers: { Authorization: `Bearer ${TOKEN}` } })).text();
    ok(!children.some((c) => raw.includes(c)), 'no per-epoch child private key appears in the HTTP body');
    ok(!raw.includes(hex('A1', 32)) && !raw.includes(hex('B2', 32)), 'addresses.yml private keys do not appear either');
    const nodes = await fetchNodeKeys(conn);
    const bs = nodes.find((n) => n.source.endsWith('addresses.yml') && n.name === 'node');
    ok(bs !== undefined && bs.votings.length === 2, 'bootstrap: both trees are attached to the node of the same name', bs);
    ok(bs?.votings[0].key === ROOT2 && bs.votings[0].start === 128 && bs.votings[0].end === 160, 'newest range first (the renewal)', bs?.votings);
    ok(bs?.votings[1].key === ROOT && bs.votings[1].start === 100 && bs.votings[1].end === 127, 'older range second', bs?.votings);
    ok(bs?.voting === ROOT2 && bs.node === hex('2B', 32), 'voting is the newest key; node key from addresses.yml is kept');
    if (hasOpenssl) {
      const ss = nodes.find((n) => n.node === NODE_KEY);
      ok(ss !== undefined && ss.votings.length === 1 && ss.votings[0].key === hexOf(root3.publicKey.bytes) && ss.votings[0].start === 500 && ss.votings[0].end === 600, 'shoestring: the tree next to cert/ is attached to the certificate node', ss);
    }
    ok(!nodes.some((n) => n.votings.some((v) => v.start === 1 && v.end === 28)), 'tools/, symlinked and small files give nothing');
  } catch (e) {
    ok(false, 'node-keys with voting trees', e);
  }

  // 画面側の再検証と、渡し先のストア
  const clean = sanitizeNodeKeySets([{ name: 'n', source: 's', node: null, votings: [
    { key: ROOT.toLowerCase(), start: 10, end: 40, secret: 'x' }, { key: 'short', start: 1, end: 2 }, { key: ROOT2, start: 50, end: 40 }, { key: hex('AB', 48), start: 1, end: 28 }, 7,
  ] }]);
  ok(clean[0].votings.length === 2 && clean[0].votings[0].key === ROOT && clean[0].votings[0].start === 10, 'sanitize: bad keys dropped, key upper-cased', clean[0].votings);
  ok(clean[0].votings.find((v) => v.key === ROOT2)?.start === null, 'sanitize: a reversed range is dropped but the key is kept', clean[0].votings);
  ok(!JSON.stringify(clean).includes('secret'), 'sanitize: unknown fields dropped');

  const st = useNodeKeysStore;
  st.getState().clear();
  st.getState().set({ voting: ROOT.toLowerCase(), votingStart: 100, votingEnd: 127 });
  ok(st.getState().pending?.voting === ROOT && st.getState().pending?.votingStart === 100 && st.getState().pending?.votingEnd === 127, 'store carries the voting key with its epoch range');
  st.getState().set({ voting: ROOT, votingStart: 127, votingEnd: 100 });
  ok(st.getState().pending?.votingStart === null && st.getState().pending?.votingEnd === null, 'a reversed range is not carried');
  st.getState().set({ node: hex('2B', 32), votingStart: 100, votingEnd: 127 });
  ok(st.getState().pending?.votingStart === null, 'an epoch range without a voting key is not carried');
  st.getState().clear();

  // 認証と、作業フォルダの外へは出ない
  const noAuth = await fetch(`${conn.url}/v1/node-keys`);
  ok(noAuth.status === 401, 'node-keys needs the token');
  try { await fetchNodeKeys({ url: conn.url, token: 'x'.repeat(64) }); ok(false, 'wrong token should fail'); } catch (e) { ok(e instanceof AgentError && e.kind === 'unauthorized', 'wrong token → unauthorized'); }

  await agent.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  console.log(`${checks} checks, ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
}
void main();
