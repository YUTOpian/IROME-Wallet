import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import TextField from '../../components/TextField';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BackButton from '../../components/BackButton';
import ErrorSnackbar from '../../components/ErrorSnackbar';
import MessageDialog from '../../components/MessageDialog';
import PasswordDialog from '../../components/PasswordDialog';
import { SocialAvatar } from '../../components/SocialMetadataView';
import { fieldBoxSx } from '../../components/fieldBox';
import { WalletsHelper } from '../../lib/storage';
import type { Wallet } from '../../lib/storage';
import { explorerTxUrl, fetchBalances, fetchMetadataValue, quoteMetadataFee, setMetadata } from '../../lib/symbol/api';
import { quoteAggregate, sendAggregate } from '../../lib/symbol/aggregateApi';
import type { AggregateQuote } from '../../lib/symbol/aggregateApi';
import CosignAccountPicker from '../../components/CosignAccountPicker';
import { SectionCard } from '../multisig/parts';
import { useCosignAccounts } from '../../hooks/useCosignAccounts';
import { getDefaultFeeSpeed } from '../../lib/symbol/feeSpeed';
import { formatAtomic } from '../../lib/symbol/amount';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL } from '../../lib/symbol/constants';
import { encodeValue } from '../../lib/symbol/metadata';
import { getNetworkConfig } from '../../lib/symbol/network';
import {
  SOCIAL_FIELD_MAX, SOCIAL_METADATA_KEY, SOCIAL_METADATA_KEY_TEXT, clearSocialMetadataCache, fetchSocialMetadata, sameSocialMetadata,
  serializeSocialMetadata, validateSocialMetadata,
} from '../../lib/symbol/socialMetadata';
import type { SocialMetadata } from '../../lib/symbol/socialMetadata';
import { useAppStore } from '../../store/appStore';
import { showTxNotice } from '../../store/txNoticeStore';
import { classifyError } from '../metadata/MetadataPage';

interface Props {
  /** ダイアログの中に出す（画面いっぱいのレイアウトにしない）。 */
  embedded?: boolean;
  /** メタデータを付けるアカウント。省略するとアクティブなアカウント。 */
  account?: Wallet;
  onClose?: () => void;
  /** 送信したあと（アカウント画面が読み直すため）。 */
  onSent?: () => void;
}

const EMPTY: SocialMetadata = { url: '', name: '', imageUrl: '', namespace: '' };

