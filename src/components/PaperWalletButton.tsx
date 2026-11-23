import { useState } from 'react';
import { Box, Button, Checkbox, CircularProgress, FormControlLabel, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import { useTranslation } from 'react-i18next';
import { downloadPaperWallet } from '../lib/paperWalletExport';
import type { PaperWalletSource } from '../lib/paperWalletExport';
import { getNetwork } from '../lib/symbol/network';
import type { PublicNetwork } from '../lib/symbol/constants';

interface PaperWalletButtonProps {
  // What goes on the sheet. Nothing is rendered until the secret has been loaded (source = null).
  source: PaperWalletSource | null;
}

// "Download paper wallet": a IROME-designed card PDF with the recovery phrase / private key, the
// matching QR codes and the account's address, built on this device (see lib/paperWallet.ts).
// The person picks Mainnet or Testnet right before downloading; the sheet is printed for that network.
export default function PaperWalletButton({ source }: PaperWalletButtonProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Starts on the network the app is on (mijin v2 has no choice here - it falls back to mainnet).
  // Recovery-phrase sheet only: add the private key of each account the profile shows as page 2 onwards.
  const [withKeys, setWithKeys] = useState(true);
  const [network, setNetwork] = useState<PublicNetwork>(() => (getNetwork() === 'testnet' ? 'testnet' : 'mainnet'));

  if (source == null) return null;
  const accountCount = source.kind === 'mnemonic' ? source.accounts?.length ?? 0 : 0;

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await downloadPaperWallet(source.kind === 'mnemonic' ? { ...source, network, accounts: withKeys ? source.accounts : undefined } : { ...source, network });
    } catch (e) {
      // Never log the secret itself - only that something went wrong.
      console.error('PaperWalletButton: failed to build the paper wallet', e instanceof Error ? e.message : 'unknown error');
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    // One framed block: the network choice belongs to this paper wallet only (the buttons below it are separate).
    <Box
      component="section"
      aria-label={t('wallet.paper_wallet_title')}
      sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 4, mb: 1, mx: 2, p: 2, border: 1, borderColor: 'divider', borderRadius: '16px', bgcolor: 'rgba(255,255,255,0.55)' }}
    >
      <Typography align="center" sx={{ fontSize: 15, fontWeight: 700, mb: 1 }}>
        {t('wallet.paper_wallet_title')}
      </Typography>
      <Typography align="center" sx={{ color: 'text.secondary', fontSize: 13, mb: 2 }}>
        {t(source.kind === 'mnemonic' ? 'wallet.paper_wallet_hint_mnemonic' : 'wallet.paper_wallet_hint_key')}
      </Typography>
      <Typography align="center" sx={{ fontSize: 13, fontWeight: 600, mb: 0.75 }}>
        {t('wallet.paper_wallet_network')}
      </Typography>
      <ToggleButtonGroup
        exclusive
        size="small"
        color="primary"
        value={network}
        disabled={busy}
        onChange={(_, value: PublicNetwork | null) => {
          // Clicking the selected one again would unselect it; one of the two always stays chosen.
          if (value != null) setNetwork(value);
        }}
        aria-label={t('wallet.paper_wallet_network')}
        sx={{ mb: 0.75 }}
      >
        <ToggleButton value="mainnet" sx={{ minWidth: 120 }}>{t('wallet.paper_wallet_network_mainnet')}</ToggleButton>
        <ToggleButton value="testnet" sx={{ minWidth: 120 }}>{t('wallet.paper_wallet_network_testnet')}</ToggleButton>
      </ToggleButtonGroup>
      <Typography align="center" sx={{ color: 'text.secondary', fontSize: 12, mb: 2 }}>
        {t(network === 'mainnet' ? 'wallet.paper_wallet_network_hint_mainnet' : 'wallet.paper_wallet_network_hint_testnet')}
      </Typography>
      {accountCount > 0 && (
        <>
          <FormControlLabel
            sx={{ mx: 0, mb: 0.5 }}
            control={<Checkbox size="small" checked={withKeys} disabled={busy} onChange={(e) => setWithKeys(e.target.checked)} />}
            label={<Typography sx={{ fontSize: 13 }}>{t('wallet.paper_wallet_with_keys', { count: accountCount })}</Typography>}
          />
          <Typography align="center" sx={{ color: 'text.secondary', fontSize: 12, mb: 2 }}>
            {t(withKeys ? 'wallet.paper_wallet_with_keys_on' : 'wallet.paper_wallet_with_keys_off')}
          </Typography>
        </>
      )}
      <Button
        variant="outlined"
        color="primary"
        disabled={busy}
        onClick={onClick}
        startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <FileDownloadOutlinedIcon />}
        sx={{ minWidth: 260 }}
      >
        {busy ? t('wallet.paper_wallet_creating') : t('wallet.paper_wallet_download')}
      </Button>
      <Typography align="center" sx={{ color: 'text.secondary', fontSize: 12, mt: 1 }}>
        {t('wallet.paper_wallet_caution')}
      </Typography>
      {failed && (
        <Typography align="center" sx={{ color: 'error.main', fontSize: 13, mt: 1 }}>
          {t('wallet.paper_wallet_failed')}
        </Typography>
      )}
    </Box>
  );
}
