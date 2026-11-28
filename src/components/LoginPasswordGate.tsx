import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../lib/storage';
import { isLoginUnlocked, markLoginUnlocked } from '../lib/loginLock';
import { getStartupTarget } from '../lib/startupSetting';
import PasswordDialog from './PasswordDialog';

// パスワードを求めない画面。スタート画面とプロファイル選択画面は、どのプロファイルも開いていない（プロファイルの名前が見えるだけ）。
// プロファイル選択では、プロファイルを選んだときに WalletSelect がパスワードを求める。
// 新しいプロファイルを作る・取り込む画面も、まだどのプロファイルも開いていない（「パスワードを忘れた」からプロファイル選択へ来て、
// 新規プロファイルを作る人が、前回のプロファイルのパスワードを求められないように）。
const UNGATED_PATHS = new Set([
  '/welcome',
  '/wallet/select',
  '/wallet/new',
  '/wallet/watch',
  '/wallet/ledger',
  '/wallet/sss',
  '/wallet/creation/name',
  '/wallet/creation/mnemonic',
  '/wallet/creation/accounts',
  '/wallet/creation/new',
  '/wallet/creation/end',
  '/wallet/login/import',
  '/wallet/login/accounts',
  '/wallet/login/name',
  '/wallet/login/end',
]);

/**
 * 設定「起動時の画面」がホーム画面（'last'）のとき、前回のプロファイルのホーム画面へ直接入るので、プロファイル選択を通らない。
 * そのとき、まだパスワードを入力していなければ、開いたホーム画面の上にポップアップでパスワードを求める。
 * ポップアップの外を押す・戻る・「パスワードを忘れた／プロファイル選択へ」・入力ミスの上限のときは、プロファイル選択画面へ移る（パスワードは通らない）。
 * 起動時の画面がスタート画面・プロファイル選択画面のときは、ここでは何も求めない（プロファイルを選ぶときに求める）。
 * 閲覧用・Ledger・SSS のプロファイル（守る鍵が無い）では何もしない。
 */
export default function LoginPasswordGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const ungated = UNGATED_PATHS.has(location.pathname);
  // 入力が要るプロファイルのキー。要らないときは null。
  const [askKey, setAskKey] = useState<string | null>(null);

  useEffect(() => {
    if (ungated || getStartupTarget() !== 'last') {
      setAskKey(null);
      return;
    }
    let cancelled = false;
    (async () => {
      let next: string | null = null;
      try {
        const wallet = await WalletsHelper.getActiveAny();
        if (wallet && !wallet.keyless && !isLoginUnlocked(wallet.profileKey)) {
          next = wallet.profileKey;
        }
      } catch (e) {
        // 確認できないときに、パスワードを素通りさせない。
        console.error('LoginPasswordGate: failed to check the profile password state', e);
        next = '';
      }
      if (!cancelled) setAskKey(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [location.pathname, ungated]);

  return (
    <>
      {children}
      <PasswordDialog
        open={askKey !== null}
        mode="check"
        popup
        profileKey={askKey || undefined}
        onClose={() => {}}
        onCancel={() => navigate('/wallet/select', { replace: true })}
        cancelLabel={t('wallet.login_password_forgot')}
        onPass={() => {
          if (askKey) markLoginUnlocked(askKey);
          setAskKey(null);
        }}
      />
    </>
  );
}
