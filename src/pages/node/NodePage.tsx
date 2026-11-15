import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Alert, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, InputBase, Stack, Switch, Typography } from '@mui/material';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import StopOutlinedIcon from '@mui/icons-material/StopOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import { useTranslation } from 'react-i18next';
import TextField from '../../components/TextField';
import { AgentError, DEFAULT_AGENT_URL, fetchStatus, listFiles, readFile, readJob, rememberConn, rememberedConn, sendKey, sendStdin, startJob, stopJob, writeFile } from '../../lib/node/agentClient';
import type { AgentConn, AgentStatus, TtyKey } from '../../lib/node/agentClient';
import type { InstallTarget } from '../../lib/node/nodeCommands';
import { COMMAND_PRESETS, isLoopbackAgentUrl, isWizardArgv, parseCommandLine, validateSubdir } from '../../lib/node/nodeCommands';
import { DEFAULT_COLS, TermEmu } from '../../lib/node/termEmu';
import { useNodeSettingsStore } from '../../store/nodeSettingsStore';
import { pushHistory, stepHistory } from '../../lib/console/repl';
import NodeWatchCard from './NodeWatchCard';

// 「ノード」(Symbol): symbol-bootstrap・Shoestring・Nodewatch を、ウォレットからコマンドで動かして、ノードの環境を作る。
// ブラウザはシェルも Docker も触れないので、同じ PC で起動した「ノード構築エージェント」（`npm run node-agent`）に繋ぎ、
// 許可されたコマンドだけを実行してもらう（許可の決まりは lib/node/nodeCommands.ts。エージェントも同じ判定をもう一度かける）。
// ウォレットの秘密鍵・ニーモニックは、この画面にもエージェントにも渡らない。
// 画面は、コンソールと同じ濃い紫の地（テーマに関係なく）。出力はエージェントへ 0.4 秒ごとに取りに行く。
// wizard（symbol-bootstrap wizard）は、画面の設定で「有効」にしたときだけ動かせる（初期値は無効）。有効なときだけ、
// 生の出力（エスケープ列つき）を受け取り、簡易ターミナル（lib/node/termEmu.ts）で描く。選択式の画面が、重ならずに出る。

type SegKind = 'cmd' | 'out' | 'sys' | 'err';
/** tty: 簡易ターミナルで描いた画面（出力をつなげず、そのまま折り返さずに出す） */
interface Seg { id: number; kind: SegKind; text: string; tty?: boolean }

const CON_BG = '#150629';
const COLORS: Record<SegKind, string> = { cmd: '#7be4e4', out: '#f3effa', sys: '#a597c2', err: '#ff8fa3' };
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const MAX_CHARS = 300_000;
const POLL_MS = 400;
/** 簡易ターミナルが動いているあいだ、入力欄が空のときに、そのままキーとして送る（矢印・Space。Enter も）。 */
const EMU_KEYS: Partial<Record<string, TtyKey>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', ' ': 'space' };

type ToolKey = keyof AgentStatus['tools'];
const TOOL_ROWS: Array<{ key: ToolKey; labelKey: string; install?: string; target?: InstallTarget }> = [
  { key: 'docker', labelKey: 'service.node_tool_docker' },
  { key: 'node', labelKey: 'service.node_tool_node' },
  { key: 'python', labelKey: 'service.node_tool_python' },
  { key: 'symbol-bootstrap', labelKey: 'service.node_tool_bootstrap', install: 'irome install bootstrap', target: 'bootstrap' },
  { key: 'shoestring', labelKey: 'service.node_tool_shoestring', install: 'irome install shoestring', target: 'shoestring' },
  { key: 'symbol-node-watcher', labelKey: 'service.node_tool_nodewatch', install: 'irome install nodewatch', target: 'nodewatch' },
];
const GROUPS = ['check', 'install', 'bootstrap', 'shoestring', 'nodewatch'] as const;

