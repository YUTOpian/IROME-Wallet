import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import SafeStorageNotice from '../../components/SafeStorageNotice';
import { clearPendingCreation } from '../../lib/pendingCreation';
import { getPendingProfile, saveProfile } from '../../lib/pendingProfile';
import { markBackupDone } from '../../lib/onboarding';
import { markProfileFresh } from '../../lib/loginLock';
import { useAppStore } from '../../store/appStore';

// After the recovery phrase screen: the safe-storage notice, then Home. The profile is NOT on the device yet:
// it is saved only when the person ticks both boxes and presses 完了 here (the PIN was set on the name screen,
// the phrase was shown and confirmed on the mnemonic screen, the accounts were picked on the accounts screen).
export default function WalletCreationEnd() {
  const navigate = useNavigate();
  const setAppChain = useAppStore((s) => s.setChain);
  const setAppNetwork = useAppStore((s) => s.setNetwork);
  const pending = getPendingProfile();
  // After a reload (or when opened directly) the unsaved profile is gone: start over at the name screen.
  useEffect(() => {
    if (!pending) navigate('/wallet/creation/name', { replace: true });
  }, [pending, navigate]);
  if (!pending) return null;
  return (
    <SafeStorageNotice
      exportPending={{ wallets: pending.wallets, password: pending.password }}
      onBack={() => navigate(-1)}
      onDone={async () => {
        const active = pending.wallets.find((w) => w.id === pending.activeId) ?? pending.wallets[0];
        await saveProfile(pending);
        if (pending.network) setAppNetwork(pending.network);
        setAppChain(pending.chain);
        // The phrase was shown and the quiz passed: this profile counts as backed up.
        try { markBackupDone(active.profileKey); } catch { /* reminder stays */ }
        // 作ったばかりで、パスワードはいま入力した。起動設定が「前回のプロファイル」でも、ホームでもう一度は求めない。
        markProfileFresh(active.profileKey);
        clearPendingCreation();
        navigate('/top', { replace: true });
      }}
    />
  );
}
