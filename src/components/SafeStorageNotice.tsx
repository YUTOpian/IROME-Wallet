import { useState } from 'react';
import { Box, Button, Checkbox, CircularProgress, FormControlLabel, Typography } from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import { useTranslation } from 'react-i18next';
import IromeStage from './irome/IromeStage';
import OfficialProfileExportButton from './OfficialProfileExportButton';
import ErrorSnackbar from './ErrorSnackbar';
import type { Wallet } from '../lib/storage';
import { DisclaimerBox, cardSx } from './Disclaimer';

interface Props {
  // 完了: leaves for Home. Only enabled once the terms are accepted.
  onDone: () => void | Promise<void>;
  // 戻る: only shown when there is a sensible screen to go back to.
  onBack?: () => void;
  // 渡すと、このプロファイルを公式Symbolウォレット用に書き出す導線を出す。
  exportWalletId?: string | null;
  // まだ端末に保存していないプロファイルを書き出すとき用（保存は onDone で行う）。
  exportPending?: { wallets: Wallet[]; password: string };
}

// 「安全な保管の知識」: the last screen after creating or importing a profile (before Home) - how to keep the
// recovery phrase safe; the person confirms they understood it.
export default function SafeStorageNotice({ onDone, onBack, exportWalletId, exportPending }: Props) {
  const { t } = useTranslation();
  const [agreed, setAgreed] = useState(false);
  // 免責事項（ノンカストディアンのため、資金が流出しても開発者は責任を負わない）への同意。
  const [disclaimerAgreed, setDisclaimerAgreed] = useState(false);
  // 完了: プロファイルを保存する間（鍵の暗号化で少しかかる）は押せない。
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const done = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onDone();
    } catch (e) {
      console.error('SafeStorageNotice: finishing failed', e instanceof Error ? e.message : 'unknown error');
      setErrorMessage(t('wallet.creation_failed'));
      setBusy(false);
    }
  };
  const points = t('wallet.safe_points', { returnObjects: true }) as string[];

  return (
    <IromeStage showBack={false} title={t('wallet.safe_title')} maxWidth={560}>
      <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        {/* 1. 保管の知識 + 「理解しました」 */}
        <Box component="section" sx={cardSx}>
          <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 1.75 }}>
            {points.map((line, i) => (
              <Box key={i} component="li" sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25 }}>
                <CheckCircleOutlineIcon aria-hidden sx={{ flex: 'none', mt: '3px', fontSize: 20, color: 'primary.main' }} />
                <Typography component="span" sx={{ fontSize: 15, lineHeight: 1.8, minWidth: 0 }}>{line}</Typography>
              </Box>
            ))}
          </Box>
          <Box sx={{ mt: 2.5, pt: 1.5, borderTop: 1, borderColor: (th) => th.irome.line }}>
            <FormControlLabel
              sx={{ alignItems: 'flex-start', m: 0 }}
              control={<Checkbox sx={{ pt: 0.5 }} checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />}
              label={<Typography component="span" sx={{ fontWeight: 700, lineHeight: 1.7 }}>{t('wallet.safe_understood')}</Typography>}
            />
          </Box>
        </Box>

        {/* 2. 免責事項 + 同意 */}
        <DisclaimerBox>
          <FormControlLabel
            sx={{ alignItems: 'flex-start', m: 0 }}
            control={<Checkbox sx={{ pt: 0.5 }} checked={disclaimerAgreed} onChange={(e) => setDisclaimerAgreed(e.target.checked)} />}
            label={<Typography component="span" sx={{ fontWeight: 700, lineHeight: 1.7 }}>{t('wallet.disclaimer_agree')}</Typography>}
          />
        </DisclaimerBox>

        {/* 3. Symbol Wallet用の書き出し（任意） */}
        {exportWalletId || exportPending ? (
          <Box component="section" sx={{ ...cardSx, py: { xs: 2, md: 2.5 } }}>
            <OfficialProfileExportButton walletId={exportWalletId ?? null} pending={exportPending} compact />
          </Box>
        ) : null}
      </Box>

      {/* 戻る・完了: 書き出しカードの下に置く。 */}
      <Box sx={{ mt: 3, display: 'flex', justifyContent: { md: 'flex-end' }, gap: 1.5 }}>
        {onBack && (
          <Button variant="outlined" color="primary" size="large" disabled={busy} onClick={onBack} sx={{ minWidth: 120, flex: { xs: '1 1 0', md: '0 0 auto' } }}>
            {t('common.back')}
          </Button>
        )}
        <Button
          variant="contained" color="primary" size="large" disabled={!agreed || !disclaimerAgreed || busy} onClick={() => { void done(); }}
          sx={{ minWidth: 120, flex: { xs: '1 1 0', md: '0 0 auto' } }}
        >
          {busy ? <CircularProgress size={22} color="inherit" /> : t('common.done')}
        </Button>
      </Box>
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
    </IromeStage>
  );
}
