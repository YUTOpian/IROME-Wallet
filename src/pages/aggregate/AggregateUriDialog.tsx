import { useEffect, useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import { buildAggregateUri } from '../../lib/symbol/aggregateUri';
import type { AggregateItem } from '../../lib/symbol/aggregate';
import type { FeeSpeed } from '../../lib/symbol/feeSpeed';
import { TX_URI_QR_MAX_LENGTH } from '../../lib/symbol/txUri';
import { cardRadius } from '../../theme/cardRadius';

interface Props {
  open: boolean;
  onClose: () => void;
  items: AggregateItem[];
  wallet: { address: string; publicKey: string } | null;
  feeSpeed: FeeSpeed;
}

/**
 * 「トランザクションURI」 popup of the aggregate screen: the items put together so far, as an unsigned
 * web+symbol://transaction URI (text, copy, QR). Whoever opens it - this wallet, another Symbol wallet - reviews
 * and signs it themselves.
 */
export default function AggregateUriDialog({ open, onClose, items, wallet, feeSpeed }: Props) {
  const { t } = useTranslation();
  const [uri, setUri] = useState('');
  const [bonded, setBonded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  const itemsKey = items.map((i) => i.uid).join(',');

  // Built only while the popup is open, and again whenever the items or the fee level change.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setCopied(false);
    setUri('');
    setFailed(false);
    (async () => {
      try {
        if (!wallet || items.length === 0) throw new Error('nothing_to_build');
        const built = await buildAggregateUri({ signerPublicKey: wallet.publicKey, ownerAddress: wallet.address, items, feeSpeed });
        if (cancelled) return;
        setUri(built.uri);
        setBonded(built.bonded);
      } catch (e) {
        console.error('Failed to build the aggregate transaction URI', e);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, itemsKey, wallet?.publicKey, feeSpeed]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
    } catch (e) {
      console.error('Failed to copy the transaction URI', e);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ fontWeight: 'bold' }}>{t('aggregate_uri.title')}</DialogTitle>
      <DialogContent>
        <Typography sx={{ color: 'text.secondary', fontSize: 12, mb: 1.5 }}>{t('aggregate_uri.hint', { count: items.length })}</Typography>
        {items.length === 0 && <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>{t('aggregate_uri.empty')}</Typography>}
        {items.length > 0 && failed && <Typography sx={{ color: 'error.main', fontSize: 13 }}>{t('aggregate_uri.build_failed')}</Typography>}
        {items.length > 0 && !failed && uri === '' && <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>{t('common.loading')}</Typography>}
        {uri !== '' && (
          <>
            <Box sx={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', maxHeight: 160, overflowY: 'auto', p: 1, borderRadius: cardRadius, bgcolor: 'action.hover', userSelect: 'all' }}>
              {uri}
            </Box>
            <Button size="small" sx={{ mt: 1 }} onClick={onCopy}>{copied ? t('txuri.copied') : t('txuri.copy')}</Button>
            {uri.length <= TX_URI_QR_MAX_LENGTH ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1.5 }}>
                <Box sx={{ bgcolor: '#fff', p: 1.5, borderRadius: cardRadius, lineHeight: 0 }}>
                  <QRCodeSVG value={uri} size={220} level="L" />
                </Box>
              </Box>
            ) : (
              <Typography sx={{ color: 'text.secondary', fontSize: 12, mt: 1 }}>{t('txuri.qr_too_long')}</Typography>
            )}
            <Typography sx={{ color: 'text.secondary', fontSize: 11, mt: 1.5 }}>{t(bonded ? 'aggregate_uri.deadline_note_bonded' : 'txuri.deadline_note')}</Typography>
            {bonded && <Typography sx={{ color: 'text.secondary', fontSize: 11, mt: 0.5 }}>{t('aggregate_uri.bonded_note')}</Typography>}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
