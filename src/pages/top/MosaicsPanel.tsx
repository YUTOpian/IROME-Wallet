import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Switch, Typography } from '@mui/material';
import SendOutlinedIcon from '@mui/icons-material/SendOutlined';
import AccountBalanceWalletOutlinedIcon from '@mui/icons-material/AccountBalanceWalletOutlined';
import { useTranslation } from 'react-i18next';
import { WalletsHelper } from '../../lib/storage';
import { fetchChainBalances, nativeAssetId } from '../../lib/chainApi';
import type { MosaicBalance } from '../../lib/symbol/api';
import { findNftImage } from '../../lib/symbol/nftImage';
import { useWatchOnly } from '../../hooks/useWatchOnly';
import { useAppStore } from '../../store/appStore';
import { cardRadius } from '../../theme/cardRadius';

// タイル右上に出す、モザイクに紐づけられた画像（オンチェーンNFT。取り出しは lib/symbol/nftImage.ts。読み込みは MosaicsPanel がまとめて行う）。
// 押すと、大きくしたものをポップアップで出す。
const TILE_IMAGE_SIZE = 64;
// 画像を確かめる同時の数（1つの画像で、ノードへ何度か問い合わせるため、絞る）。
const IMAGE_CHECK_CONCURRENCY = 3;

