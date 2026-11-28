import { Alert, MenuItem } from '@mui/material';
import { useTranslation } from 'react-i18next';
import TextField from './TextField';
import type { CosignAccounts } from '../hooks/useCosignAccounts';
import { prettyAddress } from '../lib/symbol/crypto';

interface Props {
  accounts: CosignAccounts;
  /** Called after another account was picked (the screen clears what depended on the previous one). */
  onPick?: () => void;
  /** Formatted XYM held back by the hash lock; shown when the chosen account needs other cosigners. */
  lockText?: string | null;
  /** Only the notices (own account is multisig / needs other cosigners), not the dropdown: for a screen that puts the dropdown elsewhere (the sender row). */
  alertsOnly?: boolean;
}

// 「実行するアカウント」: this wallet's own account, or a multisig account it cosigns for. Nothing is shown when the wallet cosigns for none.
export default function CosignAccountPicker({ accounts, onPick, lockText, alertsOnly = false }: Props) {
  const { t } = useTranslation();
  const { accountAddr, setAccountAddr, signer, signers, ownAddress, selfIsMultisig } = accounts;
  return (
    <>
      {!alertsOnly && (signers.length > 0 || accountAddr !== '') && (
        <TextField
          select
          label={t('cosign_account.label')}
          // 初期値は「このウォレット」。空文字のままだと、選ばれていても枠が空白に見えるので、自分のアドレスを値にする。
          value={accountAddr || ownAddress}
          onChange={(e) => { setAccountAddr(e.target.value === ownAddress ? '' : e.target.value); onPick?.(); }}
          fullWidth
          sx={{ mb: 2 }}
        >
          <MenuItem value={ownAddress}>{t('cosign_account.self', { address: ownAddress ? prettyAddress(ownAddress) : '' })}</MenuItem>
          {signers.map((x) => <MenuItem key={x.address} value={x.address}>{t('cosign_account.multisig', { address: prettyAddress(x.address) })}</MenuItem>)}
        </TextField>
      )}
      {selfIsMultisig && !signer && <Alert severity="warning" sx={{ mb: 2 }}>{t('cosign_account.self_is_multisig')}</Alert>}
      {signer && !signer.selfSufficient && lockText && <Alert severity="info" sx={{ mb: 2 }}>{t('cosign_account.bonded_notice', { lock: lockText })}</Alert>}
    </>
  );
}
