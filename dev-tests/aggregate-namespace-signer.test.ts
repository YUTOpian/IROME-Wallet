// マルチシグアカウントのネームスペース更新: 内側の登録トランザクションの署名者がマルチシグ口座になり、
// 他の連署が要るときはボンデッド、1人で足りるときはコンプリートになること。
// Run: npx tsx dev-tests/aggregate-namespace-signer.test.ts
import { PrivateKey } from 'symbol-sdk';
import { KeyPair } from 'symbol-sdk/symbol';
import { addressFromPublicKey } from '../src/lib/symbol/crypto';
import { aggregateMosaicId, aggregateSize, createdId, uidsToRemove, cosignatureCount, needsBonded, otherSigners, signAggregate } from '../src/lib/symbol/aggregate';
import type { AggregateItem, AggregateSigner } from '../src/lib/symbol/aggregate';
import { getNetworkConfig } from '../src/lib/symbol/network';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const cfg = getNetworkConfig();
const pub = (seed: number) => new KeyPair(new PrivateKey(new Uint8Array(32).fill(seed))).publicKey.toString().toUpperCase();
const walletPriv = new Uint8Array(32).fill(1);
const walletPub = pub(1);
const walletAddr = addressFromPublicKey(walletPub, cfg.networkByte);
const msigPub = pub(2);
const msigAddr = addressFromPublicKey(msigPub, cfg.networkByte);
const signer = (selfSufficient: boolean): AggregateSigner => ({ address: msigAddr, publicKey: msigPub, multisig: true, selfSufficient, cosignatures: selfSufficient ? 0 : 1 });
const item = (s?: AggregateSigner): AggregateItem => ({ uid: 'r', kind: 'namespace', name: 'irome', durationBlocks: 2880n * 365n, signer: s });

ok(!needsBonded([item()]), 'own namespace registration stays complete');
ok(needsBonded([item(signer(false))]), 'multisig needing others → bonded');
ok(!needsBonded([item(signer(true))]), 'multisig with minApproval 1 → complete');
ok(cosignatureCount([item(signer(false))]) === 1, 'cosignature room counted');
ok(otherSigners([item(signer(false))]).length === 1, 'other signer listed');

const sizeOwn = aggregateSize(walletPub, walletAddr, cfg.networkByte, [item()]);
const sizeMsig = aggregateSize(walletPub, walletAddr, cfg.networkByte, [item(signer(false))]);
ok(sizeMsig > sizeOwn, 'fee leaves room for cosignatures', { sizeOwn, sizeMsig });

const signed = signAggregate(Buffer.from(walletPriv).toString('hex'), cfg.generationHash, {
  signerPublicKey: walletPub, ownerAddress: walletAddr, networkByte: cfg.networkByte, items: [item(signer(false))], feeMultiplier: 100, deadline: 1_000_000n,
});
ok(signed.bonded, 'signed aggregate is bonded');
ok(signed.payload.toUpperCase().includes(msigPub), 'inner registration is signed by the multisig account');

// モザイクの発行・供給量変更: 内側の署名者がマルチシグ口座で、モザイクIDもマルチシグ口座のアドレスから決まる。
const mDef = (s?: AggregateSigner): AggregateItem => ({ uid: 'd', kind: 'mosaic_definition', nonce: 7, divisibility: 0, flags: 3, durationBlocks: 0n, signer: s });
const mSup = (s?: AggregateSigner): AggregateItem => ({ uid: 's', kind: 'mosaic_supply', mosaicId: aggregateMosaicId(s?.address ?? walletAddr, 7), mosaicSymbol: '', divisibility: 0, action: 'increase', delta: 100n, signer: s });
ok(!needsBonded([mDef(), mSup()]), 'own mosaic issue stays complete');
ok(needsBonded([mDef(signer(false)), mSup(signer(false))]), 'mosaic issue from multisig needing others → bonded');
ok(!needsBonded([mDef(signer(true)), mSup(signer(true))]), 'mosaic issue from self-sufficient multisig → complete');
ok(cosignatureCount([mDef(signer(false)), mSup(signer(false))]) === 1, 'one account counted once for cosignature room');
ok(aggregateMosaicId(msigAddr, 7) !== aggregateMosaicId(walletAddr, 7), 'mosaic id depends on the owning (multisig) address');
const signedM = signAggregate(Buffer.from(walletPriv).toString('hex'), cfg.generationHash, {
  signerPublicKey: walletPub, ownerAddress: walletAddr, networkByte: cfg.networkByte, items: [mDef(signer(false)), mSup(signer(false))], feeMultiplier: 100, deadline: 1_000_000n,
});
ok(signedM.bonded && signedM.payload.toUpperCase().includes(msigPub), 'mosaic issue is a bonded aggregate whose inner transactions are signed by the multisig account');

