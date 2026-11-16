import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, FormControlLabel, MenuItem, Stack, Switch, Typography } from '@mui/material';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import StopOutlinedIcon from '@mui/icons-material/StopOutlined';
import { useTranslation } from 'react-i18next';
import TextField from '../../components/TextField';
import { AgentError, fetchContainers, fetchHostStats, readJob, startJob } from '../../lib/node/agentClient';
import type { AgentConn, ContainersResult } from '../../lib/node/agentClient';
import WatchdogPanel from './WatchdogPanel';
import { AUTO_RESTART_LIMITS, AUTO_RESTART_LINE, decideRestart, initialRestartState } from '../../lib/node/nodeAutoRestart';
import type { RestartState } from '../../lib/node/nodeAutoRestart';
import { validateSubdir } from '../../lib/node/nodeCommands';
import { daysLeft, evaluateHost } from '../../lib/node/nodeHost';
import type { HostStats } from '../../lib/node/nodeHost';
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
let remembered: { url: string; interval: number; compare: boolean; autoRestart: boolean; restartDir: string } = { url: DEFAULT_REST, interval: 30, compare: true, autoRestart: false, restartDir: '' };

/** 自動再起動の記録（この画面のメモリにだけ置く）。 */
interface RestartLog { at: number; kind: 'ok' | 'failed' | 'busy' | 'gave_up' | 'no_agent'; reason?: string }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString();

