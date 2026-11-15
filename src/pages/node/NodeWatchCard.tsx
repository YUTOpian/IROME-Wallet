import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, FormControlLabel, MenuItem, Stack, Switch, Typography } from '@mui/material';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import StopOutlinedIcon from '@mui/icons-material/StopOutlined';
import { useTranslation } from 'react-i18next';
import TextField from '../../components/TextField';
import { fetchContainers } from '../../lib/node/agentClient';
import type { AgentConn, ContainersResult } from '../../lib/node/agentClient';
import { MAX_EVENTS, WATCH_INTERVALS_SEC, changed, evaluate, normalizeWatchUrl, probeNode, trackHeight } from '../../lib/node/nodeWatch';
import type { HeightTrack, WatchEvent, WatchIssue, WatchLevel, WatchSample } from '../../lib/node/nodeWatch';
import { nodeRequest } from '../../lib/symbol/api';
import { MijinReadFailure, detectNodeNetwork } from '../../lib/symbol/mijin';
import { useAppStore } from '../../store/appStore';
import { useSssProfile, useWatchOnly } from '../../hooks/useWatchOnly';
import { useSssAccount } from '../../hooks/useSssAccount';

// 「ノードの状態」: 自分のノードの REST（既定 http://127.0.0.1:3000）を一定間隔で見て、正常 / 注意 / 異常を出す。
// ブラウザから REST を直接読む（エージェントは要らない）。エージェントに繋がっているときだけ、Docker のコンテナの状態も出す。
// 見るだけ。ウォレットの鍵にも、ノードの設定にも触れない。結果はこの画面のメモリにだけ置く（保存しない）。

const DEFAULT_REST = 'http://127.0.0.1:3000';
const LEVEL_COLOR: Record<WatchLevel, 'success' | 'warning' | 'error'> = { ok: 'success', warn: 'warning', error: 'error' };
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

// 同じタブの中で、別の画面に移って戻っても、入力を覚えておく（メモリだけ）。
let remembered: { url: string; interval: number; compare: boolean } = { url: DEFAULT_REST, interval: 30, compare: true };

const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString();

