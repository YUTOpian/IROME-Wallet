// ハーベスト（キーリンク・投票鍵・開始・停止）をマルチシグアカウントのために行う。
// マルチシグアカウントは自分ではトランザクションを送れない（Failure_Multisig_Operation_Prohibited_By_Account）ので、
// リンク／解除は、連署者のウォレットが署名するアグリゲートの中の取引（そのマルチシグアカウント名義）として送る。
// 他の連署者の承認が要るときはボンデッド（ハッシュロック付き）、このウォレットだけで足りるときはコンプリートになる。
// 委任リクエスト（ノードへの暗号化メッセージ）は、リモート／VRFの秘密鍵をノードに渡すだけの通常の送金なので、
// 連署者のウォレットがそのまま送る。
import { SymbolSendError, sendHarvestDelegationRequest } from './api';
import type { HarvestStatus } from './api';
import { quoteAggregate, sendAggregate } from './aggregateApi';
import type { AggregateQuote } from './aggregateApi';
import { cosignatureCount } from './aggregate';
import type { AggregateItem, AggregateSigner } from './aggregate';
import { getDefaultFeeSpeed } from './feeSpeed';
import type { FeeSpeed } from './feeSpeed';
import type { KeylessSigner } from './sssSign';
import { COSIGNATURE_SIZE, newHarvestKeyPair } from './tx';
import type { HarvestLink, VotingKeyLink } from './tx';

/** The wallet (a cosigner) that signs the aggregate and pays its fees. */
export interface CosignerWallet {
  privateKey: string; // '' for an SSS Extension / Ledger account (then `keyless` is set)
  keyless?: KeylessSigner;
  publicKey: string;
  address: string;
}

/** Links / unlinks of the harvesting keys as inner transactions signed in the name of the multisig account. */
export function harvestLinkItems(signer: AggregateSigner, links: HarvestLink[]): AggregateItem[] {
  return links.map((l, i): AggregateItem => ({ uid: `harvest-link-${i}`, kind: 'key_link', signer, spec: { type: 'harvest', ...l } }));
}

/** Links / unlinks of voting keys as inner transactions signed in the name of the multisig account. */
export function votingLinkItems(signer: AggregateSigner, links: VotingKeyLink[]): AggregateItem[] {
  return links.map((l, i): AggregateItem => ({ uid: `voting-link-${i}`, kind: 'key_link', signer, spec: { type: 'voting', ...l } }));
}

/** The links that turn harvesting off: every key linked now, unlinked. */
export function unlinkAllLinks(status: Pick<HarvestStatus, 'remotePublicKey' | 'vrfPublicKey' | 'nodePublicKey'>): HarvestLink[] {
  const links: HarvestLink[] = [];
  if (status.remotePublicKey) links.push({ kind: 'remote', publicKey: status.remotePublicKey, link: false });
  if (status.vrfPublicKey) links.push({ kind: 'vrf', publicKey: status.vrfPublicKey, link: false });
  if (status.nodePublicKey) links.push({ kind: 'node', publicKey: status.nodePublicKey, link: false });
  return links;
}

const PLACEHOLDER_KEY = '00'.repeat(32);

/** Stand-in links of the right size, for quoting the fee before the real keys exist. */
export function probeLinks(count: number): HarvestLink[] {
  const kinds = ['remote', 'vrf', 'node'] as const;
  return Array.from({ length: count }, (_, i) => ({ kind: kinds[i % kinds.length], publicKey: PLACEHOLDER_KEY, link: true }));
}

/** Bytes the fee of these items leaves room for beyond the aggregate itself (the cosignatures others will attach). */
export const cosignatureBytes = (items: AggregateItem[]): number => COSIGNATURE_SIZE * cosignatureCount(items);

