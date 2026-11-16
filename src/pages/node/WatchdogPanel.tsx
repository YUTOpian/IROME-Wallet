import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, MenuItem, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import TextField from '../../components/TextField';
import { AgentError, fetchComposeDirs, fetchWatchdog, saveWatchdog } from '../../lib/node/agentClient';
import type { AgentConn } from '../../lib/node/agentClient';
import { AUTO_RESTART_LIMITS } from '../../lib/node/nodeAutoRestart';
import { normalizeWatchUrl } from '../../lib/node/nodeWatch';
import { validateSubdir } from '../../lib/node/nodeCommands';
import { WATCHDOG_INTERVALS_SEC, normalizeNotifyUrl } from '../../lib/node/nodeWatchdog';
import type { WatchdogSnapshot } from '../../lib/node/nodeWatchdog';

// 「常駐の見張り」: エージェントが、この画面を閉じていても、ノードの REST を見て、止まっている・落ちているときに `docker compose restart` を流す。
// 設定（URL・作業フォルダ・間隔）はエージェント側に保存され、エージェントを再起動しても続く。再起動するコマンドは固定で、ここでは変えられない。
// 画面を開いている間の自動再起動（NodeWatchCard）と二重に動かないよう、こちらがオンの間は、画面側の自動再起動は止める。
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const fmtTime = (ms: number) => new Date(ms).toLocaleString();

