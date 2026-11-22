// NEM (NIS1) の「マルチシグツリー」: マルチシグのアカウントと、その連署者の関係を、Symbol 版と同じ形（MultisigGraph）で返す。
//
// NIS1 では、マルチシグのアカウントを別のマルチシグの連署者にはできない（FAILURE_MULTISIG_ACCOUNT_CANNOT_BE_COSIGNER）。
// なので階層は1段だけ：「連署者 → マルチシグのアカウント」。1人の連署者が複数のマルチシグの連署者を兼ねることはある。
// 連署者の「削除」に必要な人数は NIS1 には無いので、minRemoval は使わない（0 のまま）。
import type { MultisigGraph, MultisigNodeInfo } from '../symbol/multisigTree';
import { normalizeNemAddress } from './crypto';
import { fetchNemMultisigInfo } from './multisigApi';
import type { NemMultisigInfo } from './multisigApi';

const leaf = (address: string): MultisigNodeInfo => ({ address, minApproval: 0, minRemoval: 0, cosignatories: [], isMultisig: false });

const multisigNode = (info: NemMultisigInfo): MultisigNodeInfo => ({
  address: info.address,
  // NIS1 では minCosignatories が 0 = 連署者全員の署名が必要
  minApproval: info.minCosignatories === 0 ? info.cosignatories.length : info.minCosignatories,
  minRemoval: 0,
  cosignatories: info.cosignatories.map((c) => c.address),
  isMultisig: true,
});

/**
 * `address` がマルチシグなら、それが最終のアカウント。連署者なら、連署している全てのマルチシグが最終のアカウント。
 * どちらでもなければ、そのアカウントだけ（ツリーは作らない）。
 */
export async function fetchNemTree(address: string): Promise<{ tops: string[]; graph: MultisigGraph }> {
  const root = normalizeNemAddress(address);
  const first = await fetchNemMultisigInfo(root);
  const infos = first.isMultisig ? [first] : await Promise.all(first.multisigOf.map((a) => fetchNemMultisigInfo(a.address)));

  const graph = new Map<string, MultisigNodeInfo>();
  const tops: string[] = [];
  for (const info of infos) {
    if (!info.isMultisig) continue;
    graph.set(info.address, multisigNode(info));
    if (!tops.includes(info.address)) tops.push(info.address);
  }
  for (const info of infos) {
    for (const c of info.cosignatories) if (!graph.has(c.address)) graph.set(c.address, leaf(c.address));
  }
  if (tops.length === 0) {
    graph.set(root, leaf(root));
    tops.push(root);
  }
  return { tops, graph };
}