function MosaicTileImage({ url, title }: { url: string; title: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Box
        component="button"
        type="button"
        onClick={() => setOpen(true)}
        aria-label={title}
        title={title}
        sx={{
          flex: '0 0 auto', width: TILE_IMAGE_SIZE, height: TILE_IMAGE_SIZE, p: 0, m: 0, overflow: 'hidden', cursor: 'zoom-in',
          borderRadius: 1.5, border: 1, borderColor: 'divider', bgcolor: 'action.hover', display: 'block',
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
        }}
      >
        <Box component="img" src={url} alt="" draggable={false} sx={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} />
      </Box>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md">
        <DialogTitle sx={{ wordBreak: 'break-all' }}>{title}</DialogTitle>
        <DialogContent sx={{ display: 'flex', justifyContent: 'center' }}>
          <Box component="img" src={url} alt={title} sx={{ display: 'block', maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{t('common.close')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

// 「保有モザイク」: Home の同名リボンを押すと下に展開される、このアカウントが持っているモザイクの一覧。
// ネイティブ通貨（XYM / XEM）は残高0でも先頭に出し、そのほかは残高のあるものだけを出す。
// タイルで並べ（広さに応じて最大4列。並びきったら次の行へ）、名前（ネームスペース）の下にモザイクID（NEMは名前がIDそのものなので付けない）、各タイルの下に「送る」（そのモザイクが選ばれた状態で送る画面が開く）と「残高表示」（確認でOKを押すと、Home上部の残高カードにそのモザイクを表示する）のボタンがある。Symbol では、モザイクに画像（オンチェーンNFT）が紐づけられていれば、タイルの右上にその画像を出し、「画像ありのみ」のスイッチで画像のあるものだけに絞り込める（画像は開いたときにまとめて確かめる。押すとポップアップで大きく見られる。画像の有る無しでタイルの大きさが変わらないよう、Symbol ではこの段の高さを画像の分だけ常に確保する）。
export default function MosaicsPanel({ onShowOnBalanceCard, balanceHidden }: { onShowOnBalanceCard: (id: string) => void; balanceHidden: boolean }) {
  const { t } = useTranslation();
  const network = useAppStore((s) => s.network);
  const chain = useAppStore((s) => s.chain);
  const liveTick = useAppStore((s) => s.liveTick);
  const setHomePanel = useAppStore((s) => s.setHomePanel);
  const clearReceiverAddress = useAppStore((s) => s.clearReceiverAddress);
  const clearSendDraft = useAppStore((s) => s.clearSendDraft);
  const setSendMosaicId = useAppStore((s) => s.setSendMosaicId);
  // 閲覧用プロファイルには「送る」が無いので、押しても何も起きない。
  const watchOnly = useWatchOnly();
  const [list, setList] = useState<MosaicBalance[] | null>(null);
  const [failed, setFailed] = useState(false);
  // The mosaic whose 「残高表示」 was pressed, waiting for the OK of the confirmation.
  const [confirmMosaic, setConfirmMosaic] = useState<MosaicBalance | null>(null);
  // Symbol: モザイクに紐づけられた画像（モザイクID（大文字）→ blob: URL。画像が無い・取れなかったものは null。まだ確かめていないものはキーが無い）。
  const [images, setImages] = useState<Record<string, string | null>>({});
  // 「画像ありのみ」で絞り込むか。
  const [imageOnly, setImageOnly] = useState(false);
  const requestedImages = useRef<Set<string>>(new Set());
  // ネットワーク・チェーンを切り替えたら世代が変わり、前の世代の読み込みの結果は捨てる。
  const imageGeneration = useRef(0);
  // 一覧（list）を読んだときのチェーン・ネットワーク。切り替えた直後の、前のネットワークの一覧では画像を確かめない。
  const listOwner = useRef('');

  const load = useCallback(async () => {
    try {
      const owner = `${useAppStore.getState().chain}:${useAppStore.getState().network}`;
      const wallet = await WalletsHelper.getActive();
      if (!wallet) { listOwner.current = owner; setList([]); return; }
      const all = await fetchChainBalances(wallet.address);
      listOwner.current = owner;
      setList(all.filter((m) => m.id.toUpperCase() === nativeAssetId().toUpperCase() || m.amount > 0n));
      setFailed(false);
    } catch (e) {
      console.error('Failed to load the mosaics', e);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    setList(null);
    void load();
  }, [load, network, chain]);

  // The node reported something for this account: reload quietly.
  useEffect(() => {
    if (liveTick > 0) void load();
  }, [liveTick, load]);

  useEffect(() => {
    imageGeneration.current += 1;
    requestedImages.current = new Set();
    setImages({});
  }, [network, chain]);

  // 持っているモザイクの画像を、少しずつ（同時に IMAGE_CHECK_CONCURRENCY 個まで）確かめる。確かめ済みのものは読み直さない。
  // 絞り込み（画像ありのみ）にも、タイルの画像にも、この結果を使う。ネイティブ通貨（XYM）には画像が付かないので読まない。
  useEffect(() => {
    if (chain !== 'symbol' || list === null || listOwner.current !== `${chain}:${network}`) return;
    const native = nativeAssetId().toUpperCase();
    const todo = list.map((m) => m.id.toUpperCase()).filter((id) => id !== native && !requestedImages.current.has(id));
    if (todo.length === 0) return;
    todo.forEach((id) => requestedImages.current.add(id));
    const generation = imageGeneration.current;
    let next = 0;
    const worker = async () => {
      for (;;) {
        const id = todo[next];
        next += 1;
        if (id === undefined) return;
        let url: string | null = null;
        try {
          const image = await findNftImage(id);
          url = image ? image.url : null;
        } catch {
          requestedImages.current.delete(id); // 通信に失敗したときは、次に一覧を読み直したときにやり直す
        }
        if (imageGeneration.current !== generation) return;
        setImages((cur) => ({ ...cur, [id]: url }));
      }
    };
    void Promise.all(Array.from({ length: Math.min(IMAGE_CHECK_CONCURRENCY, todo.length) }, worker));
  }, [list, chain, network]);

  if (list === null && !failed) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>;
  }
  if (list === null) {
    return <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 3, px: 2 }}>{t('home.mosaics_failed')}</Typography>;
  }
  if (list.length === 0) {
    return <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 3, px: 2 }}>{t('home.mosaics_empty')}</Typography>;
  }

  // 画像ありのみの絞り込み（Symbol のみ）。確かめ終わっていないものは、画像が見つかるまで出さない。
  const nativeId = nativeAssetId().toUpperCase();
  const imageCandidates = chain === 'symbol' ? list.filter((m) => m.id.toUpperCase() !== nativeId) : [];
  const imagesChecked = imageCandidates.filter((m) => m.id.toUpperCase() in images).length;
  const imagesChecking = imagesChecked < imageCandidates.length;
  const showFilter = imageCandidates.length > 0;
  const visibleList = showFilter && imageOnly ? list.filter((m) => Boolean(images[m.id.toUpperCase()])) : list;

  // Opens 「送る」 as a fresh transfer (like the ribbon does) with this mosaic already chosen ('' = the currency).
  const sendMosaic = (m: MosaicBalance) => {
    clearReceiverAddress();
    clearSendDraft();
    setSendMosaicId(m.id.toUpperCase() === nativeAssetId().toUpperCase() ? '' : m.id);
    setHomePanel('send');
  };
  // The name on top of a card. Symbol: the mosaic's name (its namespace). NEM: the (child) namespace the mosaic belongs to - the part of
  // "namespace:name" before the colon - with the whole id under it; the currency shows its symbol (XEM), like XYM on Symbol.
  const titleOf = (m: MosaicBalance) => {
    if (chain !== 'nem' || m.id.toUpperCase() === nativeAssetId().toUpperCase()) return m.symbol;
    const cut = m.id.lastIndexOf(':');
    return cut > 0 ? m.id.slice(0, cut) : m.id;
  };
  // NEM: the send form only offers mosaics whose definition was read and that may be sent (see loadSendAssets).
  const canSend = (m: MosaicBalance) => {
    if (watchOnly) return false;
    if (chain !== 'nem' || m.id.toUpperCase() === nativeAssetId().toUpperCase()) return true;
    return m.supply !== undefined && m.transferable;
  };

  const sideButtonSx = { flex: '1 1 auto', justifyContent: 'center', textTransform: 'none', whiteSpace: 'nowrap', px: 1.5, py: 0.75, fontSize: '0.95rem', minWidth: 0 } as const;

  return (
    // タイルの列数は、この領域の広さに応じて 1〜4 列（最大 4 列。並びきったら次の行へ）。横に長い行にすると、名前とボタンが離れて見づらいため。
    <Box sx={{ containerType: 'inline-size' }}>
      {showFilter && (
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 2, px: 2, pt: 1.5 }}>
          <FormControlLabel
            control={<Switch size="small" checked={imageOnly} onChange={(e) => setImageOnly(e.target.checked)} />}
            label={t('home.mosaics_image_only')}
            slotProps={{ typography: { variant: 'body2' } }}
          />
          {imagesChecking && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('home.mosaics_image_checking', { done: imagesChecked, total: imageCandidates.length })}
            </Typography>
          )}
        </Box>
      )}
      {visibleList.length === 0 && (
        imagesChecking
          ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={24} /></Box>
          : <Typography sx={{ color: 'text.secondary', textAlign: 'center', py: 3, px: 2 }}>{t('home.mosaics_image_none')}</Typography>
      )}
      <Box
        sx={{
          display: 'grid',
          // auto-fill（auto-fit ではない）: 空の列も残すので、モザイクが 1 つでもタイルの幅は 1 行いっぱいのときと同じ。タイル 1 枚の最小幅は 210px で、4 列を超えては増やさない（隙間 12px × 3）。
          gridTemplateColumns: 'repeat(auto-fill, minmax(max(min(100%, 210px), calc((100% - 36px) / 4)), 1fr))',
          gap: 1.5,
          p: 2,
          textAlign: 'left',
        }}
      >
        {visibleList.map((m) => (
          <Box key={m.id} sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minWidth: 0, p: 1.75, border: 1, borderColor: 'divider', borderRadius: cardRadius, textAlign: 'left' }}>
            {/* 名前とIDの右に、モザイクに紐づけられた画像があれば表示する（Symbol のみ。ネイティブ通貨には無いので読まない）。 */}
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, minWidth: 0, ...(chain === 'symbol' ? { minHeight: TILE_IMAGE_SIZE } : {}) }}>
            <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
              <Typography noWrap title={titleOf(m)} sx={{ fontWeight: 'bold' }}>{titleOf(m)}</Typography>
              {/* The mosaic ID right under the name, on both chains (Symbol: the hex ID, also when the mosaic has no namespace; NEM: the full "namespace:name", e.g. "nem:xem"). */}
              <Typography noWrap variant="caption" title={m.id} sx={{ display: 'block', minHeight: '1.66em', color: 'text.secondary', fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>
                {m.id}
              </Typography>
            </Box>
            {images[m.id.toUpperCase()] && <MosaicTileImage url={images[m.id.toUpperCase()] as string} title={titleOf(m)} />}
            </Box>
            <Typography noWrap sx={{ fontSize: '1.35rem', fontWeight: 'bold', lineHeight: 1.2, color: 'text.secondary' }}>
              {balanceHidden ? '••••••' : Number(m.balance).toLocaleString(undefined, { maximumFractionDigits: m.divisibility })}
            </Typography>
            {/* 送る / 残高表示: タイルの下に横並び（幅が足りなければ折り返す）。 */}
            <Box sx={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 0.75, mt: 'auto' }}>
              {!watchOnly && (
                <Button variant="outlined" size="medium" startIcon={<SendOutlinedIcon />} disabled={!canSend(m)} onClick={() => sendMosaic(m)} sx={sideButtonSx}>
                  {t('home.send')}
                </Button>
              )}
              <Button variant="outlined" size="medium" startIcon={<AccountBalanceWalletOutlinedIcon />} onClick={() => setConfirmMosaic(m)} sx={sideButtonSx}>
                {t('home.balance_show')}
              </Button>
            </Box>
          </Box>
        ))}
      </Box>

      <Dialog open={confirmMosaic !== null} onClose={() => setConfirmMosaic(null)}>
        <DialogTitle>{t('home.balance_show_confirm')}</DialogTitle>
        <DialogActions>
          <Button onClick={() => setConfirmMosaic(null)}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            onClick={() => {
              if (confirmMosaic) onShowOnBalanceCard(confirmMosaic.id.toUpperCase() === nativeAssetId().toUpperCase() ? '' : confirmMosaic.id);
              setConfirmMosaic(null);
            }}
          >
            {t('common.ok')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
