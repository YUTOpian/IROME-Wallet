import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store/appStore';
import { WalletsHelper } from '../../lib/storage';
import { fetchBalances } from '../../lib/symbol/api';
import { findNftImage } from '../../lib/symbol/nftImage';
import type { NftImage } from '../../lib/symbol/nftImage';
import { getNetworkConfig } from '../../lib/symbol/network';
import { ImageError, processImage } from '../../theme/imageProcessing';
import type { ImageSlot } from '../../theme/customTheme';

// カスタムテーマの画像に、モザイクに紐づけられた画像（COMSA・NFT-Drive・ウクライナNFT・NEMber ART）を使う。
// 取り出しは、ホームの保有モザイクの画像表示と同じ（lib/symbol/nftImage.ts）。取り出した画像は、ファイルを選んだときと同じ processImage で
// 枠の大きさ・形式に「描き直して」から保存するので、テーマには元のモザイクへの参照は残らない（保存後はネットワークなしで表示できる）。
//   ・モザイクID（16桁）を入れて探す方法はない。持っているモザイクの中から、画像のあるものを一覧にして、そこから選ぶ。
//   ・プロファイルを開いていないとき（スタート画面など）は、持っているモザイクが分からないので、一覧は出せない（その旨を表示する）。

const SCAN_CONCURRENCY = 3;

interface Item { id: string; label: string; image: NftImage }

interface Props {
  open: boolean;
  slot: ImageSlot;
  onClose: () => void;
  /** 描き直した画像（data:URI）を渡す。入らないとき（テーマ全体の上限など）は、見せるメッセージを返す。入ったら null。 */
  onPicked: (uri: string) => string | null;
}

function Thumb({ item, onUse, disabled }: { item: Item; onUse: (item: Item) => void; disabled: boolean }) {
  return (
    <Box
      component="button" type="button" disabled={disabled} onClick={() => onUse(item)} title={item.label}
      sx={{
        p: 0, border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden', cursor: disabled ? 'default' : 'pointer', bgcolor: 'action.hover',
        width: 96, height: 96, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.6 : 1,
        '&:hover:not(:disabled)': { borderColor: 'primary.main' },
      }}
    >
      <img src={item.image.url} alt={item.label} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
    </Box>
  );
}

export default function MosaicImageDialog({ open, slot, onClose, onPicked }: Props) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const profileOpen = useAppStore((s) => s.activeProfileKey) !== null;
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [checked, setChecked] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const runRef = useRef(0);

  const scan = useCallback(async () => {
    runRef.current += 1;
    const run = runRef.current;
    setItems([]); setTotal(0); setChecked(0); setScanError(false);
    if (!profileOpen) { setScanning(false); return; }
    setScanning(true);
    try {
      const wallet = await WalletsHelper.getActive('symbol');
      if (!wallet) return;
      const currency = getNetworkConfig().currencyMosaicId;
      const targets = (await fetchBalances(wallet.address)).filter((b) => b.amount > 0n && b.id !== currency);
      if (run !== runRef.current) return;
      setTotal(targets.length);
      let next = 0;
      const worker = async () => {
        for (;;) {
          const b = targets[next];
          next += 1;
          if (!b) return;
          try {
            const image = await findNftImage(b.id);
            if (run !== runRef.current) return;
            if (image) setItems((cur) => [...cur, { id: b.id, label: b.name ?? b.id, image }]);
          } catch (e) {
            console.warn('NFT image lookup failed', b.id, e);
          }
          if (run === runRef.current) setChecked((n) => n + 1);
        }
      };
      await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, targets.length) }, worker));
    } catch (e) {
      console.warn('NFT scan failed', e);
      if (run === runRef.current) setScanError(true);
    } finally {
      if (run === runRef.current) setScanning(false);
    }
  }, [profileOpen]);

  // 開いたとき・ネットワーク（メインネット/テストネット）を切り替えたときに調べ直す。閉じたら、調べている途中のものは捨てる。
  useEffect(() => {
    if (!open) return undefined;
    setError('');
    void scan();
    return () => { runRef.current += 1; };
  }, [open, network, scan]);

  const use = async (item: Item) => {
    setError('');
    setApplying(true);
    try {
      const uri = await processImage(item.image.blob, slot);
      const message = onPicked(uri);
      if (message) setError(message);
      else onClose();
    } catch (e) {
      setError(t(`settings.custom_theme_image_error_${e instanceof ImageError ? e.code : 'decode'}`));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onClose={applying ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('settings.custom_theme_mosaic_title')}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{t('settings.custom_theme_mosaic_hint')}</Typography>
        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

        {profileOpen ? (
          <Box>
            <Typography sx={{ fontWeight: 'bold', mb: 0.5 }}>{t('settings.custom_theme_mosaic_mine')}</Typography>
            {scanning && (
              <Box sx={{ mb: 1 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('settings.custom_theme_mosaic_scanning', { done: checked, total })}</Typography>
                <LinearProgress variant={total > 0 ? 'determinate' : 'indeterminate'} value={total > 0 ? (checked / total) * 100 : 0} sx={{ mt: 0.5 }} />
              </Box>
            )}
            {scanError && <Alert severity="error">{t('settings.custom_theme_mosaic_load_error')}</Alert>}
            {!scanning && !scanError && items.length === 0 && <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('settings.custom_theme_mosaic_mine_none')}</Typography>}
            {items.length > 0 && (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {[...items].sort((a, b) => a.label.localeCompare(b.label)).map((it) => <Thumb key={it.id} item={it} onUse={(x) => void use(x)} disabled={applying} />)}
              </Box>
            )}
          </Box>
        ) : (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('settings.custom_theme_mosaic_need_profile')}</Typography>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        {applying && <CircularProgress size={18} sx={{ mr: 1 }} />}
        <Button onClick={onClose} disabled={applying}>{t('common.cancel')}</Button>
      </DialogActions>
    </Dialog>
  );
}