// エイリアスのリンク・解除: 内側の署名者がマルチシグ口座。
const aliasAddr: AggregateItem = { uid: 'a', kind: 'alias', namespaceId: '85BBEA6CC462B244', action: 'link', target: { type: 'address', address: msigAddr }, signer: signer(false) };
const aliasMosaic: AggregateItem = { uid: 'b', kind: 'alias', namespaceId: '85BBEA6CC462B244', action: 'unlink', target: { type: 'mosaic', mosaicId: '6BED913FA20223F8' }, signer: signer(false) };
ok(needsBonded([aliasAddr]) && needsBonded([aliasMosaic]), 'alias from multisig needing others → bonded');
for (const it of [aliasAddr, aliasMosaic]) {
  const sg = signAggregate(Buffer.from(walletPriv).toString('hex'), cfg.generationHash, { signerPublicKey: walletPub, ownerAddress: walletAddr, networkByte: cfg.networkByte, items: [it], feeMultiplier: 100, deadline: 1_000_000n });
  ok(sg.bonded && sg.payload.toUpperCase().includes(msigPub), `alias (${it.kind === 'alias' ? it.target.type : ''}) is signed by the multisig account inside the aggregate`);
}

// メタデータ（マルチシグ口座が送り主）と、モザイク・ネームスペース新規作成との同時設定。
const enc = (t: string) => new TextEncoder().encode(t);
const mosaicIdM = aggregateMosaicId(msigAddr, 9);
const metaMosaic: AggregateItem = { uid: 'm', kind: 'metadata', signer: signer(false), target: { type: 'mosaic', mosaicId: mosaicIdM }, key: 1n, oldValue: new Uint8Array(0), newValue: enc('hello') };
const metaAccount: AggregateItem = { uid: 'a', kind: 'metadata', signer: signer(false), target: { type: 'account' }, key: 2n, oldValue: enc('old'), newValue: enc('newer') };
ok(needsBonded([metaMosaic]), 'metadata from multisig needing others → bonded');
const withMeta = [mDef(signer(false)), mSup(signer(false)), metaMosaic];
ok(aggregateSize(walletPub, walletAddr, cfg.networkByte, withMeta) > aggregateSize(walletPub, walletAddr, cfg.networkByte, [mDef(signer(false)), mSup(signer(false))]), 'metadata entries add to the size');
for (const it of [metaMosaic, metaAccount]) {
  const sg = signAggregate(Buffer.from(walletPriv).toString('hex'), cfg.generationHash, { signerPublicKey: walletPub, ownerAddress: walletAddr, networkByte: cfg.networkByte, items: [it], feeMultiplier: 100, deadline: 1_000_000n });
  ok(sg.bonded && sg.payload.toUpperCase().includes(msigPub), 'metadata is signed by the multisig account inside the aggregate');
}
const withNs: AggregateItem[] = [item(signer(false)), { uid: 'nm', kind: 'metadata', signer: signer(false), target: { type: 'namespace', namespaceId: '85BBEA6CC462B244' }, key: 3n, oldValue: new Uint8Array(0), newValue: enc('x') }];
const sgNs = signAggregate(Buffer.from(walletPriv).toString('hex'), cfg.generationHash, { signerPublicKey: walletPub, ownerAddress: walletAddr, networkByte: cfg.networkByte, items: withNs, feeMultiplier: 100, deadline: 1_000_000n });
ok(sgNs.bonded, 'namespace registration with metadata from a multisig is one bonded aggregate');

// 削除: マルチシグ口座向けに発行したモザイクの供給量変更も、一緒に消えること（モザイクIDは口座のアドレスで決まる）。
const defM: AggregateItem = { uid: 'dm', kind: 'mosaic_definition', signer: signer(false), nonce: 9, divisibility: 0, flags: 2, durationBlocks: 0n };
const supM: AggregateItem = { uid: 'sm', kind: 'mosaic_supply', signer: signer(false), mosaicId: aggregateMosaicId(msigAddr, 9), mosaicSymbol: 'x', divisibility: 0, action: 'increase', delta: 5n };
ok(createdId(defM, walletAddr) === aggregateMosaicId(msigAddr, 9), 'a mosaic issued for a multisig account takes its id from that account');
ok(uidsToRemove([defM, supM], 'dm', walletAddr).includes('sm'), 'removing the definition removes its supply change');

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} FAILED of ${checks}`);
process.exit(fails === 0 ? 0 : 1);
