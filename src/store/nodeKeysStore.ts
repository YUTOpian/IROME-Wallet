// 「ノード」画面から「ハーベスト > キーリンク」へ渡す、ノードの公開鍵（ノード鍵・ハーベスト鍵（リモート）・VRF 鍵・投票鍵）。
// メモリにだけ置く（保存しない）。入っているのは公開鍵だけで、秘密鍵は、この画面にもエージェントにも届かない。
// 受け取った側は、入力欄に入れるだけ。リンクの送信は、いつもどおり、ハーベスト画面の確認とパスワードを通る。
import { create } from 'zustand';
import { isEpoch, isHex64 } from '../lib/node/nodeKeys';

export interface PendingNodeKeys {
  /** ノード鍵（NodeKeyLink）の公開鍵。64 文字・大文字 */
  node: string | null;
  /** ハーベスト鍵（リモート。AccountKeyLink）の公開鍵 */
  remote: string | null;
  /** VRF 鍵（VrfKeyLink）の公開鍵 */
  vrf: string | null;
  /** 投票鍵（VotingKeyLink）の公開鍵。64 文字・大文字（32 バイト） */
  voting: string | null;
  /** 投票鍵の有効なエポックの範囲（鍵の木のファイルのヘッダから分かったときだけ。無ければ null で、画面の既定値を使う） */
  votingStart: number | null;
  votingEnd: number | null;
}

interface NodeKeysState {
  pending: PendingNodeKeys | null;
  /** 公開鍵として正しい形のものだけを受け取る（形が違うものは null にする）。1 つも無ければ何も置かない。 */
  set: (keys: Partial<PendingNodeKeys>) => void;
  clear: () => void;
}

const clean = (v: string | null | undefined, ok: (s: string) => boolean): string | null => {
  const t = (v ?? '').trim();
  return ok(t) ? t.toUpperCase() : null;
};

export const useNodeKeysStore = create<NodeKeysState>((set) => ({
  pending: null,
  set: (keys) => {
    const pending: PendingNodeKeys = {
      node: clean(keys.node, isHex64),
      remote: clean(keys.remote, isHex64),
      vrf: clean(keys.vrf, isHex64),
      voting: clean(keys.voting, isHex64),
      votingStart: null,
      votingEnd: null,
    };
    if (pending.voting && isEpoch(keys.votingStart) && isEpoch(keys.votingEnd) && keys.votingEnd >= keys.votingStart) {
      pending.votingStart = keys.votingStart;
      pending.votingEnd = keys.votingEnd;
    }
    set({ pending: pending.node || pending.remote || pending.vrf || pending.voting ? pending : null });
  },
  clear: () => set({ pending: null }),
}));
