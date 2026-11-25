import { useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { AggregateUriError, parseAggregateUri } from '../../lib/symbol/aggregateUri';
import { MAX_AGGREGATE_INNER } from '../../lib/symbol/aggregate';
import type { AggregateItem } from '../../lib/symbol/aggregate';

interface Props {
  open: boolean;
  onClose: () => void;
  wallet: { address: string; publicKey: string } | null;
  /** How many items the draft already holds (the imported ones are added after them). */
  existing: number;
  onImport: (items: AggregateItem[]) => void;
}

/**
 * 「トランザクションURIのインポート」 popup of the aggregate screen: paste the web+symbol://transaction URI of an
 * aggregate and its transactions are added to the draft. Nothing is signed or sent: the cost is quoted again and
 * the confirm screen shows everything, as for items typed by hand.
 */
export default function AggregateUriImportDialog({ open, onClose, wallet, existing, onImport }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const close = () => { setText(''); setError(''); onClose(); };

  const load = async () => {
    if (!wallet) return;
    setBusy(true);
    setError('');
    try {
      const items = await parseAggregateUri(text, wallet);
      if (existing + items.length > MAX_AGGREGATE_INNER) throw new AggregateUriError('too_many');
      onImport(items);
      setText('');
      onClose();
    } catch (e) {
      if (e instanceof AggregateUriError) {
        setError(t(`aggregate_uri.error_${e.code}`, { detail: e.detail, max: MAX_AGGREGATE_INNER }));
      } else {
        console.error('Failed to read the aggregate transaction URI', e);
        setError(t('aggregate_uri.error_invalid'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm">
      <DialogTitle sx={{ fontWeight: 'bold' }}>{t('aggregate_uri.import_title')}</DialogTitle>
      <DialogContent>
        <Typography sx={{ color: 'text.secondary', fontSize: 12, mb: 1.5 }}>{t('aggregate_uri.import_hint')}</Typography>
        <TextField
          fullWidth
          multiline
          minRows={4}
          maxRows={10}
          value={text}
          onChange={(e) => { setText(e.target.value); setError(''); }}
          placeholder="web+symbol://transaction?data=…"
          slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 12 } }, htmlInput: { 'aria-label': t('aggregate_uri.import_title'), spellCheck: false } }}
        />
        {error !== '' && <Alert severity="error" sx={{ mt: 1.5 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>{t('common.close')}</Button>
        <Button variant="contained" disabled={busy || text.trim() === '' || !wallet} onClick={() => { void load(); }}>{t('txuri.load_ok')}</Button>
      </DialogActions>
    </Dialog>
  );
}
