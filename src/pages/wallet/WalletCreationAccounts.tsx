import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AccountSelectView } from './WalletLoginAccounts';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import { WalletsHelper } from '../../lib/storage';
import { profileAccounts } from '../../lib/accounts';
import { getPendingCreation, setPendingCreation } from '../../lib/pendingCreation';
import { setPendingProfile } from '../../lib/pendingProfile';
import type { ShownIndexes } from '../../lib/pendingImport';

// 新規作成の最後のステップ：ニーモニックの確認テストを通ったあとに、表示するアカウントを選ぶ。
// ここで「次へ」を押すと、鍵を導出してメモリ上にプロファイルを用意する。端末に保存するのは、次の「安全な保管の知識」画面で「完了」を押したとき。
export default function WalletCreationAccounts() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const pending = getPendingCreation();
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // After a reload (or when opened directly) the pending profile is gone: start over at the name screen.
  useEffect(() => {
    if (!pending) navigate('/wallet/creation/name', { replace: true });
  }, [pending, navigate]);

  if (!pending) return null;

  const buildProfile = async (indexes: ShownIndexes) => {
    const draft = getPendingCreation();
    if (!draft || saving) return;
    setSaving(true);
    try {
      setPendingCreation({ ...draft, shownIndexes: indexes });
      // Let the busy state paint before the (heavy) key derivation.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const accounts = profileAccounts(draft.phrase); // Symbol and NEM accounts of the same phrase
      const wallets = await WalletsHelper.createProfileWithMnemonic(draft.name, draft.phrase, draft.password, accounts, draft.indexZeroName);
      // 選んだインデックスだけを最初から表示する（残りは、あとからウォレット切り替え画面で表示できる）。
      for (const wallet of wallets) {
        if (wallet.accountIndex !== null) wallet.hidden = !indexes[wallet.chain].includes(wallet.accountIndex);
      }
      // 最初に開くのは、選んだチェーンの、表示されている中でいちばん小さいインデックス。
      const active = wallets
        .filter((w) => w.chain === draft.chain && !w.hidden)
        .sort((a, b) => (a.accountIndex ?? 0) - (b.accountIndex ?? 0))[0] ?? wallets[0];
      // ここでは端末に保存しない。「安全な保管の知識」画面で2つのチェックをして「完了」を押したときに保存する。
      setPendingProfile({ wallets, activeId: active.id, password: draft.password, chain: draft.chain });
      setSaving(false);
      navigate('/wallet/creation/end');
    } catch {
      setErrorMessage(t('wallet.creation_failed'));
      setSaving(false);
    }
  };

  return (
    <>
      <AccountSelectView
        phrase={pending.phrase}
        chain={pending.chain}
        initialShown={pending.shownIndexes ?? { symbol: [0], nem: [0] }}
        back="/wallet/creation/mnemonic"
        busy={saving}
        onNext={(indexes) => { void buildProfile(indexes); }}
      />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </>
  );
}
