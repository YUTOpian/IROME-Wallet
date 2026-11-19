import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
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
import { NEM_LOCAL_URL, NEM_SERVANT_PORT, defaultNemOptions, nemConfigFile, nemMissingTools, nemPropertiesContent, nemServantFile, nemToolsReady, normalizeNemOptions, parseNemNodeStatus, planNemBuild, planNemStart, planNemStop, planNemSupernode, planNemUpdate, randomBootKey, servantPropertiesContent, setProperty, validateNemDir, validateNemOptions } from '../../lib/node/nemNode';
import type { NemNetwork, NemNodeStatus, NemOptions, NemPlanStep } from '../../lib/node/nemNode';
import GuideText from './GuideText';
import { normalizeGuideText } from '../../lib/node/guideText';

// 「NEM ノード構築」: NEM（NIS1）ノードを、公式の nem-docker（docs の「Docker を使用する」）で建てる。Docker と git が PC に入っているときだけ押せる。
// 構築 = 取得（irome nem install）→ 設定ファイルを作る → 起動（irome nem start）→ 確認。手順は lib/node/nemNode.ts。
// コマンドは、ターミナルの「実行」と同じ経路（許可の判定 → エージェントがもう一度判定）で動かす。新しい許可は `irome nem …` の 4 つだけ。
// 設定ファイルの nis.bootKey（ノードのリモート鍵）は、画面にも履歴にも出さない。
// スーパーノード（公式ドキュメント「スーパーノードプログラム」の Docker の手順）: Servant の設定（servant.config.properties: nem.host・servant.key）を画面が置き、
// supervisord.conf は `irome nem supernode` が作る。メインネットだけ。リモート鍵は必須（nis.bootKey と servant.key に、同じ鍵）。

type StepState = 'pending' | 'running' | 'done' | 'failed';
type Mode = 'build' | 'start' | 'stop' | 'update' | 'supernode';
type Result = { kind: 'done'; mode: Mode; generated: boolean; supernode: boolean } | { kind: 'failed'; step: NemPlanStep['id'] } | { kind: 'cancelled' };

// 小見出し（枠の中を、まとまりごとに区切る）と、入力欄の下の補足。
// 部品の外に置く（部品の中で作ると、描き直すたびに別の部品になり、入力欄のフォーカスが外れてしまう）
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box sx={{ mb: 2.5 }}>
      <Typography component="h3" sx={{ fontWeight: 700, fontSize: '0.95rem', pl: 1, mb: 1.5, borderLeft: 3, borderColor: 'primary.main' }}>{title}</Typography>
      {children}
    </Box>
  );
}
function Hint({ text }: { text: string }) {
  return <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', lineHeight: 1.7, mt: 0.5 }}>{text}</Typography>;
}

const isNotFound = (e: unknown) => e instanceof AgentError && e.kind === 'rejected' && e.reason === 'not_found';

interface Props {
  cardSx: object;
  status: AgentStatus;
  agent: AgentConn;
  otherBusy: boolean;
  exec: (line: string, cwd: string) => Promise<number | null>;
  note: (kind: 'sys' | 'err', text: string) => void;
  onBuilding: (building: boolean) => void;
  onStop: () => void;
  isCancelled: () => boolean;
  describeError: (e: unknown) => string;
  onFinished: () => void;
  onOpenGuide: () => void;
}

