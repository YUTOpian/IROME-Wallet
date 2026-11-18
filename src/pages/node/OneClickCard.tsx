import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Checkbox, Chip, CircularProgress, FormControlLabel, MenuItem, Stack, Typography } from '@mui/material';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import StopOutlinedIcon from '@mui/icons-material/StopOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineOutlinedIcon from '@mui/icons-material/ErrorOutlineOutlined';
import { useTranslation } from 'react-i18next';
import TextField from '../../components/TextField';
import { AgentError, readFile, writeFile } from '../../lib/node/agentClient';
import type { AgentConn, AgentStatus } from '../../lib/node/agentClient';
import { applyConfig, defaultOptions, missingTools, normalizeOptions, overridesContent, planSteps, planStop, planUpdate, toolsReady, validateDir, validateOptions, validateShoestringVersion } from '../../lib/node/oneClick';
import type { OneClickNetwork, OneClickOptions, PlanStep } from '../../lib/node/oneClick';
import GuideText from './GuideText';

// 「ノード構築」: Docker・Python・Shoestring が PC に入っているときだけ押せる。押すと、lib/node/oneClick.ts の手順
// （確認 → init → config.ini → overrides.ini → メインキー → setup → docker compose up -d）を、上から順に、前が成功したときだけ実行する。
// コマンドは、画面の「実行」と同じ経路（許可の判定 → エージェント）で動かすので、新しい許可は増えない。出力は、ターミナルに出る。
// 投票ノード・ハーベスティングは、チェックを入れたぶんだけ config.ini の features に足す。

type StepState = 'pending' | 'running' | 'done' | 'failed';
type Mode = 'build' | 'stop' | 'update';
type Result = { kind: 'done'; mode: Mode; harvesting: boolean; voting: boolean; network: OneClickNetwork } | { kind: 'failed'; step: PlanStep['id'] } | { kind: 'cancelled' };

const isNotFound = (e: unknown) => e instanceof AgentError && e.kind === 'rejected' && e.reason === 'not_found';

interface Props {
  cardSx: object;
  status: AgentStatus;
  agent: AgentConn;
  /** ほかのコマンドが動いている（構築中は false。構築中は、この部品の中で止める） */
  otherBusy: boolean;
  /** 1 行を実行して、終わるまで待つ（終了コード。実行できなかったときは null）。出力はターミナルに出る */
  exec: (line: string, cwd: string) => Promise<number | null>;
  /** ターミナルに 1 行書く */
  note: (kind: 'sys' | 'err', text: string) => void;
  /** 構築の始まり・終わり（画面のほかのボタンを止める） */
  onBuilding: (building: boolean) => void;
  /** 実行中のコマンドを止める（中止） */
  onStop: () => void;
  /** 中止されたか */
  isCancelled: () => boolean;
  describeError: (e: unknown) => string;
  /** 終わったあと（成功も失敗も）に、ツールの有無とファイル一覧を取り直す */
  onFinished: () => void;
  onOpenGuide: () => void;
}