export default function NodeWatchCard({ agent, cardSx }: { agent: AgentConn | null; cardSx: object }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(remembered.url);
  const [interval, setIntervalSec] = useState(remembered.interval);
  const [compare, setCompare] = useState(remembered.compare);
  const [watching, setWatching] = useState(false);
  const [urlError, setUrlError] = useState('');
  const [sample, setSample] = useState<WatchSample | null>(null);
  const [verdict, setVerdict] = useState<{ level: WatchLevel; issues: WatchIssue[] } | null>(null);
  const [stillSec, setStillSec] = useState<number | null>(null);
  const [events, setEvents] = useState<WatchEvent[]>([]);
  const [docker, setDocker] = useState<ContainersResult | null>(null);
  // ウォレットの接続先（設定 > ノード）への登録。見ているノードの URL（正規化したもの）を覚えておく。
  const [watchedBase, setWatchedBase] = useState<string | null>(null);
  const [reg, setReg] = useState<{ busy: boolean; kind: 'ok' | 'error' | 'info' | ''; text: string }>({ busy: false, kind: '', text: '' });
  const network = useAppStore((s) => s.network);
  const savedNodes = useAppStore((s) => s.symbolNodeLists);
  const addNode = useAppStore((s) => s.addSymbolNode);
  const adoptNode = useAppStore((s) => s.adoptNode);
  const mijinParams = useAppStore((s) => s.mijinParams);
  // 閲覧用・SSS のプロファイルは、アドレスのネットワークに結び付いている（接続先のダイアログと同じ決まり）。
  const watchOnly = useWatchOnly();
  const sssProfile = useSssProfile();
  const sssReady = useSssAccount().state === 'ready';
  const networkLocked = watchOnly || (sssProfile && sssReady);

  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useRef(0); // 開始のたびに増やす。古い巡回の結果を捨てる
  const track = useRef<HeightTrack | null>(null);
  const last = useRef<{ level: WatchLevel; issues: WatchIssue[] } | null>(null);
  const agentRef = useRef<AgentConn | null>(agent); // 見ている途中で接続・切断しても、次の巡回から反映する
  agentRef.current = agent;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); run.current += 1; };
  }, []);

  const stop = useCallback(() => {
    run.current += 1;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setWatching(false);
  }, []);

  // エージェントとの接続が切れたら、コンテナの表示は消す
  useEffect(() => { if (!agent) setDocker(null); }, [agent]);

  const start = () => {
    const base = normalizeWatchUrl(url);
    if (base === null) { setUrlError(t('service.node_watch_bad_url')); return; }
    setUrlError('');
    remembered = { url: url.trim(), interval, compare };
    track.current = null;
    last.current = null;
    setSample(null); setVerdict(null); setStillSec(null); setEvents([]); setDocker(null);
    setWatchedBase(base);
    setReg({ busy: false, kind: '', text: '' });
    const id = ++run.current;
    setWatching(true);
    const round = async () => {
      // 比べるノード: ウォレットが今使っているノード（ネットワークが違うときは、probeNode が比べない）
      const ref = compare
        ? async () => {
          const [chain, info] = await Promise.all([nodeRequest<{ height?: string }>('/chain/info'), nodeRequest<{ networkIdentifier?: number }>('/node/info')]);
          return chain.height ? { height: Number(chain.height), networkIdentifier: typeof info.networkIdentifier === 'number' ? info.networkIdentifier : null } : null;
        }
        : null;
      const a = agentRef.current;
      const [s, dk] = await Promise.all([
        probeNode(base, { ref }),
        a ? fetchContainers(a).catch(() => null) : Promise.resolve(null),
      ]);
      if (!alive.current || run.current !== id) return;
      track.current = trackHeight(track.current, s);
      const v = evaluate(s, track.current);
      setSample(s);
      setVerdict(v);
      setStillSec(track.current ? Math.floor((s.at - track.current.since) / 1000) : null);
      if (dk) setDocker(dk);
      if (changed(last.current, v)) setEvents((e) => [{ at: s.at, level: v.level, issues: v.issues }, ...e].slice(0, MAX_EVENTS));
      last.current = v;
      timer.current = setTimeout(() => { void round(); }, interval * 1000);
    };
    void round();
  };

  // 見ているノードを、ウォレットの接続先に入れる。
  // - 今のネットワークと同じ: 登録だけする（使うノードは変えない）。use=true なら、そのノードを使う。
  // - 別のネットワーク（メインネット ⇄ テストネット ⇄ mijin）: 登録して、そのネットワークへ切り替える（use のときだけ）。
  const register = async (use: boolean) => {
    if (!watchedBase) return;
    setReg({ busy: true, kind: '', text: '' });
    try {
      const detected = await detectNodeNetwork(watchedBase, mijinParams?.explorer ?? '');
      const sameChain = detected.network === network
        && (detected.network !== 'mijin' || (mijinParams !== null && detected.params.generationHash === mijinParams.generationHash && detected.params.networkByte === mijinParams.networkByte));
      const already = (savedNodes?.[detected.network] ?? []).includes(watchedBase);
      if (sameChain) {
        addNode(network, watchedBase);
        if (use) useAppStore.getState().setCustomNode(network, watchedBase);
        setReg({ busy: false, kind: 'ok', text: t(use ? 'service.node_reg_done_use' : already ? 'service.node_reg_done_exists' : 'service.node_reg_done') });
      } else if (!use && detected.network !== 'mijin') {
        // 別のネットワークのノードを、切り替えずに、そのネットワークの一覧に入れておく。
        addNode(detected.network, watchedBase);
        setReg({ busy: false, kind: 'ok', text: t('service.node_reg_done_other', { net: t(`service.node_reg_net_${detected.network}`) }) });
      } else if (networkLocked) {
        setReg({ busy: false, kind: 'error', text: t('settings.node_network_locked') });
      } else if (!use) {
        setReg({ busy: false, kind: 'info', text: t('service.node_reg_mijin_use_only') });
      } else {
        adoptNode(detected, watchedBase);
        setReg({ busy: false, kind: 'ok', text: t('service.node_reg_done_switched', { net: t(`service.node_reg_net_${detected.network}`) }) });
      }
    } catch (e) {
      setReg({ busy: false, kind: 'error', text: t(`settings.mijin_err_${e instanceof MijinReadFailure ? e.code : 'unreachable'}`) });
    }
  };

  const issueText = (i: WatchIssue) => t(`service.node_watch_issue_${i.key}`, { n: i.n ?? 0 });
  const levelLabel = (l: WatchLevel) => t(`service.node_watch_level_${l}`);

  return (
    <Box sx={cardSx}>
      <Typography sx={{ fontWeight: 700, mb: 0.5 }}>{t('service.node_watch_title')}</Typography>
      <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem', mb: 1.5 }}>{t('service.node_watch_intro')}</Typography>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'flex-start' }, mb: 1 }}>
        <TextField
          label={t('service.node_watch_url')} value={url} onChange={(e) => setUrl(e.target.value)} fullWidth disabled={watching}
          error={urlError !== ''} helperText={urlError || t('service.node_watch_url_hint')}
          slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }}
        />
        <TextField select label={t('service.node_watch_interval')} value={interval} onChange={(e) => setIntervalSec(Number(e.target.value))} disabled={watching} sx={{ minWidth: 150 }}>
          {WATCH_INTERVALS_SEC.map((n) => <MenuItem key={n} value={n}>{t('service.node_watch_interval_n', { n })}</MenuItem>)}
        </TextField>
      </Stack>
      <FormControlLabel control={<Switch size="small" checked={compare} disabled={watching} onChange={(e) => setCompare(e.target.checked)} />} label={<Typography sx={{ fontSize: '0.85rem' }}>{t('service.node_watch_compare')}</Typography>} />
      <Stack direction="row" spacing={1.5} sx={{ mt: 1, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        {watching
          ? <Button variant="outlined" color="error" startIcon={<StopOutlinedIcon />} onClick={stop}>{t('service.node_watch_stop')}</Button>
          : <Button variant="contained" startIcon={<PlayArrowOutlinedIcon />} onClick={start}>{t('service.node_watch_start')}</Button>}
        {watching && sample === null && <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>{t('service.node_watch_checking')}</Typography>}
        {sample && <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem' }}>{t('service.node_watch_last', { time: fmtTime(sample.at) })}{!watching && `（${t('service.node_watch_stopped')}）`}</Typography>}
      </Stack>

      {sample && verdict && (
        <Box sx={{ mt: 2 }}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 1 }}>
            <Chip color={LEVEL_COLOR[verdict.level]} label={levelLabel(verdict.level)} />
            {sample.name && <Typography sx={{ fontWeight: 700 }}>{sample.name}</Typography>}
          </Stack>
          {verdict.issues.length > 0 && (
            <Stack spacing={0.75} sx={{ mb: 1.5 }}>
              {verdict.issues.map((i) => <Alert key={i.key} severity={i.level === 'error' ? 'error' : 'warning'}>{issueText(i)}</Alert>)}
            </Stack>
          )}
          {sample.refSkipped && <Alert severity="info" sx={{ mb: 1.5 }}>{t('service.node_watch_ref_skipped')}</Alert>}
          {compare && !sample.refSkipped && sample.refHeight === null && sample.reachable && <Alert severity="info" sx={{ mb: 1.5 }}>{t('service.node_watch_ref_unavailable')}</Alert>}
          <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '200px 1fr' }, rowGap: 0.5, columnGap: 2, fontSize: '0.9rem' }}>
            <Row k={t('service.node_watch_f_api')} v={sample.apiNode ?? '-'} />
            <Row k={t('service.node_watch_f_db')} v={sample.db ?? '-'} />
            <Row k={t('service.node_watch_f_height')} v={sample.height?.toLocaleString() ?? '-'} />
            <Row k={t('service.node_watch_f_still')} v={stillSec === null ? '-' : t('service.node_watch_sec', { n: stillSec })} />
            <Row k={t('service.node_watch_f_ref')} v={sample.refHeight === null ? '-' : `${sample.refHeight.toLocaleString()}${sample.height !== null ? `（${t('service.node_watch_diff', { n: sample.refHeight - sample.height })}）` : ''}`} />
            <Row k={t('service.node_watch_f_final')} v={sample.finalizedHeight === null ? '-' : `${sample.finalizedHeight.toLocaleString()}${sample.finalizationEpoch !== null ? `（${t('service.node_watch_epoch', { n: sample.finalizationEpoch })}）` : ''}`} />
            <Row k={t('service.node_watch_f_peers')} v={sample.peers?.toString() ?? '-'} />
            <Row k={t('service.node_watch_f_version')} v={sample.version ?? '-'} />
            <Row k={t('service.node_watch_f_latency')} v={sample.latencyMs === null ? '-' : `${sample.latencyMs} ms`} />
          </Box>
        </Box>
      )}

      {sample && verdict && watchedBase && sample.reachable && sample.apiNode === 'up' && sample.db === 'up' && (
        <Box sx={{ mt: 2 }}>
          <Typography sx={{ fontWeight: 700, fontSize: '0.9rem', mb: 0.5 }}>{t('service.node_reg_title')}</Typography>
          <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem', mb: 1 }}>{t('service.node_reg_intro', { url: watchedBase })}</Typography>
          <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
            <Button variant="outlined" disabled={reg.busy} onClick={() => { void register(false); }}>{t('service.node_reg_add')}</Button>
            <Button variant="contained" disabled={reg.busy} onClick={() => { void register(true); }}>{t('service.node_reg_use')}</Button>
          </Stack>
          {reg.text && <Alert severity={reg.kind === 'ok' ? 'success' : reg.kind === 'info' ? 'info' : 'error'} sx={{ mt: 1 }}>{reg.text}</Alert>}
          <Typography sx={{ color: 'text.secondary', fontSize: '0.78rem', mt: 1 }}>{t('service.node_reg_note')}</Typography>
        </Box>
      )}

      {agent && docker && (
        <Box sx={{ mt: 2 }}>
          <Typography sx={{ fontWeight: 700, fontSize: '0.9rem', mb: 0.5 }}>{t('service.node_watch_docker_title')}</Typography>
          {!docker.available ? (
            <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>{t('service.node_watch_docker_none')}</Typography>
          ) : docker.containers.length === 0 ? (
            <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>{t('service.node_watch_docker_empty')}</Typography>
          ) : (
            <Stack spacing={0.5}>
              {docker.containers.map((c) => (
                <Stack key={c.name} direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.25 }}>
                  <Chip size="small" color={c.state === 'running' ? 'success' : 'error'} variant={c.state === 'running' ? 'filled' : 'outlined'} label={c.state || '?'} />
                  <Typography sx={{ fontFamily: MONO, fontSize: '0.82rem', wordBreak: 'break-all' }}>{c.name}</Typography>
                  <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem' }}>{c.status}</Typography>
                </Stack>
              ))}
            </Stack>
          )}
        </Box>
      )}

      {events.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Typography sx={{ fontWeight: 700, fontSize: '0.9rem', mb: 0.5 }}>{t('service.node_watch_log_title')}</Typography>
          <Stack spacing={0.5}>
            {events.map((e) => (
              <Stack key={e.at} direction="row" spacing={1.5} sx={{ alignItems: 'baseline' }}>
                <Typography sx={{ fontFamily: MONO, fontSize: '0.8rem', color: 'text.secondary', flexShrink: 0 }}>{fmtTime(e.at)}</Typography>
                <Chip size="small" color={LEVEL_COLOR[e.level]} label={levelLabel(e.level)} />
                <Typography sx={{ fontSize: '0.85rem' }}>{e.issues.length === 0 ? t('service.node_watch_log_ok') : e.issues.map(issueText).join(' / ')}</Typography>
              </Stack>
            ))}
          </Stack>
        </Box>
      )}
      <Typography sx={{ color: 'text.secondary', fontSize: '0.78rem', mt: 2 }}>{t('service.node_watch_note')}</Typography>
    </Box>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <Box component="dt" sx={{ color: 'text.secondary' }}>{k}</Box>
      <Box component="dd" sx={{ m: 0, fontFamily: MONO, wordBreak: 'break-all' }}>{v}</Box>
    </>
  );
}