export default function WatchdogPanel({ agent, url, dir, onDir, onEnabled }: { agent: AgentConn | null; url: string; dir: string; onDir: (d: string) => void; onEnabled: (on: boolean) => void }) {
  const { t } = useTranslation();
  const [snap, setSnap] = useState<WatchdogSnapshot | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [interval, setIntervalSec] = useState(60);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notify, setNotify] = useState('');
  const [clearNotify, setClearNotify] = useState(false);
  const [found, setFound] = useState<string[] | null>(null);
  const [loadedDir, setLoadedDir] = useState(false);

  const load = useCallback(async () => {
    if (!agent) return;
    try {
      const s = await fetchWatchdog(agent);
      setSnap(s); setUnsupported(s === null);
      if (s) onEnabled(s.config.enabled);
    } catch (e) {
      setSnap(null);
      setUnsupported(e instanceof AgentError && e.kind === 'other'); // 古いエージェントには無い
    }
  }, [agent, onEnabled]);

  useEffect(() => {
    if (!agent) { setSnap(null); onEnabled(false); return; }
    void load();
    const id = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(id);
  }, [agent, load, onEnabled]);

  // 保存してある作業フォルダを、最初に 1 回だけ、入力欄に反映する
  useEffect(() => { if (snap && !loadedDir) { setLoadedDir(true); if (snap.config.enabled) onDir(snap.config.dir); } }, [snap, loadedDir, onDir]);
  useEffect(() => { if (snap) setIntervalSec(snap.config.intervalSec); }, [snap?.config.intervalSec]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!agent) return <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>{t('service.node_wd_need_agent')}</Typography>;
  if (unsupported) return <Alert severity="info">{t('service.node_wd_unsupported')}</Alert>;

  const base = normalizeWatchUrl(url);
  const sub = validateSubdir(dir);
  const detect = async () => {
    setErr('');
    try { setFound(await fetchComposeDirs(agent)); } catch { setFound(null); setErr(t('service.node_wd_err_detect')); }
  };
  const apply = async (enabled: boolean) => {
    if (base === null) { setErr(t('service.node_watch_bad_url')); return; }
    if (!sub.ok) { setErr(t('service.node_rej_subdir_invalid')); return; }
    const nu = notify.trim();
    if (nu !== '' && normalizeNotifyUrl(nu) === null) { setErr(t('service.node_wd_err_bad_notify')); return; }
    setBusy(true); setErr('');
    try {
      // 通知先: 入力があれば設定、「消す」なら空、どちらでもなければ（省略）いまの設定を残す
      const s = await saveWatchdog(agent, { enabled, url: base, dir: sub.value, intervalSec: interval, ...(nu !== '' ? { notifyUrl: nu } : clearNotify ? { notifyUrl: '' } : {}) });
      setNotify(''); setClearNotify(false);
      setSnap(s);
      if (s) onEnabled(s.config.enabled);
    } catch (e) {
      setErr(e instanceof AgentError && e.reason ? t(`service.node_wd_err_${e.reason}`, { defaultValue: t('service.node_wd_err_other') }) : t('service.node_wd_err_other'));
    } finally { setBusy(false); }
  };
  const on = snap?.running === true;

  return (
    <Box>
      <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem', mb: 1 }}>{t('service.node_wd_intro', { min: AUTO_RESTART_LIMITS.cooldownMs / 60_000, max: AUTO_RESTART_LIMITS.maxAttempts })}</Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'center' }, mb: 1 }}>
        <TextField select size="small" label={t('service.node_watch_interval')} value={interval} onChange={(e) => setIntervalSec(Number(e.target.value))} disabled={busy} sx={{ minWidth: 150 }}>
          {WATCHDOG_INTERVALS_SEC.map((n) => <MenuItem key={n} value={n}>{t('service.node_watch_interval_n', { n })}</MenuItem>)}
        </TextField>
        {on
          ? <Button variant="outlined" color="error" disabled={busy} onClick={() => { void apply(false); }}>{t('service.node_wd_stop')}</Button>
          : <Button variant="contained" disabled={busy} onClick={() => { void apply(true); }}>{t('service.node_wd_start')}</Button>}
        {on && <Button variant="text" disabled={busy} onClick={() => { void apply(true); }}>{t('service.node_wd_update')}</Button>}
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-start' }, mb: 1 }}>
        <TextField
          size="small" fullWidth label={t('service.node_ar_dir')} value={dir} onChange={(e) => onDir(e.target.value)} disabled={busy}
          error={!sub.ok} helperText={sub.ok ? t('service.node_ar_dir_hint') : t('service.node_rej_subdir_invalid')}
          slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }}
        />
        <Button variant="outlined" size="small" onClick={() => { void detect(); }} disabled={busy} sx={{ flexShrink: 0, mt: { sm: 0.5 } }}>{t('service.node_wd_detect')}</Button>
      </Stack>
      {found !== null && (
        <Stack direction="row" spacing={0.75} sx={{ mb: 1, flexWrap: 'wrap', rowGap: 0.75, alignItems: 'center' }}>
          {found.length === 0
            ? <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem' }}>{t('service.node_wd_detect_none')}</Typography>
            : found.map((d) => <Chip key={d || '.'} size="small" clickable color={d === dir.trim() ? 'primary' : 'default'} label={d === '' ? t('service.node_cd_root') : d} onClick={() => onDir(d)} />)}
        </Stack>
      )}
      <TextField
        size="small" fullWidth type="password" autoComplete="off" label={t('service.node_wd_notify')} value={notify} onChange={(e) => { setNotify(e.target.value); setClearNotify(false); }} disabled={busy} sx={{ mb: 0.5 }}
        placeholder={snap?.notify.set ? t('service.node_wd_notify_set', { host: snap.notify.host }) : 'https://…'}
        helperText={t('service.node_wd_notify_hint')}
        slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }}
      />
      {snap?.notify.set && notify.trim() === '' && (
        <Button size="small" variant="text" color={clearNotify ? 'error' : 'inherit'} onClick={() => setClearNotify((v) => !v)} disabled={busy} sx={{ mb: 1 }}>{clearNotify ? t('service.node_wd_notify_clear_on') : t('service.node_wd_notify_clear')}</Button>
      )}
      <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', mb: 1 }}>{t('service.node_wd_target', { url: base ?? '-', dir: sub.ok && sub.value !== '' ? sub.value : t('service.node_cd_root') })}</Typography>
      {err && <Alert severity="error" sx={{ mb: 1 }}>{err}</Alert>}
      {snap && (
        <Box>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5, mb: 0.5 }}>
            <Chip size="small" color={on ? 'success' : 'default'} label={on ? t('service.node_wd_on') : t('service.node_wd_off')} />
            {on && snap.level && <Chip size="small" color={snap.level === 'ok' ? 'success' : snap.level === 'warn' ? 'warning' : 'error'} label={t(`service.node_watch_level_${snap.level}`)} />}
            {on && snap.lastCheckAt && <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem' }}>{t('service.node_watch_last', { time: fmtTime(snap.lastCheckAt) })}</Typography>}
          </Stack>
          {on && snap.config.url !== base && <Alert severity="info" sx={{ mb: 1 }}>{t('service.node_wd_other_url', { url: snap.config.url })}</Alert>}
          {snap.gaveUp && <Alert severity="error" sx={{ mb: 1 }}>{t('service.node_wd_gave_up')}</Alert>}
          {snap.log.length > 0 && (
            <Stack spacing={0.5} sx={{ mt: 1 }}>
              {snap.log.slice(0, 20).map((e, i) => (
                <Stack key={`${e.at}-${i}`} direction="row" spacing={1.5} sx={{ alignItems: 'baseline' }}>
                  <Typography sx={{ fontFamily: MONO, fontSize: '0.8rem', color: 'text.secondary', flexShrink: 0 }}>{fmtTime(e.at)}</Typography>
                  <Chip size="small" color={e.kind === 'restart_ok' || e.kind === 'recovered' ? 'success' : e.kind === 'started' || e.kind === 'restart_busy' ? 'default' : 'error'} label={t(`service.node_wd_kind_${e.kind}`)} />
                  <Typography sx={{ fontSize: '0.85rem' }}>{e.reason ? t(`service.node_watch_issue_short_${e.reason}`) : ''}</Typography>
                </Stack>
              ))}
            </Stack>
          )}
        </Box>
      )}
    </Box>
  );
}
