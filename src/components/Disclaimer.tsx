import type { ReactNode } from 'react';
import { alpha, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';
import GavelOutlinedIcon from '@mui/icons-material/GavelOutlined';
import { useTranslation } from 'react-i18next';

/** 「安全な保管の知識」画面で使う、角丸のカード。 */
export const cardSx: SxProps<Theme> = {
  p: { xs: 2.5, md: 3.5 }, borderRadius: '20px', border: 1, borderColor: (th) => th.irome.line,
  bgcolor: 'background.paper', boxShadow: (th) => th.irome.cardShadow, boxSizing: 'border-box',
};

/** The numbered points of the 免責事項 (wallet.disclaimer_points). Each number sits in a small badge, so wrapped lines stay aligned. */
export function DisclaimerPoints() {
  const { t } = useTranslation();
  const points = t('wallet.disclaimer_points', { returnObjects: true }) as string[];
  return (
    <Box component="ol" sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {points.map((line, i) => (
        <Box key={i} component="li" sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
          <Box
            aria-hidden
            sx={{
              flex: 'none', width: 22, height: 22, mt: '2px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, color: 'primary.main', bgcolor: (th) => alpha(th.palette.primary.main, 0.12),
            }}
          >
            {i + 1}
          </Box>
          <Typography component="span" sx={{ fontSize: 14, lineHeight: 1.75, minWidth: 0 }}>{line}</Typography>
        </Box>
      ))}
    </Box>
  );
}

/**
 * 免責事項: this wallet is non-custodial, so the developers / operators are not responsible for funds that
 * leave the account. Shown inline on the 「安全な保管の知識」 screen (must be agreed to) and as a dialog from
 * the welcome screen and the settings screen. `children` (the agreement checkbox) sit at the bottom of the card.
 */
export function DisclaimerBox({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Box component="section" sx={cardSx}>
      <Typography component="h2" sx={{ display: 'flex', alignItems: 'center', gap: 1, fontWeight: 700, fontSize: 17, mb: 2 }}>
        <GavelOutlinedIcon fontSize="small" sx={{ color: 'primary.main' }} />
        {t('wallet.disclaimer_title')}
      </Typography>
      <DisclaimerPoints />
      {children && <Box sx={{ mt: 2.5, pt: 1.5, borderTop: 1, borderColor: (th) => th.irome.line }}>{children}</Box>}
    </Box>
  );
}

export default function DisclaimerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" scroll="paper">
      <DialogTitle>{t('wallet.disclaimer_title')}</DialogTitle>
      <DialogContent dividers>
        <DisclaimerPoints />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