/** Fee / hash lock of an aggregate holding `linkCount` key links for the multisig account. */
export function quoteMultisigLinks(wallet: Pick<CosignerWallet, 'publicKey' | 'address'>, signer: AggregateSigner, linkCount: number): Promise<AggregateQuote> {
  return quoteAggregate(wallet.publicKey, wallet.address, harvestLinkItems(signer, probeLinks(linkCount)));
}

export interface MultisigSendResult {
  hash: string;
  bonded: boolean; // true = waiting for the other cosigners
}

const send = (wallet: CosignerWallet, items: AggregateItem[], feeSpeed?: FeeSpeed): Promise<MultisigSendResult> => sendAggregate({
  privateKey: wallet.privateKey, keyless: wallet.keyless, publicKey: wallet.publicKey, address: wallet.address,
  items, feeSpeed: feeSpeed ?? getDefaultFeeSpeed(),
});

/** Links and/or unlinks the multisig account's remote / VRF / node keys. */
export function changeHarvestKeysForMultisig(wallet: CosignerWallet, signer: AggregateSigner, links: HarvestLink[], feeSpeed?: FeeSpeed): Promise<MultisigSendResult> {
  if (links.length === 0) throw new SymbolSendError('nothing_to_change');
  return send(wallet, harvestLinkItems(signer, links), feeSpeed);
}

/** Links and/or unlinks the multisig account's voting keys. */
export function changeVotingKeysForMultisig(wallet: CosignerWallet, signer: AggregateSigner, links: VotingKeyLink[]): Promise<MultisigSendResult> {
  if (links.length === 0) throw new SymbolSendError('nothing_to_change');
  return send(wallet, votingLinkItems(signer, links));
}

/** Turns harvesting off for the multisig account by unlinking every key that is linked now. */
export function stopHarvestingForMultisig(wallet: CosignerWallet, signer: AggregateSigner, status: HarvestStatus): Promise<MultisigSendResult> {
  const links = unlinkAllLinks(status);
  if (links.length === 0) throw new SymbolSendError('nothing_linked');
  return send(wallet, harvestLinkItems(signer, links));
}

export interface MultisigStartResult extends MultisigSendResult {
  remotePrivateKey: string;
  vrfPrivateKey: string;
  /** Hash of the request sent to the node; null when it was not sent (the links wait for the other cosigners, or the request failed). */
  delegationHash: string | null;
  /** Why the request was not sent although the links were; null otherwise. */
  delegationError: unknown;
}

/**
 * Turns delegated harvesting on for the multisig account: links a new remote key, a new VRF key and the node, then (when the
 * links need no other cosigner) sends the node the encrypted request. When others must still sign, the links are not on the
 * chain yet, so the request cannot be sent now: the caller shows the new private keys so the request can be sent later
 * (the 「委任リクエストの再送」 form). The keys are never stored here: they belong to the multisig account, not to this wallet.
 */
export async function startHarvestingForMultisig(wallet: CosignerWallet, signer: AggregateSigner, nodePublicKey: string): Promise<MultisigStartResult> {
  const remote = newHarvestKeyPair();
  const vrf = newHarvestKeyPair();
  const sent = await send(wallet, harvestLinkItems(signer, [
    { kind: 'remote', publicKey: remote.publicKey, link: true },
    { kind: 'vrf', publicKey: vrf.publicKey, link: true },
    { kind: 'node', publicKey: nodePublicKey, link: true },
  ]));
  const result: MultisigStartResult = { ...sent, remotePrivateKey: remote.privateKey, vrfPrivateKey: vrf.privateKey, delegationHash: null, delegationError: null };
  if (sent.bonded) return result;
  try {
    const delegation = await sendHarvestDelegationRequest({
      privateKey: wallet.privateKey, keyless: wallet.keyless, publicKey: wallet.publicKey,
      nodePublicKey, remotePrivateKey: remote.privateKey, vrfPrivateKey: vrf.privateKey,
    });
    result.delegationHash = delegation.hash;
  } catch (e) {
    result.delegationError = e;
  }
  return result;
}