export default function NodeWatchCard({ agent, cardSx }: { agent: AgentConn | null; cardSx: object }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(remembered.url);
  const [interval, setIntervalSec] = useState(remembered.interval);
  const [compare, setCompare] = useState(remembered.compare);
  const [autoRestart, setAutoRestart] = useState(remembered.autoRestart);
  const [restartDir, setRestartDir] = useState(remembered.restartDir);
  const [wdOn, setWdOn] = useState(false); // エージェントの常駐の見張りがオン（画面側の自動再起動は止める）
  const [restartLog, setRestartLog] = useState<RestartLog[]>([]);
  const [watching, setWatching] = useState(false);
  const [urlError, setUrlError] = useState('');
  const [sample, setSample] = useState<WatchSample | null>(null);
  const [verdict, setVerdict] = useState<{ level: WatchLevel; issues: WatchIssue[] } | null>(null);
  const [stillSec, setStillSec] = useState<number | null>(null);
  const [events, setEvents] = useState<WatchEvent[]>([]);
  const [docker, setDocker] = useState<ContainersResult | null>(null);
  const [host, setHost] = useState<HostStats | null>(null);
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
  // 自動再起動の設定は、見ている途中で変えても、次の巡回から反映する
  const autoRef = useRef({ on: autoRestart, dir: restartDir });
  autoRef.current = { on: autoRestart && !wdOn, dir: restartDir };
  const restartState = useRef<RestartState>(initialRestartState());
  const noAgentNoted = useRef(false);
  const pushRestartLog = (e: RestartLog) => setRestartLog((l) => [e, ...l].slice(0, MAX_EVENTS));

  // エージェント経由で `docker compose restart` を流し、終わるのを待つ。流せたか（'busy' は、別のコマンドが動いていて、流せなかった）を返す。
  const runRestart = async (a: AgentConn, dir: string, reason: string, id: number): Promise<'ok' | 'failed' | 'busy'> => {
    try {
      const { id: job } = await startJob(a, AUTO_RESTART_LINE, dir);
      let from = 0;
      const until = Date.now() + AUTO_RESTART_LIMITS.jobTimeoutMs;
      for (;;) {
        await sleep(1500);
        if (!alive.current || run.current !== id) return 'failed';
        const chunk = await readJob(a, job, from);
        from = chunk.next;
        if (chunk.done) { pushRestartLog({ at: Date.now(), kind: chunk.exitCode === 0 ? 'ok' : 'failed', reason }); return chunk.exitCode === 0 ? 'ok' : 'failed'; }
        if (Date.now() > until) { pushRestartLog({ at: Date.now(), kind: 'failed', reason }); return 'failed'; }
      }
    } catch (e) {
      if (e instanceof AgentError && e.kind === 'busy') return 'busy';
      pushRestartLog({ at: Date.now(), kind: 'failed', reason });
      return 'failed';
    }
  };

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
  useEffect(() => { if (!agent) { setDocker(null); setHost(null); } }, [agent]);

  const start = () => {
    const base = normalizeWatchUrl(url);
    if (base === null) { setUrlError(t('service.node_watch_bad_url')); return; }
    setUrlError('');
    remembered = { url: url.trim(), interval, compare, autoRestart, restartDir };
    track.current = null;
    last.current = null;
    setSample(null); setVerdict(null); setStillSec(null); setEvents([]); setDocker(null); setHost(null); setRestartLog([]);
    restartState.current = initialRestartState();
    noAgentNoted.current = false;
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
      const [s, dk, hs] = await Promise.all([
        probeNode(base, { ref }),
        a ? fetchContainers(a).catch(() => null) : Promise.resolve(null),
        a ? fetchHostStats(a).catch(() => null) : Promise.resolve(null),
      ]);
      if (!alive.current || run.current !== id) return;
      track.current = trackHeight(track.current, s);
      const base0 = evaluate(s, track.current);
      // ディスク・CPU・メモリ・証明書は、エージェントに繋がっているときだけ（REST では分からない）
      const hostIssues = hs ? evaluateHost(hs, s.at) : [];
      const issues = [...base0.issues, ...hostIssues];
      const v = { level: (issues.some((x) => x.level === 'error') ? 'error' : issues.length ? 'warn' : 'ok') as WatchLevel, issues };
      setSample(s);
      setVerdict(v);
      setStillSec(track.current ? Math.floor((s.at - track.current.since) / 1000) : null);
      if (dk) setDocker(dk);
      setHost(hs);
      if (changed(last.current, v)) setEvents((e) => [{ at: s.at, level: v.level, issues: v.issues }, ...e].slice(0, MAX_EVENTS));
      last.current = v;
      // 自動再起動: 止まり・落ちているときだけ、決まりに沿って 1 回流す（暴走させない決まりは nodeAutoRestart.ts）
      if (autoRef.current.on) {
        const d = decideRestart(restartState.current, issues, s.at);
        const dir = validateSubdir(autoRef.current.dir);
        if (d.action === 'gave_up') {
          restartState.current = d.state;
          pushRestartLog({ at: s.at, kind: 'gave_up' });
        } else if (d.action === 'restart') {
          if (!a || !dir.ok) {
            // 繋がっていない・作業フォルダが正しくない: 流せない。状態は進めず、記録を 1 回だけ残す
            if (!noAgentNoted.current) { noAgentNoted.current = true; pushRestartLog({ at: s.at, kind: 'no_agent', reason: d.reason }); }
            restartState.current = { ...restartState.current, bad: restartState.current.bad + 1 };
          } else {
            restartState.current = d.state;
            const r = await runRestart(a, dir.value, d.reason, id);
            if (!alive.current || run.current !== id) return;
            if (r === 'busy') {
              // 別のコマンドが動いていて流せなかった: 回数に数えず、次の巡回でもう一度
              restartState.current = { ...d.state, attempts: d.state.attempts - 1, lastAt: null, bad: AUTO_RESTART_LIMITS.confirmRounds };
              pushRestartLog({ at: Date.now(), kind: 'busy', reason: d.reason });
            }
          }
        } else {
          restartState.current = d.state;
        }
      }
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
      <Box sx={{ mt: 1.5, mb: 1 }}>
        <Typography sx={{ fontWeight: 700, fontSize: '0.9rem', mb: 0.5 }}>{t('service.node_wd_title')}</Typography>
        <WatchdogPanel agent={agent} url={url} dir={restartDir} onDir={setRestartDir} onEnabled={setWdOn} />
      </Box>
      <FormControlLabel control={<Switch size="small" checked={autoRestart} disabled={wdOn} onChange={(e) => setAutoRestart(e.target.checked)} />} label={<Typography sx={{ fontSize: '0.85rem' }}>{t('service.node_ar_label')}</Typography>} />
      {autoRestart && (
        <Box sx={{ ml: 4, mb: 1 }}>
          <Alert severity={agent || wdOn ? 'info' : 'warning'} sx={{ mb: 1 }}>{wdOn ? t('service.node_ar_wd_on') : agent ? t('service.node_ar_note', { min: AUTO_RESTART_LIMITS.cooldownMs / 60_000, max: AUTO_RESTART_LIMITS.maxAttempts }) : t('service.node_ar_need_agent')}</Alert>
          <TextField
            label={t('service.node_ar_dir')} value={restartDir} onChange={(e) => setRestartDir(e.target.value)} fullWidth size="small"
            error={!validateSubdir(restartDir).ok} helperText={validateSubdir(restartDir).ok ? t('service.node_ar_dir_hint') : t('service.node_rej_subdir_invalid')}
            slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }}
          />
        </Box>
      )}
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

      {sample && verdict && (
        <Box sx={{ mt: 2 }}>
          <Typography sx={{ fontWeight: 700, fontSize: '0.9rem', mb: 0.5 }}>{t('service.node_host_title')}</Typography>
          {!agent ? (
            <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>{t('service.node_host_need_agent')}</Typography>
          ) : !host ? (
            <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>{t('service.node_host_unavailable')}</Typography>
          ) : (
            <>
              <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '200px 1fr' }, rowGap: 0.5, columnGap: 2, fontSize: '0.9rem' }}>
                <Row k={t('service.node_host_disk')} v={host.disk ? t('service.node_host_disk_v', { free: fmtBytes(host.disk.freeBytes), total: fmtBytes(host.disk.totalBytes), pct: Math.round((host.disk.freeBytes / host.disk.totalBytes) * 100) }) : '-'} />
                <Row k={t('service.node_host_cpu')} v={host.cpu ? `${host.cpu.usagePct === null ? '-' : `${Math.round(host.cpu.usagePct)}%`}${host.cpu.load1 !== null ? `（${t('service.node_host_load', { n: host.cpu.load1.toFixed(2), cores: host.cpu.cores })}）` : `（${t('service.node_host_cores', { cores: host.cpu.cores })}）`}` : '-'} />
                <Row k={t('service.node_host_mem')} v={host.memory ? t('service.node_host_mem_v', { avail: fmtBytes(host.memory.availableBytes), total: fmtBytes(host.memory.totalBytes), pct: Math.round((host.memory.availableBytes / host.memory.totalBytes) * 100) }) : '-'} />
              </Box>
              <Typography sx={{ fontWeight: 700, fontSize: '0.85rem', mt: 1, mb: 0.5 }}>{t('service.node_host_certs')}</Typography>
              {host.certs.length === 0 ? (
                <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>{t('service.node_host_certs_none')}</Typography>
              ) : (
                <Stack spacing={0.5}>
                  {host.certs.map((c) => {
                    const d = daysLeft(c.notAfter, sample.at);
                    return (
                      <Stack key={c.path} direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.25 }}>
                        <Chip size="small" color={d < 7 ? 'error' : d < 30 ? 'warning' : 'success'} label={d < 0 ? t('service.node_host_cert_expired') : t('service.node_host_cert_days', { n: d })} />
                        <Typography sx={{ fontFamily: MONO, fontSize: '0.82rem', wordBreak: 'break-all' }}>{c.path}</Typography>
                        <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem' }}>{c.subject}（{new Date(c.notAfter).toLocaleDateString()}）</Typography>
                      </Stack>
                    );
                  })}
                </Stack>
              )}
            </>
          )}
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
      {restartLog.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Typography sx={{ fontWeight: 700, fontSize: '0.9rem', mb: 0.5 }}>{t('service.node_ar_log_title')}</Typography>
          <Stack spacing={0.5}>
            {restartLog.map((e, i) => (
              <Stack key={`${e.at}-${i}`} direction="row" spacing={1.5} sx={{ alignItems: 'baseline' }}>
                <Typography sx={{ fontFamily: MONO, fontSize: '0.8rem', color: 'text.secondary', flexShrink: 0 }}>{fmtTime(e.at)}</Typography>
                <Chip size="small" color={e.kind === 'ok' ? 'success' : e.kind === 'busy' ? 'default' : 'error'} label={t(`service.node_ar_kind_${e.kind}`)} />
                <Typography sx={{ fontSize: '0.85rem' }}>{e.reason ? t(`service.node_watch_issue_short_${e.reason}`) : ''}</Typography>
              </Stack>
            ))}
          </Stack>
        </Box>
      )}
      <Typography sx={{ color: 'text.secondary', fontSize: '0.78rem', mt: 2 }}>{t('service.node_watch_note')}</Typography>
    </Box>
  );
}

const fmtBytes = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <Box component="dt" sx={{ color: 'text.secondary' }}>{k}</Box>
      <Box component="dd" sx={{ m: 0, fontFamily: MONO, wordBreak: 'break-all' }}>{v}</Box>
    </>
  );
}