// 「ソーシャルメタデータ」の設定: アドレスに、その人の SNS などの URL・名前・アイコン画像・ネームスペースを登録する。
// 登録先は自分のアドレスのメタデータ（キー social_meta_data、値は JSON）。取引の相手が URL から「誰のアドレスか」を確かめられる。
export default function SocialMetadataEditor({ embedded = false, account, onClose, onSent }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const network = useAppStore((s) => s.network);
  const netCfg = getNetworkConfig(network);

  // The account the metadata is for: this wallet's own, or a multisig account it cosigns for (sent inside an aggregate this wallet signs).
  const accounts = useCosignAccounts(account);
  const { accountAddr, signer } = accounts;
  const [aggQuote, setAggQuote] = useState<AggregateQuote | null>(null);
  const [address, setAddress] = useState('');
  const [current, setCurrent] = useState<SocialMetadata | null | 'loading' | 'failed'>('loading');
  const [form, setForm] = useState<SocialMetadata>(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<keyof SocialMetadata, boolean>>>({});
  const [foreign, setForeign] = useState(false); // social_meta_data に、この形式でない値が入っている

  const [txFee, setTxFee] = useState<bigint | null>(null);
  const [xymBalance, setXymBalance] = useState<bigint | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [sendError, setSendError] = useState<{ kind: string; detail: string } | null>(null);

  // アカウントのアドレスと、いま登録されている内容（フォームの初期値）。
  useEffect(() => {
    let cancelled = false;
    if (!accounts.ready) return undefined;
    setCurrent('loading');
    setForeign(false);
    (async () => {
      const wallet = account ?? await WalletsHelper.getActive();
      if (!wallet || cancelled) return;
      const owner = accountAddr || wallet.address;
      setAddress(owner);
      // The multisig account pays nothing itself: the fee and the hash lock come from this wallet.
      const balances = await fetchBalances(wallet.address).catch(() => null);
      if (!cancelled && balances) setXymBalance(balances.find((b) => b.id === netCfg.currencyMosaicId)?.amount ?? 0n);
      try {
        const existing = await fetchSocialMetadata(owner);
        if (cancelled) return;
        setCurrent(existing);
        setForm(existing ? { ...existing } : EMPTY);
        if (!existing) setForeign(await hasForeignValue(owner));
      } catch {
        if (!cancelled) setCurrent('failed');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, network, accountAddr, accounts.ready]);

  const errors = useMemo(() => validateSocialMetadata(form), [form]);
  const valid = Object.values(errors).every((e) => e === null);
  const unchanged = typeof current === 'object' && current !== null && sameSocialMetadata(current, normalize(form));
  const canUpdate = valid && !unchanged && current !== 'loading' && current !== 'failed' && address !== '' && !accounts.blocked;
  const valueText = valid ? serializeSocialMetadata(form) : '';

  // 手数料: 値の大きさ（いま付いている値と新しい値の大きいほう）で決まる。
  const newLength = valid ? encodeValue(valueText).length : 0;
  const oldLength = current !== null && typeof current === 'object' ? encodeValue(serializeSocialMetadata(current)).length : 0;
  useEffect(() => {
    let cancelled = false;
    setTxFee(null);
    setAggQuote(null);
    if (!valid) return undefined;
    if (signer) {
      // A multisig account: the entry travels inside an aggregate signed by this wallet (bonded when others must cosign).
      const wal = account ? Promise.resolve(account) : WalletsHelper.getActive();
      wal.then((w) => (w ? quoteAggregate(w.publicKey, w.address, [{
        uid: 'meta', kind: 'metadata', signer, target: { type: 'account' }, key: 0n, oldValue: new Uint8Array(0), newValue: new Uint8Array(Math.max(newLength, oldLength)),
      }]) : null)).then((q) => {
        if (cancelled || !q) return;
        setAggQuote(q);
        setTxFee(q.fees[getDefaultFeeSpeed()].fee + q.lockFees[getDefaultFeeSpeed()]);
      }).catch(() => { /* shown as unavailable */ });
    } else {
      quoteMetadataFee('account', [Math.max(newLength, oldLength)])
        .then((q) => { if (!cancelled) setTxFee(q.fee); })
        .catch(() => { /* shown as unavailable */ });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid, newLength, oldLength, network, signer]);

  const xym = (amount: bigint) => `${formatAtomic(amount, CURRENCY_DIVISIBILITY)} ${CURRENCY_SYMBOL}`;
  const balanceShort = txFee !== null && xymBalance !== null && xymBalance < txFee + (aggQuote ? aggQuote.lockAmount : 0n);

  const set = (field: keyof SocialMetadata) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const blur = (field: keyof SocialMetadata) => () => setTouched((x) => ({ ...x, [field]: true }));
  const errorText = (field: keyof SocialMetadata): string => {
    const e = errors[field];
    if (e === null || (!touched[field] && form[field] === '')) return '';
    return t(`social.error_${e}`, { max: SOCIAL_FIELD_MAX[field] });
  };

  const onBack = () => { if (embedded) onClose?.(); else navigate(-1); };

  const onPassed = async (password: string) => {
    if (!valid) return;
    setSending(true);
    try {
      const wallet = account ?? await WalletsHelper.getActive();
      if (!wallet) return;
      const privateKey = wallet.sss && signer ? '' : await WalletsHelper.decryptKey(wallet.id, password);
      if (privateKey == null) {
        setErrorMessage(t('wallet.invalid_key'));
        return;
      }
      if (signer) {
        // The multisig account is the source of its own metadata, so its approval is collected through the aggregate.
        const oldValue = await fetchMetadataValue({ type: 'account', address: signer.address, sourceAddress: signer.address }, SOCIAL_METADATA_KEY);
        const sentAgg = await sendAggregate({
          privateKey, keyless: wallet.sss ? { kind: 'sss' } : undefined, publicKey: wallet.publicKey, address: wallet.address,
          items: [{ uid: 'meta', kind: 'metadata', signer, target: { type: 'account' }, key: SOCIAL_METADATA_KEY, oldValue, newValue: encodeValue(valueText) }],
          feeSpeed: getDefaultFeeSpeed(),
        });
        clearSocialMetadataCache(signer.address);
        const lines = t(sentAgg.bonded ? 'metadata.done_bonded_message' : 'social.done_message', { returnObjects: true }) as string[];
        showTxNotice({
          lines: sentAgg.bonded ? [...lines, t('metadata.done_bonded_hint')] : lines,
          explorerUrl: explorerTxUrl(sentAgg.hash),
          explorerLabel: t('metadata.view_explorer'),
        });
        setCurrent(normalize(form));
        onSent?.();
        if (embedded) onClose?.();
        return;
      }
      const sent = await setMetadata({
        privateKey,
        publicKey: wallet.publicKey,
        address: wallet.address,
        target: { type: 'account' },
        items: [{ key: SOCIAL_METADATA_KEY, value: encodeValue(valueText) }],
      });
      clearSocialMetadataCache(wallet.address);
      showTxNotice({
        lines: t('social.done_message', { returnObjects: true }) as string[],
        explorerUrl: explorerTxUrl(sent.hash),
        explorerLabel: t('metadata.view_explorer'),
      });
      setCurrent(normalize(form));
      onSent?.();
      if (embedded) onClose?.();
    } catch (error) {
      setSendError(classifyError(error));
    } finally {
      setSending(false);
    }
  };

  const rootSx: SxProps<Theme> = embedded ? { display: 'flex', flexDirection: 'column' } : { minHeight: '100vh', display: 'flex', flexDirection: 'column' };
  const previewMeta: SocialMetadata = normalize(form);
  const errorTitle = sendError ? t(`metadata.error_${sendError.kind}_title`) : '';
  const errorTexts = sendError ? (t(`metadata.error_${sendError.kind}_message`, { returnObjects: true, detail: sendError.detail }) as string[]) : [];

  return (
    <Box sx={rootSx}>
      {!embedded && <BackButton onBack={onBack} back="/account" />}
      <Box sx={{ flexGrow: 1, width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left', maxWidth: 640, mx: 'auto' }}>
        {!embedded && <Typography sx={{ fontWeight: 'bold', fontSize: '1.3rem', mb: 1 }}>{t('social.title')}</Typography>}
        <Alert severity="info" sx={{ mb: 2 }}>{t('social.lead')}</Alert>

        {(accounts.signers.length > 0 || accounts.accountAddr !== '' || accounts.selfIsMultisig || address !== '') && (<SectionCard>
        <CosignAccountPicker accounts={accounts} onPick={() => { setForm(EMPTY); setTouched({}); }} lockText={aggQuote ? xym(aggQuote.lockAmount) : null} />

        {address !== '' && (
          <Typography variant="body2" sx={{ wordBreak: 'break-all', fontFamily: 'monospace', mb: 2 }}>{address}</Typography>
        )}
        </SectionCard>)}

        {current === 'loading' && <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress size={26} /></Box>}
        {current === 'failed' && <Alert severity="error" sx={{ mb: 2 }}>{t('social.load_failed')}</Alert>}
        {foreign && <Alert severity="warning" sx={{ mb: 2 }}>{t('social.foreign_value')}</Alert>}

        {current !== 'loading' && current !== 'failed' && (
          <>
            <SectionCard>
            <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
              <SocialAvatar key={previewMeta.imageUrl} meta={previewMeta} size={88} loadImage={errors.imageUrl === null && form.imageUrl.trim() !== ''} />
            </Box>

            <TextField
              label={t('social.field_image_url')}
              value={form.imageUrl}
              onChange={set('imageUrl')}
              onBlur={blur('imageUrl')}
              error={errorText('imageUrl') !== ''}
              helperText={errorText('imageUrl') || t('social.hint_image_url')}
              placeholder="https://"
              fullWidth
              slotProps={{ htmlInput: { inputMode: 'url', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, 'aria-label': t('social.field_image_url') } }}
              sx={{ mb: 2 }}
            />
            <TextField
              label={t('social.field_url')}
              value={form.url}
              onChange={set('url')}
              onBlur={blur('url')}
              error={errorText('url') !== ''}
              helperText={errorText('url') || t('social.hint_url')}
              placeholder="https://"
              fullWidth
              slotProps={{ htmlInput: { inputMode: 'url', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, 'aria-label': t('social.field_url') } }}
              sx={{ mb: 2 }}
            />
            <TextField
              label={t('social.field_namespace_optional')}
              value={form.namespace}
              onChange={set('namespace')}
              onBlur={blur('namespace')}
              error={errorText('namespace') !== ''}
              helperText={errorText('namespace') || t('social.hint_namespace')}
              fullWidth
              slotProps={{ htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, 'aria-label': t('social.field_namespace_optional') } }}
              sx={{ mb: 2 }}
            />
            <TextField
              label={t('social.field_name')}
              value={form.name}
              onChange={set('name')}
              onBlur={blur('name')}
              error={errorText('name') !== ''}
              helperText={errorText('name') || t('social.hint_name')}
              fullWidth
              slotProps={{ htmlInput: { 'aria-label': t('social.field_name') } }}
              sx={{ mb: 2 }}
            />
            </SectionCard>

            {unchanged && <Alert severity="success" sx={{ mb: 2 }}>{t('social.unchanged')}</Alert>}
            {current !== null && !unchanged && valid && <Alert severity="warning" sx={{ mb: 2 }}>{t('social.will_overwrite')}</Alert>}

            <Box sx={{ ...fieldBoxSx }}>
              <Typography variant="body2" sx={{ fontWeight: 'bold', wordBreak: 'break-all' }}>
                {t('metadata.tx_fee')}: {txFee === null ? t('metadata.cost_unavailable') : xym(txFee)}
              </Typography>
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>{t('metadata.cost_hint')}</Typography>
              {balanceShort && <Alert severity="warning" sx={{ mt: 1.5 }}>{t('metadata.xym_short_warning')}</Alert>}
            </Box>
          </>
        )}
      </Box>

      <Box sx={{ px: 3, py: 2, display: 'flex', justifyContent: 'center' }}>
        {/* 戻る（左上）と役割が重なるので、キャンセルは置かない。幅は、以前（キャンセルと半分ずつ）のまま、中央に置く。 */}
        <Button variant="contained" color="primary" size="large" disabled={!canUpdate || sending} onClick={() => setConfirmOpen(true)} sx={{ flex: '0 0 calc(50% - 6px)', py: 1.5 }}>
          {sending ? t('metadata.sending') : t('social.update')}
        </Button>
      </Box>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 'bold' }}>{t('social.confirm_title')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 1.5 }}>{t('social.confirm_message')}</Typography>
          <Box sx={{ ...fieldBoxSx, fontFamily: 'monospace', fontSize: '0.8rem', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
            {SOCIAL_METADATA_KEY_TEXT}{'\n'}{valueText}
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setConfirmOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={() => { setConfirmOpen(false); setShowPassword(true); }}>{t('metadata.confirm_password')}</Button>
        </DialogActions>
      </Dialog>

      <PasswordDialog open={showPassword} mode="check" popup profileKey={account?.profileKey} onClose={() => setShowPassword(false)} onPass={onPassed} />
      <ErrorSnackbar message={errorMessage} onClose={() => setErrorMessage('')} />
      <MessageDialog open={sendError != null} title={errorTitle} texts={errorTexts} onClose={() => setSendError(null)} />
    </Box>
  );
}

function normalize(m: SocialMetadata): SocialMetadata {
  return { url: m.url.trim(), name: m.name.trim(), imageUrl: m.imageUrl.trim(), namespace: m.namespace.trim().replace(/^@/, '') };
}

// social_meta_data が既にあるが、仕様の形（JSON）でないときに、上書きになることを知らせる。
async function hasForeignValue(address: string): Promise<boolean> {
  const bytes = await fetchMetadataValue({ type: 'account', address }, SOCIAL_METADATA_KEY).catch(() => new Uint8Array(0));
  return bytes.length > 0;
}