export default function OneClickCard({ cardSx, status, agent, otherBusy, exec, note, onBuilding, onStop, isCancelled, describeError, onFinished, onOpenGuide }: Props) {
  const { t } = useTranslation();
  const [opts, setOpts] = useState<OneClickOptions>(defaultOptions);
  const [building, setBuilding] = useState(false);
  const [mode, setMode] = useState<Mode>('build');
  const [states, setStates] = useState<StepState[]>([]);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [formError, setFormError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const alive = useRef(true);
  const buildingRef = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // 画面を離れたら、続きは実行しない（いま動いているコマンドは止める）
      if (buildingRef.current) onStop();
    };
    // 画面を離れるときだけ実行する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tools = { docker: status.tools.docker, python: status.tools.python, shoestring: status.tools.shoestring };
  const ready = toolsReady(tools);
  const missing = missingTools(tools);
  const set = <K extends keyof OneClickOptions>(k: K, v: OneClickOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));
  const setStep = (i: number, s: StepState) => { if (alive.current) setStates((prev) => prev.map((x, j) => (j === i ? s : x))); };

  // 構築（build）・停止（stop）・更新（update）。停止と更新は、すでにあるノードのフォルダ（config.ini があるところ）にだけ使える。
  const run = async (m: Mode) => {
    if (buildingRef.current || otherBusy) return;
    if (m === 'build' ? !ready : !(status.tools.docker.found && (m === 'stop' || (status.tools.python.found && status.tools.shoestring.found)))) return;
    setResult(null);
    // 更新だけ、Shoestring のバージョン（空なら最新）も確かめる
    const bad = m === 'build' ? validateOptions(opts) : !validateDir(opts.dir) ? 'dir' : m === 'update' && !validateShoestringVersion(opts.shoestringVersion) ? 'version' : null;
    if (bad) { setFormError(t(`service.node_oc_err_${bad}`)); return; }
    const o = { ...normalizeOptions(opts), shoestringVersion: opts.shoestringVersion.trim() };
    setFormError('');
    let hasConfig = false;
    try {
      await readFile(agent, `${o.dir}/config.ini`);
      hasConfig = true;
    } catch (e) {
      if (!isNotFound(e)) { setFormError(describeError(e)); return; }
    }
    // 構築は、すでに config.ini があるフォルダは使わない（動いているノードの設定・鍵を上書きしない）。停止・更新は、無いフォルダには使えない
    if (m === 'build' ? hasConfig : !hasConfig) { setFormError(t(m === 'build' ? 'service.node_oc_exists' : 'service.node_oc_no_node')); return; }
    if (m !== 'build' && !window.confirm(t(m === 'stop' ? 'service.node_oc_confirm_stop' : 'service.node_oc_confirm_update'))) return;
    let steps: PlanStep[];
    if (m === 'build') steps = planSteps(o);
    else if (m === 'stop') steps = planStop(o);
    else {
      let hasOverrides = true;
      try { await readFile(agent, `${o.dir}/overrides.ini`); } catch (e) { if (isNotFound(e)) hasOverrides = false; else { setFormError(describeError(e)); return; } }
      steps = planUpdate(o, hasOverrides);
    }
    if (!alive.current) return;

    setMode(m);
    buildingRef.current = true;
    setBuilding(true);
    setPlan(steps);
    setStates(steps.map(() => 'pending'));
    onBuilding(true);
    let failed: PlanStep['id'] | null = null;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (isCancelled() || !alive.current) break;
      setStep(i, 'running');
      let ok = false;
      try {
        if (s.kind === 'run') {
          ok = (await exec(s.line ?? '', s.cwd ?? '')) === 0;
        } else if (s.kind === 'config') {
          const path = `${o.dir}/config.ini`;
          const cur = await readFile(agent, path);
          await writeFile(agent, path, applyConfig(cur.content, o));
          note('sys', `${t('service.node_oc_step_config')}: ${path}\n`);
          ok = true;
        } else {
          const path = `${o.dir}/overrides.ini`;
          await writeFile(agent, path, overridesContent(o));
          note('sys', `${t('service.node_oc_step_overrides')}: ${path}\n`);
          ok = true;
        }
      } catch (e) {
        note('err', `${describeError(e)}\n`);
      }
      if (!alive.current) break;
      setStep(i, ok ? 'done' : 'failed');
      if (!ok) { failed = s.id; break; }
    }
    buildingRef.current = false;
    onBuilding(false);
    if (!alive.current) return;
    setBuilding(false);
    if (isCancelled()) { setResult({ kind: 'cancelled' }); note('sys', `${t('service.node_oc_cancelled')}\n`); }
    else if (failed) setResult({ kind: 'failed', step: failed });
    else setResult({ kind: 'done', mode: m, harvesting: m === 'build' && o.harvesting, voting: m === 'build' && o.voting, network: o.network });
    onFinished();
  };

  const disabled = building || otherBusy;
  const hint = (id: PlanStep['id']) => { const key = `service.node_oc_hint_${id}`; const text = t(key); return text === key ? '' : text; };

  return (
    <Box sx={cardSx} id="node-oneclick">
      <Typography sx={{ fontWeight: 700, mb: 1 }}>{t('service.node_oc_title')}</Typography>
      <Box sx={{ color: 'text.secondary', mb: 1.5 }}><GuideText size="0.85rem" text={t('service.node_oc_intro')} /></Box>

      {!ready && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          <Typography sx={{ fontSize: '0.9rem', mb: 0.75 }}>{t('service.node_oc_needs')}</Typography>
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
            {missing.map((k) => <Chip key={k} size="small" variant="outlined" label={t(`service.node_oc_need_${k}`)} />)}
          </Stack>
        </Alert>
      )}

      <Stack spacing={2} sx={{ mb: 2 }}>
        <Box>
          <TextField label={t('service.node_oc_dir')} value={opts.dir} onChange={(e) => set('dir', e.target.value)} fullWidth disabled={disabled} slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }} />
          <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', mt: 0.5 }}>{t('service.node_oc_dir_hint')}</Typography>
        </Box>
        <TextField select label={t('service.node_oc_network')} value={opts.network} onChange={(e) => set('network', e.target.value as OneClickNetwork)} fullWidth disabled={disabled}>
          <MenuItem value="mainnet">{t('service.node_oc_net_mainnet')}</MenuItem>
          <MenuItem value="testnet">{t('service.node_oc_net_testnet')}</MenuItem>
        </TextField>
        <TextField label={t('service.node_oc_name')} value={opts.friendlyName} onChange={(e) => set('friendlyName', e.target.value)} fullWidth disabled={disabled} slotProps={{ htmlInput: { maxLength: 64, spellCheck: false } }} />
        <Box>
          <TextField label={t('service.node_oc_host')} value={opts.host} onChange={(e) => set('host', e.target.value)} fullWidth disabled={disabled} slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }} />
          <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', mt: 0.5 }}>{t('service.node_oc_host_hint')}</Typography>
        </Box>
        <Box>
          <FormControlLabel
            control={<Checkbox checked={opts.harvesting} disabled={disabled} onChange={(e) => set('harvesting', e.target.checked)} />}
            label={<Typography sx={{ fontWeight: 700, fontSize: '0.95rem' }}>{t('service.node_oc_harvesting')}</Typography>}
          />
          <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', ml: 4 }}>{t('service.node_oc_harvesting_hint')}</Typography>
        </Box>
        <Box>
          <FormControlLabel
            control={<Checkbox checked={opts.voting} disabled={disabled} onChange={(e) => set('voting', e.target.checked)} />}
            label={<Typography sx={{ fontWeight: 700, fontSize: '0.95rem' }}>{t('service.node_oc_voting')}</Typography>}
          />
          <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', ml: 4 }}>{t('service.node_oc_voting_hint')}</Typography>
        </Box>
      </Stack>

      {/* 更新だけで使う。空なら最新、入れると pip install --upgrade symbol-shoestring==<バージョン> */}
      <Box sx={{ mb: 2 }}>
        <TextField label={t('service.node_oc_version')} placeholder="0.2.6" value={opts.shoestringVersion} onChange={(e) => set('shoestringVersion', e.target.value)} fullWidth disabled={disabled} slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off', inputMode: 'decimal' } }} />
        <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', mt: 0.5 }}>{t('service.node_oc_version_hint')}</Typography>
      </Box>

      <Alert severity={opts.network === 'mainnet' ? 'warning' : 'info'} sx={{ mb: 1.5 }}>{t(opts.network === 'mainnet' ? 'service.node_oc_mainnet_note' : 'service.node_oc_testnet_note')}</Alert>
      {formError && <Alert severity="error" sx={{ mb: 1.5 }}>{formError}</Alert>}

      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Button variant="contained" size="large" startIcon={building && mode === 'build' ? <CircularProgress size={18} color="inherit" /> : <PlayArrowOutlinedIcon />} disabled={!ready || disabled} onClick={() => void run('build')}>
          {building && mode === 'build' ? t('service.node_oc_building') : t('service.node_oc_build')}
        </Button>
        {/* 停止・更新は、すでにあるノード（上のフォルダ）に使う。停止は Docker だけ、更新は 3 つとも入っているときだけ */}
        <Button variant="outlined" size="large" startIcon={building && mode === 'update' ? <CircularProgress size={18} color="inherit" /> : <RefreshOutlinedIcon />} disabled={!ready || disabled} onClick={() => void run('update')}>
          {building && mode === 'update' ? t('service.node_oc_updating') : t('service.node_oc_update')}
        </Button>
        <Button variant="outlined" size="large" color="warning" startIcon={building && mode === 'stop' ? <CircularProgress size={18} color="inherit" /> : undefined} disabled={!status.tools.docker.found || disabled} onClick={() => void run('stop')}>
          {building && mode === 'stop' ? t('service.node_oc_stopping') : t('service.node_oc_stop_node')}
        </Button>
        {building && <Button variant="outlined" color="error" startIcon={<StopOutlinedIcon />} onClick={onStop}>{t('service.node_oc_stop')}</Button>}
      </Stack>
      <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', mt: 1 }}>{t('service.node_oc_manage_hint')}</Typography>
      {/* 具体的な構築の説明（Shoestring でノードを建てる手順）へのリンク。ここで自動で行うことを、手順ごとに説明している */}
      <Button size="small" variant="text" disabled={building} onClick={onOpenGuide} sx={{ mt: 0.5, px: 0, justifyContent: 'flex-start', textTransform: 'none' }}>{t('service.node_ss_open')}</Button>

      {plan.length > 0 && (
        <Stack spacing={0.5} sx={{ mt: 2 }} aria-live="polite">
          {plan.map((s, i) => {
            const st = states[i] ?? 'pending';
            return (
              <Stack key={s.id} direction="row" spacing={1} sx={{ alignItems: 'center', color: st === 'pending' ? 'text.secondary' : 'text.primary' }}>
                {st === 'done' ? <CheckCircleOutlinedIcon fontSize="small" color="success" />
                  : st === 'failed' ? <ErrorOutlineOutlinedIcon fontSize="small" color="error" />
                  : st === 'running' ? <CircularProgress size={16} sx={{ mx: '2px' }} />
                  : <Box component="span" aria-hidden sx={{ width: 20, height: 20, display: 'inline-block', boxSizing: 'border-box', border: 2, borderColor: 'divider', borderRadius: '50%', m: '2px' }} />}
                <Typography sx={{ fontSize: '0.9rem', fontWeight: st === 'running' ? 700 : 400 }}>{t(`service.node_oc_step_${s.id}`)}</Typography>
              </Stack>
            );
          })}
        </Stack>
      )}

      {result?.kind === 'failed' && (
        <Alert severity="error" sx={{ mt: 2 }}>
          <Typography sx={{ fontSize: '0.9rem' }}>{t(mode === 'build' ? 'service.node_oc_failed' : 'service.node_oc_failed_manage', { step: t(`service.node_oc_step_${result.step}`) })}</Typography>
          {hint(result.step) !== '' && <Typography sx={{ fontSize: '0.9rem', mt: 0.75 }}>{hint(result.step)}</Typography>}
        </Alert>
      )}
      {result?.kind === 'cancelled' && <Alert severity="info" sx={{ mt: 2 }}>{t('service.node_oc_cancelled')}</Alert>}
      {result?.kind === 'done' && (
        <Stack spacing={1} sx={{ mt: 2 }}>
          <Alert severity="success"><GuideText size="inherit" text={t(result.mode === 'build' ? 'service.node_oc_done' : result.mode === 'stop' ? 'service.node_oc_done_stop' : 'service.node_oc_done_update')} /></Alert>
          {result.mode === 'build' && <Alert severity="warning"><GuideText size="inherit" text={t('service.node_oc_done_key')} /></Alert>}
          {result.harvesting && <Alert severity="info"><GuideText size="inherit" text={t('service.node_oc_done_harvest')} /></Alert>}
          {result.voting && <Alert severity="info"><GuideText size="inherit" text={t('service.node_oc_done_voting')} /></Alert>}
          {(result.harvesting || result.voting) && <Box><Button size="small" variant="outlined" onClick={onOpenGuide}>{t('service.node_oc_go_guide')}</Button></Box>}
        </Stack>
      )}
    </Box>
  );
}
