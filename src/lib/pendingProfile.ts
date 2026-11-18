// 「安全な保管の知識」画面で「完了」を押すまで端末に保存しない、作りかけのプロファイル。
// 鍵の導出と暗号化まで済んだウォレットをメモリにだけ持ち、完了を押したときに saveProfile() ではじめて保存する。
// ページを再読み込みすると消える（画面は最初に戻る）。
import { WalletsHelper } from './storage';
import type { Wallet } from './storage';
import type { ChainKey } from './chain';

export interface PendingProfile {
  wallets: Wallet[];
  /** 保存したあとに、最初に開くアカウントの id。 */
  activeId: string;
  /** このプロファイルのパスワード（各アカウントの暗号化に使ったもの）。 */
  password: string;
  /** 保存したあとに、アプリで開くチェーン。 */
  chain: ChainKey;
  /** 保存したあとに切り替えるネットワーク（指定がなければ今のまま）。 */
  network?: 'mainnet' | 'testnet';
}

let pending: PendingProfile | null = null;

export function setPendingProfile(next: PendingProfile): void {
  pending = next;
}

export function getPendingProfile(): PendingProfile | null {
  return pending;
}

export function clearPendingProfile(): void {
  pending = null;
}

/** 作りかけのプロファイルを端末に保存する。保存できたらメモリから消す。 */
export async function saveProfile(profile: PendingProfile): Promise<void> {
  await WalletsHelper.addProfile(profile.wallets, profile.activeId, profile.password);
  clearPendingProfile();
}