export default function NodePage() {
  const { t } = useTranslation();
  const initial = rememberedConn();
  const [url, setUrl] = useState(initial?.url ?? DEFAULT_AGENT_URL);
  const [token, setToken] = useState(initial?.token ?? '');
  const [conn, setConn] = useState<AgentConn | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connError, setConnError] = useState('');
  const [cwd, setCwd] = useState('');
  const [segs, setSegs] = useState<Seg[]>([]);
  const [input, setInput] = useState('');
  const [secret, setSecret] = useState(false);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  // wizard を使うか（画面の設定。このブラウザに保存）と、いま簡易ターミナルで描いているか
  const wizardOn = useNodeSettingsStore((st) => st.wizard);
  const setWizard = useNodeSettingsStore((st) => st.setWizard);
  const [emuActive, setEmuActive] = useState(false);
  // 設定ファイルの編集
  const [files, setFiles] = useState<Array<{ path: string; size: number }>>([]);
  const [filePath, setFilePath] = useState('');
  const [fileText, setFileText] = useState('');
  const [fileSaved, setFileSaved] = useState('');
  const [fileDirty, setFileDirty] = useState(false);
  const [fileMsg, setFileMsg] = useState<{ severity: 'success' | 'error' | 'info'; text: string } | null>(null);
  // アンインストールの確認（注意を読んで、チェックを入れないと削除できない）
  const [unTarget, setUnTarget] = useState<InstallTarget | null>(null);
  const [unAgree, setUnAgree] = useState(false);

  const alive = useRef(true);
  const idRef = useRef(0);
  const jobRef = useRef<string | null>(null);
  const connRef = useRef<AgentConn | null>(null);
  const histIndex = useRef(0);
  const draft = useRef('');
  const screenRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const emuRef = useRef<TermEmu | null>(null);
  const ttySegRef = useRef<number | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const push = useCallback((kind: SegKind, text: string) => {
    setSegs((prev) => {
      const last = prev[prev.length - 1];
      // 出力は、前の出力の続きとしてつなぐ（行の途中で区切れても、そのまま読める）
      let next: Seg[] = last && kind === 'out' && last.kind === 'out' && !last.tty ? [...prev.slice(0, -1), { ...last, text: last.text + text }] : [...prev, { id: ++idRef.current, kind, text }];
      let total = next.reduce((n, s) => n + s.text.length, 0);
      while (total > MAX_CHARS && next.length > 1) { total -= next[0].text.length; next = next.slice(1); }
      return next;
    });
  }, []);

  // 簡易ターミナル: 生の出力を格子に書き込み、いまの画面の見た目で、その 1 つの区切りを置き換える
  const pushTty = useCallback((text: string) => {
    const emu = emuRef.current;
    const id = ttySegRef.current;
    if (!emu || id === null) return;
    emu.write(text);
    const shown = emu.text();
    setSegs((prev) => prev.map((sg) => (sg.id === id ? { ...sg, text: shown === '' ? '' : `${shown}\n` } : sg)));
  }, []);

  const endTty = useCallback(() => {
    emuRef.current = null;
    ttySegRef.current = null;
    setEmuActive(false);
  }, []);

  // 下端に張り付いているときだけ、新しい出力に合わせてスクロールする
  useEffect(() => {
    const el = screenRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [segs]);

  const describeError = useCallback((e: unknown): string => {
    if (e instanceof AgentError) {
      if (e.kind === 'rejected') {
        const key = `service.node_rej_${e.reason ?? ''}`;
        const text = t(key);
        return text === key ? t('service.node_err_rejected_default') : text;
      }
      return t(`service.node_err_${e.kind}`);
    }
    return t('service.node_err_other');
  }, [t]);

  const refreshStatus = useCallback(async (c: AgentConn) => {
    try {
      const s = await fetchStatus(c);
      if (alive.current) setStatus(s);
    } catch (e) {
      if (alive.current) setConnError(describeError(e));
    }
  }, [describeError]);

  const refreshFiles = useCallback(async (c: AgentConn) => {
    try {
      const r = await listFiles(c);
      if (alive.current) setFiles(r.files);
    } catch { /* 一覧が取れなくても、パスを直接入れて開ける */ }
  }, []);

  const openFile = async (path: string) => {
    const c = connRef.current;
    if (!c) return;
    if (fileDirty && !window.confirm(t('service.node_file_confirm_discard'))) return;
    setFileMsg(null);
    try {
      const r = await readFile(c, path.trim());
      if (!alive.current) return;
      setFilePath(path.trim());
      setFileText(r.content);
      setFileDirty(false);
      setFileSaved(path.trim());
    } catch (e) {
      if (alive.current) setFileMsg({ severity: e instanceof AgentError && e.reason === 'not_found' ? 'info' : 'error', text: describeError(e) });
    }
  };

  const saveFile = async () => {
    const c = connRef.current;
    if (!c || filePath.trim() === '') return;
    setFileMsg(null);
    try {
      await writeFile(c, filePath.trim(), fileText);
      if (!alive.current) return;
      setFileDirty(false);
      setFileSaved(filePath.trim());
      setFileMsg({ severity: 'success', text: t('service.node_file_saved', { path: filePath.trim() }) });
      void refreshFiles(c);
    } catch (e) {
      if (alive.current) setFileMsg({ severity: 'error', text: describeError(e) });
    }
  };

  const connect = async () => {
    setConnError('');
    const c: AgentConn = { url: url.trim().replace(/\/+$/, ''), token: token.trim() };
    if (!isLoopbackAgentUrl(c.url)) { setConnError(t('service.node_err_bad_url')); return; }
    setConnecting(true);
    try {
      const s = await fetchStatus(c);
      if (!alive.current) return;
      connRef.current = c;
      rememberConn(c);
      setConn(c);
      setStatus(s);
      void refreshFiles(c);
    } catch (e) {
      if (alive.current) setConnError(describeError(e));
    } finally {
      if (alive.current) setConnecting(false);
    }
  };

  const disconnect = () => {
    jobRef.current = null;
    endTty();
    connRef.current = null;
    rememberConn(null);
    setConn(null);
    setStatus(null);
    setRunning(false);
    setToken('');
    setFiles([]);
    setFilePath('');
    setFileText('');
    setFileDirty(false);
    setFileMsg(null);
  };

  // 実行中のコマンドの出力を、終わるまで取りに行く
  const follow = useCallback(async (c: AgentConn, id: string, raw: boolean) => {
    let from = 0;
    while (alive.current && jobRef.current === id) {
      try {
        const chunk = await readJob(c, id, from);
        if (!alive.current || jobRef.current !== id) return;
        if (chunk.truncated) push('sys', `${t('service.node_truncated')}\n`);
        if (chunk.text) { if (raw) pushTty(chunk.text); else push('out', chunk.text); }
        from = chunk.next;
        if (chunk.done) {
          push('sys', `${t('service.node_exit', { code: chunk.exitCode ?? '?' })}\n`);
          jobRef.current = null;
          if (raw) endTty();
          setRunning(false);
          void refreshStatus(c); // 導入が終わったら、ツールの有無を取り直す
          return;
        }
      } catch (e) {
        if (!alive.current || jobRef.current !== id) return;
        push('err', `${describeError(e)}\n`);
        jobRef.current = null;
        if (raw) endTty();
        setRunning(false);
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }, [describeError, endTty, push, pushTty, refreshStatus, t]);

  const askUninstall = (target: InstallTarget) => { setUnAgree(false); setUnTarget(target); };

  // confirmed: 注意を読んで同意した後の実行（ボタンからも、ターミナルに `irome uninstall …` と打っても、必ず確認を通す）
  const runLine = async (raw: string, confirmed = false) => {
    const c = connRef.current;
    const line = raw.trim();
    if (!c || line === '' || jobRef.current) return;
    const pre = parseCommandLine(line);
    if (pre.ok && pre.tool === 'irome' && pre.argv[1] === 'uninstall' && !confirmed) { askUninstall(pre.argv[2] as InstallTarget); return; }
    push('cmd', `$ ${line}\n`);
    setHistory((h) => pushHistory(h, line));
    // 画面でも事前に判定する（エージェントは、同じ判定をもう一度かける）
    const parsed = parseCommandLine(line, { wizard: wizardOn });
    if (!parsed.ok) { push('err', `${t(`service.node_rej_${parsed.reason}`)}\n`); return; }
    const sub = validateSubdir(cwd);
    if (!sub.ok) { push('err', `${t(`service.node_rej_${sub.reason}`)}\n`); return; }
    try {
      // wizard を有効にしているときだけ、wizard を通し、出力を生で受け取って簡易ターミナルで描く
      const { id, raw } = await startJob(c, line, sub.value, { wizard: wizardOn, emulate: wizardOn && isWizardArgv(parsed.argv) });
      if (!alive.current) return;
      jobRef.current = id;
      const tty = raw === true;
      if (tty) {
        const segId = ++idRef.current;
        ttySegRef.current = segId;
        emuRef.current = new TermEmu(DEFAULT_COLS);
        setSegs((prev) => [...prev, { id: segId, kind: 'out', text: '', tty: true }]);
        setEmuActive(true);
      }
      setRunning(true);
      void follow(c, id, tty);
    } catch (e) {
      push('err', `${describeError(e)}\n`);
    }
  };

  const submit = async () => {
    const value = input;
    histIndex.current = history.length + (value.trim() === '' ? 0 : 1);
    const c = connRef.current;
    const id = jobRef.current;
    if (c && id) {
      // 実行中は、入力がそのままコマンドの標準入力に送られる（パスワードの確認など）
      if (value === '') return;
      setInput('');
      push('cmd', secret ? '> ********\n' : `> ${value}\n`);
      try { await sendStdin(c, id, value); } catch (e) { push('err', `${describeError(e)}\n`); }
      return;
    }
    setInput('');
    await runLine(value);
    histIndex.current = history.length + 1;
  };

  // 対話式の画面（symbol-bootstrap wizard など）用: 矢印・Enter・スペース・Tab をそのまま送る
  const pressKey = async (key: TtyKey) => {
    const c = connRef.current;
    const id = jobRef.current;
    if (!c || !id) return;
    try { await sendKey(c, id, key); } catch (e) { push('err', `${describeError(e)}\n`); }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // 簡易ターミナルが動いていて、入力欄が空なら、Enter はそのまま選択の決定として送る
      if (emuActive && input === '') { void pressKey('enter'); return; }
      void submit();
      return;
    }
    if (emuActive && input === '' && !e.nativeEvent.isComposing) {
      const k = EMU_KEYS[e.key];
      if (k) { e.preventDefault(); void pressKey(k); return; }
    }
    if (running || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    if (histIndex.current >= history.length) draft.current = input;
    const idx = stepHistory(history, Math.min(histIndex.current, history.length), e.key === 'ArrowUp' ? -1 : 1);
    histIndex.current = idx;
    setInput(idx >= history.length ? draft.current : history[idx]);
  };

  const stop = async () => {
    const c = connRef.current;
    const id = jobRef.current;
    if (!c || !id) return;
    try { await stopJob(c, id); } catch (e) { push('err', `${describeError(e)}\n`); }
  };

  const connected = conn !== null;
  const cardSx = { border: 1, borderColor: 'divider', borderRadius: 1, p: 2, mt: 2, textAlign: 'left' } as const;

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography sx={{ fontSize: '1.4rem', fontWeight: 400 }}>{t('service.node_title')}</Typography>
        <Typography sx={{ mt: 1, color: 'text.secondary' }}>{t('service.node_intro')}</Typography>

        {/* 接続 */}
        <Box sx={cardSx}>
          <Typography sx={{ fontWeight: 700, mb: 1 }}>{t('service.node_conn_title')}</Typography>
          {!connected && <Typography sx={{ mb: 2, color: 'text.secondary', fontSize: '0.9rem' }}>{t('service.node_conn_howto')}</Typography>}
          {connected ? (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
              <Chip color="success" size="small" label={t('service.node_connected')} />
              <Typography sx={{ fontFamily: MONO, fontSize: '0.85rem' }}>{conn.url}</Typography>
              <Button size="small" variant="outlined" onClick={disconnect}>{t('service.node_disconnect')}</Button>
            </Stack>
          ) : (
            <Stack spacing={2}>
              <TextField label={t('service.node_url')} value={url} onChange={(e) => setUrl(e.target.value)} fullWidth slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }} />
              <TextField
                label={t('service.node_token')} type="password" value={token} onChange={(e) => setToken(e.target.value)} fullWidth autoComplete="off"
                slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }}
                onKeyDown={(e) => { if (e.key === 'Enter' && token.trim() !== '' && !connecting) void connect(); }}
              />
              <Box><Button variant="contained" disabled={connecting || token.trim() === ''} onClick={() => void connect()}>{connecting ? t('service.node_connecting') : t('service.node_connect')}</Button></Box>
            </Stack>
          )}
          {connError && <Alert severity="error" sx={{ mt: 2 }}>{connError}</Alert>}
        </Box>

        {/* ノードの状態（REST を見るだけなので、エージェントに繋がっていなくても使える） */}
        <NodeWatchCard agent={conn} cardSx={cardSx} />

        {connected && status && (
          <>
            {/* この PC の環境 */}
            <Box sx={cardSx}>
              <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                <Typography sx={{ fontWeight: 700 }}>{t('service.node_tools_title')}</Typography>
                <Button size="small" startIcon={<RefreshOutlinedIcon />} onClick={() => { if (connRef.current) void refreshStatus(connRef.current); }}>{t('service.node_refresh')}</Button>
              </Stack>
              <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem', mb: 1.5, wordBreak: 'break-all' }}>
                {status.platform} / {status.arch} ・ {t('service.node_workspace')}: <Box component="span" sx={{ fontFamily: MONO }}>{status.workspace}</Box>
              </Typography>
              <Stack spacing={1}>
                {TOOL_ROWS.map((row) => {
                  const st = status.tools[row.key];
                  return (
                    <Stack key={row.key} direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5, minHeight: 32 }}>
                      <Typography sx={{ width: { xs: 'auto', sm: 260 }, minWidth: 0 }}>{t(row.labelKey)}</Typography>
                      <Chip size="small" color={st.found ? 'success' : 'default'} variant={st.found ? 'filled' : 'outlined'} label={st.found ? t('service.node_tool_found') : t('service.node_tool_missing')} />
                      {st.found && st.version && <Typography sx={{ fontFamily: MONO, fontSize: '0.8rem', color: 'text.secondary', wordBreak: 'break-all' }}>{st.version}</Typography>}
                      {!st.found && row.install && <Button size="small" variant="outlined" disabled={running} onClick={() => void runLine(row.install as string)}>{t('service.node_install')}</Button>}
                      {st.found && row.target && st.local && <Button size="small" variant="outlined" color="error" disabled={running} onClick={() => askUninstall(row.target as InstallTarget)}>{t('service.node_uninstall')}</Button>}
                      {st.found && row.target && !st.local && <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem' }}>{t('service.node_uninstall_outside')}</Typography>}
                    </Stack>
                  );
                })}
              </Stack>
              <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', mt: 1.5 }}>{t('service.node_uninstall_hint')}</Typography>
            </Box>

            {/* ターミナル */}
            <Box sx={cardSx}>
              <Typography sx={{ fontWeight: 700, mb: 1 }}>{t('service.node_terminal_title')}</Typography>
              {/* wizard（対話式）の設定。有効にしたときだけ、wizard を実行でき、簡易ターミナルで描く */}
              <Box sx={{ mb: 2 }}>
                <FormControlLabel
                  control={<Switch checked={wizardOn} disabled={running} onChange={(e) => setWizard(e.target.checked)} />}
                  label={<Typography sx={{ fontWeight: 700, fontSize: '0.95rem' }}>{t('service.node_wizard_enable')}</Typography>}
                />
                <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>{t('service.node_wizard_hint')}</Typography>
                {wizardOn && !status.pty && <Alert severity="warning" sx={{ mt: 1 }}>{t('service.node_wizard_needs_pty')}</Alert>}
                {wizardOn && (
                  <Button size="small" variant="outlined" disabled={running} onClick={() => { setInput('symbol-bootstrap wizard'); histIndex.current = history.length; }} sx={{ mt: 1, fontFamily: MONO, textTransform: 'none' }}>
                    symbol-bootstrap wizard
                  </Button>
                )}
              </Box>
              <TextField label={t('service.node_cwd')} value={cwd} onChange={(e) => setCwd(e.target.value)} fullWidth placeholder={t('service.node_cwd_hint')} disabled={running} sx={{ mb: 2 }} slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }} />
              <Box
                ref={screenRef}
                onScroll={(e) => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
                sx={{ bgcolor: CON_BG, borderRadius: 1, p: 1.5, height: 360, minHeight: 160, resize: 'vertical', overflow: 'auto', fontFamily: MONO, fontSize: '0.82rem', lineHeight: 1.5, textAlign: 'left' }}
              >
                <Box component="pre" sx={{ m: 0, fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {segs.map((s) => <span key={s.id} style={s.tty ? { color: COLORS[s.kind], whiteSpace: 'pre', wordBreak: 'normal' } : { color: COLORS[s.kind] }}>{s.text}</span>)}
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: segs.length ? 0.5 : 0 }}>
                  <Box component="span" sx={{ color: COLORS.cmd, flexShrink: 0 }}>{running ? '>' : '$'}</Box>
                  <InputBase
                    fullWidth value={input} onChange={(e) => { setInput(e.target.value); histIndex.current = history.length; }} onKeyDown={onKeyDown}
                    type={running && secret ? 'password' : 'text'}
                    placeholder={running ? t(emuActive ? 'service.node_stdin_placeholder_tty' : 'service.node_stdin_placeholder') : t('service.node_prompt_placeholder')}
                    slotProps={{ input: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off', autoComplete: 'off', 'aria-label': t('service.node_terminal_title') } }}
                    sx={{ fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit', p: 0, color: COLORS.cmd, caretColor: COLORS.cmd, '& input::placeholder': { color: COLORS.sys, opacity: 0.7 } }}
                  />
                </Box>
              </Box>
              <Stack direction="row" spacing={1} sx={{ mt: 1.5, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                {running ? (
                  <Button variant="outlined" color="error" startIcon={<StopOutlinedIcon />} onClick={() => void stop()}>{t('service.node_stop')}</Button>
                ) : (
                  <Button variant="contained" startIcon={<PlayArrowOutlinedIcon />} disabled={input.trim() === ''} onClick={() => void submit()}>{t('service.node_run')}</Button>
                )}
                <Button onClick={() => setSegs([])}>{t('service.node_clear')}</Button>
                {running && <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>{t('service.node_running')}</Typography>}
                {running && emuActive && (
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }} role="group" aria-label={t('service.node_keys_label')}>
                    {(['up', 'down', 'left', 'right', 'enter', 'space', 'tab'] as const).map((k) => (
                      <Button key={k} size="small" variant="outlined" sx={{ minWidth: 0, px: 1 }} onClick={() => void pressKey(k)} aria-label={t(`service.node_key_${k}`)}>
                        {({ up: '↑', down: '↓', left: '←', right: '→', enter: 'Enter', space: 'Space', tab: 'Tab' } as const)[k]}
                      </Button>
                    ))}
                  </Stack>
                )}
                {running && <FormControlLabel sx={{ ml: 1 }} control={<Switch size="small" checked={secret} onChange={(e) => setSecret(e.target.checked)} />} label={<Typography sx={{ fontSize: '0.85rem' }}>{t('service.node_stdin_secret')}</Typography>} />}
              </Stack>
            </Box>

            {/* 設定ファイル */}
            <Box sx={cardSx}>
              <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                <Typography sx={{ fontWeight: 700 }}>{t('service.node_files_title')}</Typography>
                <Button size="small" startIcon={<RefreshOutlinedIcon />} onClick={() => { if (connRef.current) void refreshFiles(connRef.current); }}>{t('service.node_files_refresh')}</Button>
              </Stack>
              <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem', mb: 1.5 }}>{t('service.node_files_hint')}</Typography>
              {files.length === 0 ? (
                <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem', mb: 1.5 }}>{t('service.node_files_empty')}</Typography>
              ) : (
                <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mb: 1.5 }}>
                  {files.map((f) => (
                    <Chip key={f.path} size="small" clickable variant={f.path === fileSaved ? 'filled' : 'outlined'} label={f.path} onClick={() => void openFile(f.path)} sx={{ fontFamily: MONO }} />
                  ))}
                </Stack>
              )}
              <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', mb: 1.5 }}>
                <TextField label={t('service.node_file_path')} value={filePath} onChange={(e) => { setFilePath(e.target.value); setFileDirty(true); }} fullWidth slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }} />
                <Button variant="outlined" sx={{ flexShrink: 0, height: 56 }} disabled={filePath.trim() === ''} onClick={() => void openFile(filePath)}>{t('service.node_file_load')}</Button>
              </Stack>
              <TextField
                value={fileText} onChange={(e) => { setFileText(e.target.value); setFileDirty(true); }} fullWidth multiline minRows={10} maxRows={30}
                slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off', style: { fontFamily: MONO, fontSize: '0.82rem' }, 'aria-label': t('service.node_files_title') } }}
              />
              <Stack direction="row" spacing={1.5} sx={{ mt: 1.5, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                <Button variant="contained" disabled={filePath.trim() === ''} onClick={() => void saveFile()}>{t('service.node_file_save')}</Button>
                {fileDirty && <Typography sx={{ color: 'warning.main', fontSize: '0.85rem' }}>{t('service.node_file_dirty')}</Typography>}
              </Stack>
              {fileMsg && <Alert severity={fileMsg.severity} sx={{ mt: 1.5 }}>{fileMsg.text}</Alert>}
            </Box>

            {/* ひな型 */}
            <Box sx={cardSx}>
              <Typography sx={{ fontWeight: 700, mb: 1.5 }}>{t('service.node_presets_title')}</Typography>
              <Stack spacing={2}>
                {GROUPS.map((g) => (
                  <Box key={g}>
                    <Typography sx={{ fontSize: '0.85rem', fontWeight: 700, color: 'text.secondary', mb: 0.5 }}>{t(`service.node_group_${g}`)}</Typography>
                    <Stack spacing={0.75}>
                      {COMMAND_PRESETS.filter((p) => p.group === g).map((p) => (
                        <Stack key={p.line} direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
                          <Button size="small" variant="outlined" disabled={running} onClick={() => { setInput(p.line); histIndex.current = history.length; }} sx={{ fontFamily: MONO, textTransform: 'none', textAlign: 'left', wordBreak: 'break-all' }}>{p.line}</Button>
                          <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>{t(p.noteKey)}</Typography>
                        </Stack>
                      ))}
                    </Stack>
                    {g === 'bootstrap' && <Alert severity="info" sx={{ mt: 1 }}>{t('service.node_warn_testnet')}</Alert>}
                  </Box>
                ))}
              </Stack>
            </Box>
          </>
        )}

        {/* アンインストールの注意（確認ダイアログ） */}
        <Dialog open={unTarget !== null} onClose={() => setUnTarget(null)} maxWidth="sm" fullWidth>
          {unTarget && (
            <>
              <DialogTitle>{t('service.node_un_title', { name: t(`service.node_un_name_${unTarget}`) })}</DialogTitle>
              <DialogContent>
                <Alert severity="warning" sx={{ mb: 2 }}>{t('service.node_un_lead')}</Alert>
                <Typography sx={{ fontWeight: 700, fontSize: '0.9rem' }}>{t('service.node_un_removes_title')}</Typography>
                <Typography sx={{ fontSize: '0.9rem', mb: 1.5 }}>{t(`service.node_un_removes_${unTarget}`)}</Typography>
                <Typography sx={{ fontWeight: 700, fontSize: '0.9rem' }}>{t('service.node_un_keeps_title')}</Typography>
                <Typography sx={{ fontSize: '0.9rem', mb: 1.5 }}>{t('service.node_un_keeps_body')}</Typography>
                <Typography sx={{ fontWeight: 700, fontSize: '0.9rem' }}>{t('service.node_un_before_title')}</Typography>
                <Box component="ul" sx={{ mt: 0.5, mb: 1.5, pl: 2.5, fontSize: '0.9rem' }}>
                  <li>{t('service.node_un_before_stop')}</li>
                  <li>{t(`service.node_un_before_${unTarget}`)}</li>
                  <li>{t('service.node_un_before_backup')}</li>
                  <li>{t('service.node_un_before_undo')}</li>
                </Box>
                <FormControlLabel control={<Checkbox checked={unAgree} onChange={(e) => setUnAgree(e.target.checked)} />} label={<Typography sx={{ fontSize: '0.9rem' }}>{t('service.node_un_agree')}</Typography>} />
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setUnTarget(null)}>{t('service.node_un_cancel')}</Button>
                <Button color="error" variant="contained" disabled={!unAgree || running} onClick={() => { const target = unTarget; setUnTarget(null); void runLine(`irome uninstall ${target}`, true); }}>{t('service.node_un_do')}</Button>
              </DialogActions>
            </>
          )}
        </Dialog>

        <Box sx={cardSx}>
          <Typography sx={{ fontWeight: 700, mb: 0.5 }}>{t('service.node_allowed_title')}</Typography>
          <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem' }}>{t('service.node_allowed_body')}</Typography>
        </Box>
      </Box>
    </Box>
  );
}