export default function NemOneClickCard({ cardSx, status, agent, otherBusy, exec, note, onBuilding, onStop, isCancelled, describeError, onFinished, onOpenGuide }: Props) {
  const { t } = useTranslation();
  const [opts, setOpts] = useState<NemOptions>(defaultNemOptions);
  const [building, setBuilding] = useState(false);
  const [mode, setMode] = useState<Mode>('build');
  const [states, setStates] = useState<StepState[]>([]);
  const [plan, setPlan] = useState<NemPlanStep[]>([]);
  const [formError, setFormError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [probe, setProbe] = useState<{ state: 'idle' | 'loading' | 'ok' | 'error'; info?: NemNodeStatus }>({ state: 'idle' });
  const alive = useRef(true);
  const buildingRef = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (buildingRef.current) onStop(); // 画面を離れたら、続きは実行しない
    };
    // 画面を離れるときだけ実行する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tools = { docker: status.tools.docker, git: status.tools.git ?? { found: false, version: null } };
  const linux = status.platform === 'linux';
  const ready = nemToolsReady(tools) && linux;
  const missing = nemMissingTools(tools);
  const set = <K extends keyof NemOptions>(k: K, v: NemOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));
  const setStep = (i: number, s: StepState) => { if (alive.current) setStates((prev) => prev.map((x, j) => (j === i ? s : x))); };

  const run = async (m: Mode) => {
    if (buildingRef.current || otherBusy || !ready) return;
    setResult(null);
    const bad = m === 'build' ? validateNemOptions(opts) : m === 'supernode' ? validateNemOptions(opts, true) : !validateNemDir(opts.dir) ? 'dir' : null;
    if (bad) { setFormError(t(`service.node_nem_err_${bad}`)); return; }
    const o = normalizeNemOptions(opts);
    setFormError('');
    let hasConfig = false;
    try {
      await readFile(agent, nemConfigFile(o.dir));
      hasConfig = true;
    } catch (e) {
      if (!isNotFound(e)) { setFormError(describeError(e)); return; }
    }
    // 構築は、すでに設定ファイルがあるフォルダは使わない（動いているノードの設定・鍵を上書きしない）。それ以外は、設定ファイルがあるフォルダだけ
    if (m === 'build' ? hasConfig : !hasConfig && m !== 'stop') { setFormError(t(m === 'build' ? 'service.node_nem_exists' : 'service.node_nem_no_node')); return; }
    if ((m === 'stop' || m === 'update' || m === 'supernode') && !window.confirm(t(m === 'stop' ? 'service.node_nem_confirm_stop' : m === 'update' ? 'service.node_nem_confirm_update' : 'service.node_nem_confirm_supernode'))) return;
    const steps = m === 'build' ? planNemBuild(o) : m === 'start' ? planNemStart(o.dir) : m === 'stop' ? planNemStop(o.dir) : m === 'supernode' ? planNemSupernode(o) : planNemUpdate(o.dir);
    // boot key: 入力が空なら、このノード専用に乱数で作る（画面にも履歴にも出さない）
    const bootKey = o.bootKey !== '' ? o.bootKey : randomBootKey();
    const generated = o.bootKey === '';

    setMode(m);
    buildingRef.current = true;
    setBuilding(true);
    setPlan(steps);
    setStates(steps.map(() => 'pending'));
    onBuilding(true);
    let failed: NemPlanStep['id'] | null = null;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (isCancelled() || !alive.current) break;
      setStep(i, 'running');
      let ok = false;
      try {
        if (s.kind === 'run') {
          ok = (await exec(s.line ?? '', s.cwd ?? '')) === 0;
        } else if (s.id === 'servant') {
          // Servant の設定（nem.host・servant.key）。servant.key は、nis.bootKey と同じリモートアカウントの秘密鍵
          const path = nemServantFile(o.dir);
          await writeFile(agent, path, servantPropertiesContent(o.host, bootKey));
          note('sys', `${t('service.node_nem_step_servant')}: ${path}\n`);
          ok = true;
        } else if (s.id === 'nisKey') {
          // すでにある NIS の設定の nis.bootKey だけを、リモート鍵に入れ替える（ほかの行は、そのまま）
          const path = nemConfigFile(o.dir);
          const cur = (await readFile(agent, path)).content;
          await writeFile(agent, path, setProperty(cur, 'nis.bootKey', bootKey));
          note('sys', `${t('service.node_nem_step_nisKey')}: ${path}\n`);
          ok = true;
        } else {
          const path = nemConfigFile(o.dir);
          await writeFile(agent, path, nemPropertiesContent(o, bootKey));
          note('sys', `${t('service.node_nem_step_config')}: ${path}\n`);
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
    if (isCancelled()) { setResult({ kind: 'cancelled' }); note('sys', `${t('service.node_nem_cancelled')}\n`); }
    else if (failed) setResult({ kind: 'failed', step: failed });
    else setResult({ kind: 'done', mode: m, generated: m === 'build' && generated, supernode: m === 'supernode' || (m === 'build' && o.supernode) });
    onFinished();
  };

  // ノードの状態: ブラウザから、ローカルの NIS1 の REST（/node/info・/chain/height）を 1 回だけ見る。公開ページ（https）からは、ブラウザの「ローカルネットワークへのアクセス」の確認が出ることがある。
  const checkStatus = async () => {
    setProbe({ state: 'loading' });
    const get = async (path: string): Promise<unknown> => {
      const res = await fetch(`${NEM_LOCAL_URL}${path}`, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error('http');
      return res.json() as Promise<unknown>;
    };
    try {
      const [info, height] = await Promise.all([get('/node/info'), get('/chain/height')]);
      if (alive.current) setProbe({ state: 'ok', info: parseNemNodeStatus(info, height) });
    } catch {
      if (alive.current) setProbe({ state: 'error' });
    }
  };

  const disabled = building || otherBusy;
  const hint = (id: NemPlanStep['id']) => { const key = `service.node_nem_hint_${id}`; const text = t(key); return text === key ? '' : text; };
  const dirOk = validateNemDir(opts.dir);

  // 説明のうち、GuideText を通さずに出すものも、うっかり（`\n` の文字・`**`）が出ないように通す
  const tx = (k: string, o?: Record<string, unknown>) => normalizeGuideText(t(k, o));
  const busy = (m: Mode) => building && mode === m;
  const spin = <CircularProgress size={18} color="inherit" />;

  return (
    <Box sx={cardSx} id="node-nem-oneclick">
      <Typography sx={{ fontWeight: 700, mb: 1 }}>{t('service.node_nem_title')}</Typography>
      <Box sx={{ color: 'text.secondary', mb: 2 }}><GuideText size="0.85rem" text={t('service.node_nem_intro')} /></Box>

      {!linux && <Alert severity="warning" sx={{ mb: 2 }}><GuideText size="inherit" text={t('service.node_nem_linux_only')} /></Alert>}
      {linux && !ready && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <Typography sx={{ fontSize: '0.9rem', mb: 0.75 }}>{t('service.node_nem_needs')}</Typography>
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
            {missing.map((k) => <Chip key={k} size="small" variant="outlined" label={t(`service.node_nem_need_${k}`)} />)}
          </Stack>
        </Alert>
      )}

      <Section title={t('service.node_nem_sec_basic')}>
        <Stack spacing={2}>
          <Box>
            <TextField label={t('service.node_nem_dir')} value={opts.dir} onChange={(e) => set('dir', e.target.value)} fullWidth disabled={disabled} slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }} />
            <Hint text={tx('service.node_nem_dir_hint')} />
          </Box>
          <TextField select label={t('service.node_nem_network')} value={opts.network} onChange={(e) => set('network', e.target.value as NemNetwork)} fullWidth disabled={disabled}>
            <MenuItem value="mainnet">{t('service.node_nem_net_mainnet')}</MenuItem>
            <MenuItem value="testnet">{t('service.node_nem_net_testnet')}</MenuItem>
          </TextField>
          <Box>
            <TextField label={t('service.node_nem_name')} value={opts.name} onChange={(e) => set('name', e.target.value)} fullWidth disabled={disabled} slotProps={{ htmlInput: { maxLength: 64, spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }} />
            <Hint text={tx('service.node_nem_name_hint')} />
          </Box>
        </Stack>
        <Alert severity={opts.network === 'mainnet' ? 'warning' : 'info'} sx={{ mt: 2 }}>{tx(opts.network === 'mainnet' ? 'service.node_nem_mainnet_note' : 'service.node_nem_testnet_note')}</Alert>
      </Section>

      <Section title={t('service.node_nem_sec_key')}>
        <Box>
          <TextField label={t('service.node_nem_key')} type="password" value={opts.bootKey} onChange={(e) => set('bootKey', e.target.value)} fullWidth disabled={disabled} autoComplete="off" slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }} />
          <Box sx={{ color: 'text.secondary', mt: 0.5 }}><GuideText size="0.8rem" text={t('service.node_nem_key_hint')} /></Box>
        </Box>
        <Box sx={{ mt: 1.5 }}>
          <FormControlLabel
            control={<Checkbox checked={opts.harvest} disabled={disabled} onChange={(e) => set('harvest', e.target.checked)} />}
            label={<Typography sx={{ fontWeight: 700, fontSize: '0.95rem' }}>{t('service.node_nem_harvest')}</Typography>}
          />
          <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', lineHeight: 1.7, ml: 4 }}>{tx('service.node_nem_harvest_hint')}</Typography>
        </Box>
      </Section>

      {/* スーパーノード（公式ドキュメント「スーパーノードプログラム」。メインネットだけ）。Node Servant を設定して、NIS と一緒に起動する */}
      <Section title={t('service.node_nem_sec_super')}>
        <FormControlLabel
          control={<Checkbox checked={opts.supernode} disabled={disabled} onChange={(e) => set('supernode', e.target.checked)} />}
          label={<Typography sx={{ fontWeight: 700, fontSize: '0.95rem' }}>{t('service.node_nem_supernode')}</Typography>}
        />
        <Box sx={{ color: 'text.secondary', ml: 4, mb: 1.5 }}><GuideText size="0.8rem" text={t('service.node_nem_supernode_hint', { port: NEM_SERVANT_PORT })} /></Box>
        <TextField label={t('service.node_nem_host')} value={opts.host} onChange={(e) => set('host', e.target.value)} fullWidth disabled={disabled} placeholder="node.example.com" slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }} />
        <Hint text={tx('service.node_nem_host_hint')} />
        {opts.network === 'testnet' && <Alert severity="info" sx={{ mt: 1 }}>{tx('service.node_nem_supernode_mainnet_only')}</Alert>}
      </Section>

      {formError && <Alert severity="error" sx={{ mb: 2 }}>{normalizeGuideText(formError)}</Alert>}

      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Button variant="contained" size="large" startIcon={busy('build') ? spin : <PlayArrowOutlinedIcon />} disabled={!ready || disabled} onClick={() => void run('build')}>
          {busy('build') ? t('service.node_nem_building') : t('service.node_nem_build')}
        </Button>
        {building && <Button variant="outlined" color="error" startIcon={<StopOutlinedIcon />} onClick={onStop}>{t('service.node_nem_abort')}</Button>}
      </Stack>

      <Box sx={{ mt: 3, pt: 2, borderTop: '1px dashed', borderColor: 'divider' }}>
        <Section title={t('service.node_nem_sec_manage')}>
          <Hint text={tx('service.node_nem_manage_hint')} />
          <Stack direction="row" spacing={1.5} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
            <Button variant="outlined" startIcon={busy('start') ? spin : undefined} disabled={!ready || disabled || !dirOk} onClick={() => void run('start')}>
              {busy('start') ? t('service.node_nem_starting') : t('service.node_nem_start')}
            </Button>
            <Button variant="outlined" startIcon={busy('update') ? spin : <RefreshOutlinedIcon />} disabled={!ready || disabled || !dirOk} onClick={() => void run('update')}>
              {busy('update') ? t('service.node_nem_updating') : t('service.node_nem_update')}
            </Button>
            <Button variant="outlined" startIcon={busy('supernode') ? spin : undefined} disabled={!ready || disabled || !dirOk} onClick={() => void run('supernode')}>
              {busy('supernode') ? t('service.node_nem_supernoding') : t('service.node_nem_make_supernode')}
            </Button>
            <Button variant="outlined" color="warning" startIcon={busy('stop') ? spin : undefined} disabled={!ready || disabled || !dirOk} onClick={() => void run('stop')}>
              {busy('stop') ? t('service.node_nem_stopping') : t('service.node_nem_stop_node')}
            </Button>
          </Stack>
        </Section>
        <Button size="small" variant="text" disabled={building} onClick={onOpenGuide} sx={{ px: 0, justifyContent: 'flex-start', textTransform: 'none' }}>{t('service.node_nem_open_guide')}</Button>
      </Box>

      {plan.length > 0 && (
        <Stack spacing={0.5} sx={{ mt: 2 }} aria-live="polite">
          {plan.map((s, i) => {
            const st = states[i] ?? 'pending';
            return (
              <Stack key={`${s.id}-${i}`} direction="row" spacing={1} sx={{ alignItems: 'center', color: st === 'pending' ? 'text.secondary' : 'text.primary' }}>
                {st === 'done' ? <CheckCircleOutlinedIcon fontSize="small" color="success" />
                  : st === 'failed' ? <ErrorOutlineOutlinedIcon fontSize="small" color="error" />
                  : st === 'running' ? <CircularProgress size={16} sx={{ mx: '2px' }} />
                  : <Box component="span" aria-hidden sx={{ width: 20, height: 20, display: 'inline-block', boxSizing: 'border-box', border: 2, borderColor: 'divider', borderRadius: '50%', m: '2px' }} />}
                <Typography sx={{ fontSize: '0.9rem', fontWeight: st === 'running' ? 700 : 400 }}>{t(`service.node_nem_step_${s.id}`)}</Typography>
              </Stack>
            );
          })}
        </Stack>
      )}

      {result?.kind === 'failed' && (
        <Alert severity="error" sx={{ mt: 2 }}>
          <Typography sx={{ fontSize: '0.9rem' }}>{tx(mode === 'build' ? 'service.node_nem_failed' : 'service.node_nem_failed_manage', { step: t(`service.node_nem_step_${result.step}`) })}</Typography>
          {hint(result.step) !== '' && <Typography sx={{ fontSize: '0.9rem', mt: 0.75 }}>{normalizeGuideText(hint(result.step))}</Typography>}
        </Alert>
      )}
      {result?.kind === 'cancelled' && <Alert severity="info" sx={{ mt: 2 }}>{tx('service.node_nem_cancelled')}</Alert>}
      {result?.kind === 'done' && (
        <Stack spacing={1} sx={{ mt: 2 }}>
          <Alert severity="success"><GuideText size="inherit" text={t(`service.node_nem_done_${result.mode}`)} /></Alert>
          {result.supernode && <Alert severity="info"><GuideText size="inherit" text={t('service.node_nem_done_supernode_next', { port: NEM_SERVANT_PORT })} /></Alert>}
          {result.generated && <Alert severity="warning"><GuideText size="inherit" text={t('service.node_nem_done_key')} /></Alert>}
        </Stack>
      )}

      {/* ノードの状態（ブラウザから、ローカルの REST を 1 回見る） */}
      <Box sx={{ mt: 2, pt: 1.5, borderTop: '1px dashed', borderColor: 'divider' }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
          <Button size="small" variant="outlined" disabled={probe.state === 'loading'} onClick={() => void checkStatus()}>{probe.state === 'loading' ? t('service.node_nem_status_loading') : t('service.node_nem_status_btn')}</Button>
          <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem' }}>{NEM_LOCAL_URL}</Typography>
        </Stack>
        {probe.state === 'ok' && probe.info && (
          <Alert severity="success" sx={{ mt: 1 }}>{tx('service.node_nem_status_ok', { height: probe.info.height ?? '?', version: probe.info.version ?? '?', network: probe.info.network ?? '?' })}</Alert>
        )}
        {probe.state === 'error' && <Alert severity="warning" sx={{ mt: 1 }}><GuideText size="inherit" text={t('service.node_nem_status_err')} /></Alert>}
      </Box>
    </Box>
  );
}
