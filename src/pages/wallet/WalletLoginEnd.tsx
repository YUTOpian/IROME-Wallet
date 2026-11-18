import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WalletsHelper } from '../../lib/storage';
import { markBackupDone } from '../../lib/onboarding';
import { clearPendingImport } from '../../lib/pendingImport';
import { getPendingProfile, saveProfile } from '../../lib/pendingProfile';
import { useAppStore } from '../../store/appStore';
import SafeStorageNotice from '../../components/SafeStorageNotice';

// After an import: the safe-storage notice, then Home. 戻る (to the name / password screen) only while the profile is
// not saved yet; an already saved profile (official import) has nothing to go back to.
// A phrase / keystore import is NOT on the device yet: it is saved only when the person ticks both boxes and presses 完了.
// An imported Symbol Wallet (official) profile is already saved by its dialog, so there is nothing to save here.
export default function WalletLoginEnd() {
  const navigate = useNavigate();
  const setAppChain = useAppStore((s) => s.setChain);
  const setAppNetwork = useAppStore((s) => s.setNetwork);
  const pending = getPendingProfile();
  const [walletId, setWalletId] = useState<string | null>(null);
  useEffect(() => {
    if (pending) return;
    (async () => { setWalletId((await WalletsHelper.getActive())?.id ?? null); })();
  }, [pending]);
  return <SafeStorageNotice
    exportWalletId={pending ? null : walletId}
    exportPending={pending ? { wallets: pending.wallets, password: pending.password } : undefined}
    // まだ保存していないので、名前・パスワードの画面に戻れる。公式ウォレットから取り込み済み（保存済み）のときは戻る先がない。
    onBack={pending ? () => navigate('/wallet/login/name') : undefined}
    onDone={async () => {
      let profileKey: string;
      if (pending) {
        profileKey = (pending.wallets.find((w) => w.id === pending.activeId) ?? pending.wallets[0]).profileKey;
        await saveProfile(pending);
        setAppChain(pending.chain);
        if (pending.network) setAppNetwork(pending.network);
        clearPendingImport();
      } else {
        profileKey = (await WalletsHelper.getActive())?.profileKey ?? '';
      }
      // An imported profile came from its phrase / key, so there is nothing new to back up.
      try { markBackupDone(profileKey); } catch { /* reminder stays */ }
      navigate('/top', { replace: true });
    }}
  />;
}
