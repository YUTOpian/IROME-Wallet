import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Alert, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, InputBase, MenuItem, Stack, Switch, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import StopOutlinedIcon from '@mui/icons-material/StopOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import ErrorOutlineOutlinedIcon from '@mui/icons-material/ErrorOutlineOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import TextField from '../../components/TextField';
import { AgentError, DEFAULT_AGENT_URL, fetchNodeKeys, fetchNodeKeysFromKeyFiles, fetchStatus, listFiles, readFile, readJob, rememberConn, rememberedConn, sendKey, sendStdin, startJob, stopJob, writeFile } from '../../lib/node/agentClient';
import type { AgentConn, AgentStatus, KeyFileNote, NodeKeysEntry, TtyKey } from '../../lib/node/agentClient';
import { isHex64 } from '../../lib/node/nodeKeys';
import type { InstallTarget } from '../../lib/node/nodeCommands';
import { COMMAND_PRESETS, isLoopbackAgentUrl, isSecretArgv, isWizardArgv, parseCommandLine, resolveCd, validateSubdir } from '../../lib/node/nodeCommands';
import { DEFAULT_COLS, TermEmu } from '../../lib/node/termEmu';
import { useNodeSettingsStore } from '../../store/nodeSettingsStore';
import { useNodeKeysStore } from '../../store/nodeKeysStore';
import { pushHistory, stepHistory } from '../../lib/console/repl';
import NodeWatchCard from './NodeWatchCard';
import ShoestringGuide from './ShoestringGuide';
import OneClickCard from './OneClickCard';
import GuideText from './GuideText';

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
// optional: この PC に元からあっても、tools/ に専用のものを入れられる（入れたものだけ「削除」で消せる）
const TOOL_ROWS: Array<{ key: ToolKey; labelKey: string; install?: string; target?: InstallTarget; optional?: boolean; platforms?: readonly string[] }> = [
  // Docker は、Linux（Ubuntu・Debian 系。sudo を 1 回使う）・Mac（Docker Desktop。sudo は使わない）・Windows（Docker Desktop。署名を確かめ、Windows の確認画面〔UAC〕をご自身が押す。エージェントは昇格しない）で、確認ダイアログを通して入れられる。消すのは OS 側（この画面からは消さない）
  { key: 'docker', labelKey: 'service.node_tool_docker', install: 'irome install docker', target: 'docker', platforms: ['linux', 'darwin', 'win32'] },
  { key: 'node', labelKey: 'service.node_tool_node', install: 'irome install node', target: 'node', optional: true },
  { key: 'python', labelKey: 'service.node_tool_python', install: 'irome install python', target: 'python', optional: true },
  { key: 'symbol-bootstrap', labelKey: 'service.node_tool_bootstrap', install: 'irome install bootstrap', target: 'bootstrap' },
  { key: 'shoestring', labelKey: 'service.node_tool_shoestring', install: 'irome install shoestring', target: 'shoestring' },
  { key: 'symbol-node-watcher', labelKey: 'service.node_tool_nodewatch', install: 'irome install nodewatch', target: 'nodewatch' },
];
const GROUPS = ['check', 'docker', 'install', 'bootstrap', 'shoestring', 'nodewatch'] as const;

// PC に入っていないとき、公式サイトのリンクを出すもの（この画面からは入れない。リンクを開くだけ）
type PcTool = 'docker' | 'node' | 'python';
// 公式の入手先
const OFFICIAL_URL: Record<PcTool, string> = {
  docker: 'https://www.docker.com/products/docker-desktop/',
  node: 'https://nodejs.org/',
  python: 'https://www.python.org/downloads/',
};

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
  // 「ノード構築」の実行中（手順の合間も、ほかのコマンドを受け付けない）と、その中止の印
  const buildingRef = useRef(false);
  const buildCancelRef = useRef(false);
  const [building, setBuilding] = useState(false);
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
  // 秘密鍵が画面に出るコマンド（--show-private・openssl pkey … -text）の確認。同意（チェック）してから、その 1 回だけ実行する。
  const [secretLine, setSecretLine] = useState<string | null>(null);
  const [secretAgree, setSecretAgree] = useState(false);
  // Docker を入れる（sudo を 1 回使う）前の確認。することと、docker グループの注意を読んで同意してから実行する。
  const [dockerAsk, setDockerAsk] = useState(false);
  const [dockerAgree, setDockerAgree] = useState(false);
  // Docker の入れ方の説明は長いので、「入れる」の右の「!」を押したときだけ出す
  const [dockerHowtoOpen, setDockerHowtoOpen] = useState(false);
  // 入れたあとの進め方（Mac・Windows。前半）は「!」、入れ方の説明（後半）は、その右の「?」で出す
  const [dockerGuideOpen, setDockerGuideOpen] = useState(false);
  const dockerMac = status?.platform === 'darwin';
  const dockerWin = status?.platform === 'win32';
  // 確認ダイアログの文言の組（Linux: node_dk_*・Mac: node_dkm_*・Windows: node_dkw_*）
  const dkp = dockerWin ? 'service.node_dkw_' : dockerMac ? 'service.node_dkm_' : 'service.node_dk_';

  // ウォレットへの連携: ノードの公開鍵を読み込み、ハーベスト > キーリンクへ渡す（公開鍵だけ。ウォレットの秘密鍵はここに来ない）
  const navigate = useNavigate();
  const [keySets, setKeySets] = useState<NodeKeysEntry[] | null>(null);
  const [keyPick, setKeyPick] = useState(0);
  // 投票鍵の欄: 手で入れた（または候補を選んだ）ときだけ値を持つ。null のあいだは、選んでいるノードの投票鍵（あれば）を出す。
  const [votingManual, setVotingManual] = useState<string | null>(null);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysError, setKeysError] = useState('');
  // Shoestring の鍵ファイル（秘密鍵のファイル）から公開鍵を読む: 確認のダイアログを通ったときだけ。
  const [keyFileOpen, setKeyFileOpen] = useState(false);
  const [keyFileRead, setKeyFileRead] = useState(false);
  const [keyFileNotes, setKeyFileNotes] = useState<KeyFileNote[]>([]);

  const alive = useRef(true);
  const idRef = useRef(0);
  const jobRef = useRef<string | null>(null);
  // いま動いているジョブが、秘密鍵を画面に出すもの（終わったら、画面を消すよう知らせる）
  const secretJobRef = useRef(false);
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
    if (buildingRef.current) {
      // 構築の途中で切るときは、動いているコマンドも止める（続きは実行しない）
      buildCancelRef.current = true;
      buildingRef.current = false;
      setBuilding(false);
      const cc = connRef.current;
      const jid = jobRef.current;
      if (cc && jid) void stopJob(cc, jid).catch(() => { /* すでに終わっている */ });
    }
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
          if (secretJobRef.current) { secretJobRef.current = false; push('sys', `${t('service.node_secret_after')}\n`); }
          jobRef.current = null;
          if (raw) endTty();
          setRunning(false);
          void refreshStatus(c); // 導入が終わったら、ツールの有無を取り直す
          return;
        }
      } catch (e) {
        if (!alive.current || jobRef.current !== id) return;
        push('err', `${describeError(e)}\n`);
        secretJobRef.current = false;
        jobRef.current = null;
        if (raw) endTty();
        setRunning(false);
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }, [describeError, endTty, push, pushTty, refreshStatus, t]);

  const askUninstall = (target: InstallTarget) => { setUnAgree(false); setUnTarget(target); };
  const askSecret = (line: string) => { setSecretAgree(false); setSecretLine(line); };

  // confirmed: 注意を読んで同意した後の実行（ボタンからも、ターミナルに `irome uninstall …` と打っても、必ず確認を通す）
  // secretOk: 秘密鍵が画面に出ることを、確認ポップアップで同意した後の実行（`--show-private`・`openssl pkey … -text` は、打っても、ひな型からでも、必ず確認を通す）
  const runLine = async (raw: string, confirmed = false, secretOk = false) => {
    const c = connRef.current;
    const line = raw.trim();
    if (!c || line === '' || jobRef.current || buildingRef.current) return;
    // 確認が要るかを見るためだけの、事前の判定（secret: true は、通る形かどうかを見るため。実行の判定は、下で同意の有無どおりにかけ直す）
    const pre = parseCommandLine(line, { wizard: wizardOn, secret: true });
    if (pre.ok && pre.tool === 'irome' && pre.argv[1] === 'uninstall' && !confirmed) { askUninstall(pre.argv[2] as InstallTarget); return; }
    // Docker を入れる（sudo を使う）は、打っても、ボタンからでも、必ず確認を通す。実行したら、最初のパスワードの入力が画面に出ないようにする
    const isDockerInstall = pre.ok && pre.tool === 'irome' && pre.argv[1] === 'install' && pre.argv[2] === 'docker';
    if (isDockerInstall && !confirmed) { setDockerAgree(false); setDockerAsk(true); return; }
    if (pre.ok && isSecretArgv(pre.argv) && !secretOk) { askSecret(line); return; }
    push('cmd', `$ ${line}\n`);
    setHistory((h) => pushHistory(h, line));
    // 画面でも事前に判定する（エージェントは、同じ判定をもう一度かける）
    const parsed = parseCommandLine(line, { wizard: wizardOn, secret: secretOk });
    if (!parsed.ok) { push('err', `${t(`service.node_rej_${parsed.reason}`)}\n`); return; }
    const sub = validateSubdir(cwd);
    if (!sub.ok) { push('err', `${t(`service.node_rej_${sub.reason}`)}\n`); return; }
    // cd は、画面の「作業フォルダ」を変えるだけ（エージェントには送らない）。フォルダは、次に実行するときに無ければ自動で作られる
    if (parsed.tool === 'cd') {
      const to = resolveCd(sub.value, parsed.argv[1]);
      if (!to.ok) { push('err', `${t(`service.node_rej_${to.reason}`)}\n`); return; }
      setCwd(to.value);
      push('sys', `${t('service.node_cd_done', { path: to.value === '' ? t('service.node_cd_root') : to.value })}\n`);
      return;
    }
    const isSecret = secretOk && isSecretArgv(parsed.argv);
    // パスワードを聞かれるのは、Linux の sudo だけ（Mac は Docker Desktop 自身の画面で、Windows は Windows の確認画面〔UAC〕で入れる）
    if (isDockerInstall && status?.platform === 'linux') setSecret(true);
    try {
      // wizard を有効にしているときだけ、wizard を通し、出力を生で受け取って簡易ターミナルで描く。secret は、確認ポップアップで同意したときだけ付く
      const { id, raw } = await startJob(c, line, sub.value, { wizard: wizardOn, emulate: wizardOn && isWizardArgv(parsed.argv), secret: isSecret });
      if (!alive.current) return;
      jobRef.current = id;
      secretJobRef.current = isSecret;
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
    if (buildingRef.current) return;
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
    if (buildingRef.current) buildCancelRef.current = true;
    const c = connRef.current;
    const id = jobRef.current;
    if (!c || !id) return;
    try { await stopJob(c, id); } catch (e) { push('err', `${describeError(e)}\n`); }
  };

  // 「ノード構築」用: 1 行を実行して、終わるまで待つ（終了コードを返す。実行できなかったときは null）。
  // 通る経路は、ターミナルの「実行」と同じ（画面の許可の判定 → エージェントがもう一度判定）。wizard・秘密鍵が出る形は使わない。
  const execStep = useCallback(async (line: string, sub: string): Promise<number | null> => {
    const c = connRef.current;
    if (!c) return null;
    push('cmd', `$ ${line}\n`);
    const parsed = parseCommandLine(line, {});
    if (!parsed.ok) { push('err', `${t(`service.node_rej_${parsed.reason}`)}\n`); return null; }
    const dir = validateSubdir(sub);
    if (!dir.ok) { push('err', `${t(`service.node_rej_${dir.reason}`)}\n`); return null; }
    let id: string;
    try {
      ({ id } = await startJob(c, line, dir.value, {}));
    } catch (e) {
      push('err', `${describeError(e)}\n`);
      return null;
    }
    jobRef.current = id;
    let from = 0;
    try {
      for (;;) {
        const chunk = await readJob(c, id, from);
        if (!alive.current) return null;
        if (chunk.truncated) push('sys', `${t('service.node_truncated')}\n`);
        if (chunk.text) push('out', chunk.text);
        from = chunk.next;
        if (chunk.done) {
          push('sys', `${t('service.node_exit', { code: chunk.exitCode ?? '?' })}\n`);
          return chunk.exitCode;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } catch (e) {
      if (alive.current) push('err', `${describeError(e)}\n`);
      return null;
    } finally {
      if (jobRef.current === id) jobRef.current = null;
    }
  }, [describeError, push, t]);

  // Docker の確認: `docker --version`・`docker compose version`・`docker info` を、自動で順に実行する（打たなくてよい）。
  // 実行中は、ほかのコマンドを受け付けない（構築と同じ印を使う）。1 つでも失敗したら、そこで止める。
  const [dockerChecking, setDockerChecking] = useState(false);
  const checkDocker = async () => {
    if (buildingRef.current || jobRef.current || !connRef.current) return;
    buildingRef.current = true;
    buildCancelRef.current = false;
    setDockerChecking(true);
    setRunning(true);
    try {
      for (const line of ['docker --version', 'docker compose version', 'docker info']) {
        if (buildCancelRef.current || !alive.current) break;
        if ((await execStep(line, '')) !== 0) break;
      }
    } finally {
      buildingRef.current = false;
      if (alive.current) {
        setDockerChecking(false);
        setRunning(false);
        const c = connRef.current;
        if (c) void refreshStatus(c);
      }
    }
  };

  const setBuildingState = (b: boolean) => {
    buildingRef.current = b;
    if (b) buildCancelRef.current = false;
    setBuilding(b);
    setRunning(b);
  };

  // ノードの公開鍵を読む（target/addresses.yml の publicKey だけ。秘密鍵は、エージェントも返さない）。投票鍵は、出ていれば拾う。
  const loadNodeKeys = async () => {
    const c = connRef.current;
    if (!c) return;
    setKeysLoading(true);
    setKeysError('');
    try {
      const sets = await fetchNodeKeys(c);
      if (!alive.current) return;
      setKeyFileRead(false);
      setKeyFileNotes([]);
      setKeySets(sets);
      setKeyPick(0);
      setVotingManual(null);
    } catch (e) {
      if (alive.current) { setKeySets(null); setKeysError(describeError(e)); }
    } finally {
      if (alive.current) setKeysLoading(false);
    }
  };

  // 鍵ファイル（remote.key.pem / vrf.key.pem / config-harvesting.properties）から、リモート・VRF 鍵の公開鍵を読む（Shoestring）。
  // エージェントが秘密鍵のファイルを開くので、確認のダイアログで「読む」を押したときだけ。秘密鍵は、エージェントが公開鍵を作った時点で捨てる。
  const readKeyFiles = async () => {
    const c = connRef.current;
    setKeyFileOpen(false);
    if (!c) return;
    setKeysLoading(true);
    setKeysError('');
    try {
      const r = await fetchNodeKeysFromKeyFiles(c);
      if (!alive.current) return;
      setKeySets(r.nodes);
      setKeyPick((prev) => Math.min(prev, Math.max(0, r.nodes.length - 1)));
      setKeyFileRead(true);
      setKeyFileNotes(r.notes);
    } catch (e) {
      if (alive.current) setKeysError(describeError(e));
    } finally {
      if (alive.current) setKeysLoading(false);
    }
  };
  const canReadKeyFiles = keySets !== null && (keySets.length === 0 || keySets.some((k) => k.remote === null || k.vrf === null));

  const picked = keySets !== null ? (keySets[Math.min(keyPick, Math.max(0, keySets.length - 1))] ?? null) : null;
  const votingValue = (votingManual ?? picked?.voting ?? '').trim();
  const votingBad = votingValue !== '' && !isHex64(votingValue);
  // 選んだ投票鍵の期間は、鍵の木のファイルのヘッダから分かるときだけ（無ければ、ハーベスト画面の既定値）
  const votingEntry = picked?.votings.find((v) => v.key === votingValue.toUpperCase()) ?? null;
  const canHandOver = !votingBad && ((picked?.node ?? picked?.remote ?? picked?.vrf ?? null) !== null || isHex64(votingValue));
  // ウォレットのハーベスト > キーリンクへ。入力欄に入るだけで、リンクの送信は、そちらの確認とパスワードを通る。
  const handOverKeys = () => {
    useNodeKeysStore.getState().set({ node: picked?.node ?? null, remote: picked?.remote ?? null, vrf: picked?.vrf ?? null, voting: isHex64(votingValue) ? votingValue : null, votingStart: votingEntry?.start ?? null, votingEnd: votingEntry?.end ?? null });
    void navigate('/harvest');
  };


  // 「Shoestring でノードを建てる手順」から: ひな型を入力欄に入れる / overrides.ini などのひな形を設定ファイルの欄に入れる / config.ini を開く。
  // 設定ファイルのパスは作業場所からの相対なので、作業フォルダ（cwd）の中のファイルとして扱う（Shoestring は、実行したフォルダにファイルを作る）。
  const scrollTo = (id: string) => { window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); };
  const inWorkdir = (name: string): string => { const sub = validateSubdir(cwd); return sub.ok && sub.value !== '' ? `${sub.value}/${name}` : name; };
  const pickGuideLine = (line: string) => { setInput(line); histIndex.current = history.length; scrollTo('node-terminal'); };
  const putFileTemplate = (name: string, content: string) => {
    if (fileDirty && !window.confirm(t('service.node_file_confirm_discard'))) return;
    setFilePath(inWorkdir(name));
    setFileText(content);
    setFileDirty(true);
    setFileMsg({ severity: 'info', text: t('service.node_ss_file_template_done', { path: inWorkdir(name) }) });
    scrollTo('node-files');
  };
  const openGuideConfig = () => { void openFile(inWorkdir('config.ini')); scrollTo('node-files'); };

  const connected = conn !== null;
  const hasDock = connected && status !== null;
  const dock = useNodeSettingsStore((st) => st.dock);
  const setDock = useNodeSettingsStore((st) => st.setDock);
  const [presetGroup, setPresetGroup] = useState<(typeof GROUPS)[number]>('check');
  // 「Shoestring でノードを建てる手順」は、この画面の中の別の画面（?view=shoestring）。ターミナルと設定ファイルは、そのまま使える。
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'shoestring' ? 'shoestring' : 'main';
  const openGuide = () => { setParams({ view: 'shoestring' }); window.scrollTo({ top: 0 }); };
  const closeGuide = () => { setParams({}); window.scrollTo({ top: 0 }); };
  const cardSx = { border: 1, borderColor: 'divider', borderRadius: 1, p: 2, mt: 2, textAlign: 'left' } as const;

  const terminalCard = (
    <Box sx={cardSx} id="node-terminal">
                <Typography sx={{ fontWeight: 700, mb: 1 }}>{t('service.node_terminal_title')}</Typography>
                {/* wizard（対話式）の設定。有効にしたときだけ、wizard を実行でき、簡易ターミナルで描く */}
                <Box sx={{ mb: 2 }}>
                  <FormControlLabel
                    control={<Switch checked={wizardOn} disabled={running} onChange={(e) => setWizard(e.target.checked)} />}
                    label={<Typography sx={{ fontWeight: 700, fontSize: '0.95rem' }}>{t('service.node_wizard_enable')}</Typography>}
                  />
                  <Box sx={{ color: 'text.secondary' }}><GuideText size="0.85rem" text={t('service.node_wizard_hint')} /></Box>
                  {wizardOn && !status?.pty && <Alert severity="warning" sx={{ mt: 1 }}><GuideText size="inherit" text={t('service.node_wizard_needs_pty')} /></Alert>}
                  {wizardOn && (
                    <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 1 }}>
                      {['symbol-bootstrap wizard', 'shoestring wizard'].map((w) => (
                        <Button key={w} size="small" variant="outlined" disabled={running} onClick={() => { setInput(w); histIndex.current = history.length; }} sx={{ fontFamily: MONO, textTransform: 'none' }}>
                          {w}
                        </Button>
                      ))}
                    </Stack>
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
  );
  const filesCard = (
    <Box sx={cardSx} id="node-files">
                <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                  <Typography sx={{ fontWeight: 700 }}>{t('service.node_files_title')}</Typography>
                  <Button size="small" startIcon={<RefreshOutlinedIcon />} onClick={() => { if (connRef.current) void refreshFiles(connRef.current); }}>{t('service.node_files_refresh')}</Button>
                </Stack>
                <Box sx={{ color: 'text.secondary', mb: 1.5 }}><GuideText size="0.85rem" text={t('service.node_files_hint')} /></Box>
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
  );
  const presetsCard = (
    <Box sx={cardSx}>
                <Typography sx={{ fontWeight: 700, mb: 1.5 }}>{t('service.node_presets_title')}</Typography>
                <TextField select label={t('service.node_preset_group')} value={presetGroup} onChange={(e) => setPresetGroup(e.target.value as (typeof GROUPS)[number])} fullWidth sx={{ mb: 2 }}>
                  {GROUPS.map((g) => <MenuItem key={g} value={g}>{t(`service.node_group_${g}`)}</MenuItem>)}
                </TextField>
                <Stack spacing={0.75}>
                  {COMMAND_PRESETS.filter((p) => p.group === presetGroup).map((p) => (
                    <Stack key={p.line} direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
                      <Button size="small" variant="outlined" disabled={running} onClick={() => { setInput(p.line); histIndex.current = history.length; }} sx={{ fontFamily: MONO, textTransform: 'none', textAlign: 'left', wordBreak: 'break-all' }}>{p.line}</Button>
                      <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>{t(p.noteKey)}</Typography>
                    </Stack>
                  ))}
                </Stack>
                {presetGroup === 'bootstrap' && <Alert severity="info" sx={{ mt: 1 }}><GuideText size="inherit" text={t('service.node_warn_testnet')} /></Alert>}
              </Box>
  );

  const connCard = (
    <Box sx={cardSx}>
      <Typography sx={{ fontWeight: 700, mb: 1 }}>{t('service.node_conn_title')}</Typography>
      {!connected && <Box sx={{ mb: 2, color: 'text.secondary' }}><GuideText size="0.9rem" text={t('service.node_conn_howto')} /></Box>}
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
  );
  const watchCard = <NodeWatchCard agent={conn} cardSx={cardSx} />;
  const bottomDock = hasDock && dock === 'bottom' ? <>{terminalCard}{filesCard}</> : null;

  return (
    <Box sx={{ minHeight: '100vh', pb: 4 }}>
      <Box sx={{ width: '100%', px: { xs: 2, md: 4 }, py: 2, boxSizing: 'border-box', textAlign: 'left' }}>
        <Typography sx={{ fontSize: '1.4rem', fontWeight: 400 }}>{t('service.node_title')}</Typography>
        <Typography sx={{ mt: 1, color: 'text.secondary' }}>{t('service.node_intro')}</Typography>

        {/* ターミナルと設定ファイルを置く場所（右 / 下）。接続中だけ */}
        {hasDock && (
          <Stack direction="row" spacing={1.5} sx={{ mt: 2, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <Typography sx={{ fontSize: '0.85rem', color: 'text.secondary' }}>{t('service.node_dock_label')}</Typography>
            <ToggleButtonGroup size="small" exclusive value={dock} onChange={(_, v: 'right' | 'bottom' | null) => { if (v) setDock(v); }} aria-label={t('service.node_dock_label')}>
              <ToggleButton value="right">{t('service.node_dock_right')}</ToggleButton>
              <ToggleButton value="bottom">{t('service.node_dock_bottom')}</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
        )}

        {/* 接続前: エージェントに接続（左）とノードの状態・ウォッチ（右）。狭い画面では縦に並ぶ */}
        {view === 'main' && !hasDock && (
          <Box sx={{ display: 'grid', gap: 2, alignItems: 'start', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(0, 1fr)' } }}>
            <Box sx={{ minWidth: 0 }}>{connCard}</Box>
            <Box sx={{ minWidth: 0 }}>{watchCard}</Box>
          </Box>
        )}

        <Box sx={{ display: 'grid', gap: 2, alignItems: 'start', gridTemplateColumns: hasDock && dock === 'right' ? { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(0, 1fr)' } : 'minmax(0, 1fr)' }}>
          <Box sx={{ minWidth: 0 }}>
            {view === 'shoestring' ? (
              <>
                <Button onClick={closeGuide} sx={{ mt: 2, textTransform: 'none' }}>{t('service.node_ss_back')}</Button>
                {/* Shoestring でノードを建てる手順（説明は、エージェントに繋がっていなくても読める） */}
                <ShoestringGuide cardSx={cardSx} connected={connected} running={running} onPickLine={pickGuideLine} onFileTemplate={putFileTemplate} onOpenConfig={openGuideConfig} />
                {bottomDock}
              </>
            ) : (
              <>
                {hasDock && connCard}
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
                      const pcTool: PcTool | null = row.key === 'docker' || row.key === 'node' || row.key === 'python' ? row.key : null;
                      const noWrap = row.optional || row.key === 'docker';
                      return (
                        <Box key={row.key}><Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: noWrap ? 'nowrap' : 'wrap', rowGap: 0.5, minHeight: 32 }}>
                          <Typography sx={{ width: { xs: 96, sm: 180 }, minWidth: 0, flexShrink: 0 }}>{t(row.labelKey)}</Typography>
                          <Chip size="small" sx={{ flexShrink: 0 }} color={st.found ? 'success' : 'default'} variant={st.found ? 'filled' : 'outlined'} label={st.found ? t('service.node_tool_found') : t('service.node_tool_missing')} />
                          {st.found && st.version && <Typography sx={{ fontFamily: MONO, fontSize: '0.8rem', color: 'text.secondary', whiteSpace: 'nowrap', flexShrink: 0 }}>{st.version}</Typography>}
                          {!st.found && pcTool !== null && <Button size="small" variant="outlined" sx={{ flexShrink: 0, whiteSpace: 'nowrap' }} href={pcTool === 'docker' && status.platform === 'linux' ? 'https://docs.docker.com/engine/install/' : OFFICIAL_URL[pcTool]} target="_blank" rel="noopener noreferrer">{t('service.node_official_site')}</Button>}
                          {row.install && (!row.platforms || row.platforms.includes(status.platform)) && (row.optional ? !st.local : !st.found) && <Button size="small" variant="outlined" sx={noWrap ? { flexShrink: 0, whiteSpace: 'nowrap' } : undefined} disabled={running} onClick={() => void runLine(row.install as string)}>{t(row.optional && st.found ? 'service.node_install_local' : 'service.node_install')}</Button>}
                          {row.key === 'docker' && !st.found && (dockerMac || dockerWin) && <IconButton size="small" sx={{ flexShrink: 0 }} aria-label={t('service.node_docker_guide_toggle')} aria-expanded={dockerGuideOpen} onClick={() => setDockerGuideOpen((v) => !v)}><ErrorOutlineOutlinedIcon fontSize="small" /></IconButton>}
                          {row.key === 'docker' && !st.found && <IconButton size="small" sx={{ flexShrink: 0 }} aria-label={t('service.node_docker_howto_toggle')} aria-expanded={dockerHowtoOpen} onClick={() => setDockerHowtoOpen((v) => !v)}><HelpOutlineIcon fontSize="small" /></IconButton>}
                          {st.found && row.target && st.local && <Button size="small" variant="outlined" color="error" disabled={running} onClick={() => askUninstall(row.target as InstallTarget)}>{t('service.node_uninstall')}</Button>}
                          {row.key === 'docker' && st.found && <Button size="small" variant="outlined" sx={{ flexShrink: 0, whiteSpace: 'nowrap' }} disabled={running} onClick={() => void checkDocker()}>{dockerChecking ? t('service.node_docker_checking') : t('service.node_docker_check')}</Button>}
                          {st.found && row.target && !st.local && !row.optional && <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem' }}>{t('service.node_uninstall_outside')}</Typography>}
                        </Stack>
                        {row.key === 'docker' && !st.found && (dockerMac || dockerWin) && dockerGuideOpen && (
                          <Box sx={{ color: 'text.secondary', mt: 0.5 }}><GuideText size="0.8rem" text={t(`${dkp}guide`)} /></Box>
                        )}
                        {row.key === 'docker' && !st.found && dockerHowtoOpen && (
                          <Box sx={{ color: 'text.secondary', mt: 0.5 }}><GuideText size="0.8rem" text={t('service.node_docker_howto')} /></Box>
                        )}
                        </Box>
                      );
                    })}
                  </Stack>
                  <Box sx={{ color: 'text.secondary', mt: 1.5 }}><GuideText size="0.8rem" text={t('service.node_uninstall_hint')} /></Box>
                </Box>
                {/* ワンクリックで構築する（Docker・Python・Shoestring が入っているときだけ押せる） */}
                {conn && (
                  <OneClickCard
                    cardSx={cardSx} status={status} agent={conn} otherBusy={running && !building}
                    exec={execStep} note={push} onBuilding={setBuildingState} onStop={() => void stop()} isCancelled={() => buildCancelRef.current}
                    describeError={describeError} onFinished={() => { const c = connRef.current; if (c) { void refreshStatus(c); void refreshFiles(c); } }} onOpenGuide={openGuide}
                  />
                )}
                  </>
                )}

                {/* ターミナル・設定ファイル（置く場所が「下」のとき） */}
                {bottomDock}

                {/* ノードの状態（REST を見るだけなので、エージェントに繋がっていなくても使える） */}
                {hasDock && watchCard}

                {connected && status && (
                  <>
                {/* ウォレットに連携（ノード鍵・ハーベスト鍵・VRF 鍵・投票鍵の公開鍵を、ハーベスト > キーリンクへ渡す） */}
                <Box sx={cardSx}>
                  <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                    <Typography sx={{ fontWeight: 700 }}>{t('service.node_link_title')}</Typography>
                    <Button size="small" variant="outlined" startIcon={<RefreshOutlinedIcon />} disabled={keysLoading} onClick={() => void loadNodeKeys()}>
                      {keysLoading ? t('service.node_link_loading') : t('service.node_link_load')}
                    </Button>
                  </Stack>
                  <Box sx={{ color: 'text.secondary', mb: 1.5 }}><GuideText size="0.85rem" text={t('service.node_link_hint')} /></Box>
                  {keysError && <Alert severity="error" sx={{ mb: 1.5 }}>{keysError}</Alert>}
                  {keySets !== null && keySets.length === 0 && <Alert severity="info" sx={{ mb: 1.5 }}><GuideText size="inherit" text={t('service.node_link_none')} /></Alert>}
                  {keySets !== null && keySets.length > 1 && (
                    <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mb: 1.5 }}>
                      {keySets.map((k, i) => (
                        <Chip key={`${k.source}:${k.name}:${i}`} size="small" clickable variant={i === keyPick ? 'filled' : 'outlined'} label={k.name || k.source} onClick={() => { setKeyPick(i); setVotingManual(null); }} sx={{ fontFamily: MONO }} />
                      ))}
                    </Stack>
                  )}
                  {picked !== null && (
                    <Stack spacing={1.25} sx={{ mb: 1.5 }}>
                      {([['node', 'service.node_link_node'], ['remote', 'service.node_link_remote'], ['vrf', 'service.node_link_vrf']] as const).map(([k, labelKey]) => (
                        <Box key={k}>
                          <Typography sx={{ fontSize: '0.85rem', fontWeight: 700 }}>{t(labelKey)}</Typography>
                          <Typography sx={{ fontFamily: MONO, fontSize: '0.8rem', wordBreak: 'break-all', color: picked[k] ? 'text.primary' : 'text.secondary' }}>{picked[k] ?? t('service.node_link_missing')}</Typography>
                        </Box>
                      ))}
                      {picked.source !== '' && <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', fontFamily: MONO }}>{picked.source}</Typography>}
                    </Stack>
                  )}
                  {keySets !== null && (
                    <Box sx={{ mb: 1.5 }}>
                      <TextField
                        label={t('service.node_link_voting')} value={votingValue} onChange={(e) => setVotingManual(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 64))} fullWidth
                        error={votingBad} helperText={votingBad ? t('service.node_link_voting_bad') : t('service.node_link_voting_hint')}
                        slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off', style: { fontFamily: MONO, fontSize: '0.8rem' } } }}
                      />
                      {picked !== null && picked.votings.length > 0 && (
                        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mt: 1, alignItems: 'center' }}>
                          <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem' }}>{t('service.node_link_voting_found')}</Typography>
                          {picked.votings.map((v) => (
                            <Chip
                              key={`${v.key}:${v.start ?? ''}:${v.end ?? ''}`} size="small" clickable variant={v.key === votingValue.toUpperCase() ? 'filled' : 'outlined'}
                              label={`${v.key.slice(0, 8)}…${v.key.slice(-8)}${v.start !== null && v.end !== null ? `  ${t('service.node_link_voting_epochs', { start: v.start, end: v.end })}` : ''}`}
                              onClick={() => setVotingManual(v.key)} sx={{ fontFamily: MONO }}
                            />
                          ))}
                        </Stack>
                      )}
                      {votingEntry !== null && votingEntry.start !== null && <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', mt: 0.5 }}>{t('service.node_link_voting_range_note')}</Typography>}
                    </Box>
                  )}
                  {canReadKeyFiles && (
                    <Box sx={{ mb: 1.5 }}>
                      <Button size="small" variant="outlined" disabled={keysLoading} onClick={() => setKeyFileOpen(true)}>{t('service.node_link_secret_btn')}</Button>
                      <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', mt: 0.5 }}>{t('service.node_link_secret_hint')}</Typography>
                    </Box>
                  )}
                  {keyFileRead && keySets !== null && !keySets.some((k) => k.remote !== null || k.vrf !== null) && (
                    <Alert severity="info" sx={{ mb: 1.5 }}>{t('service.node_link_secret_none')}</Alert>
                  )}
                  {keyFileNotes.map((n) => (
                    <Alert key={`${n.code}:${n.kind}`} severity="info" sx={{ mb: 1.5 }}>{t(`service.node_link_secret_${n.code}`, { kind: t(`harvest.keys_kind_${n.kind}`) })}</Alert>
                  ))}
                  {keySets !== null && (
                    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                      <Button variant="contained" disabled={!canHandOver} onClick={handOverKeys}>{t('service.node_link_go')}</Button>
                    </Stack>
                  )}
                  <Alert severity="info" sx={{ mt: 1.5 }}><GuideText size="inherit" text={t('service.node_link_note')} /></Alert>
                </Box>

                    {presetsCard}
                  </>
                )}

            {/* 実行できるコマンド */}
            <Box sx={cardSx}>
              <Typography sx={{ fontWeight: 700, mb: 0.5 }}>{t('service.node_allowed_title')}</Typography>
              <Box sx={{ color: 'text.secondary' }}><GuideText size="0.9rem" text={t('service.node_allowed_body')} /></Box>
            </Box>
              </>
            )}
          </Box>
          {hasDock && dock === 'right' && (
            <Box sx={{ minWidth: 0, position: { lg: 'sticky' }, top: { lg: 8 } }}>
              {terminalCard}
              {filesCard}
            </Box>
          )}
        </Box>

        {/* Shoestring の鍵ファイルを読む前の確認（秘密鍵のファイルを開くので、押したときだけ） */}
        <Dialog open={keyFileOpen} onClose={() => setKeyFileOpen(false)} maxWidth="sm" fullWidth>
          <DialogTitle>{t('service.node_link_secret_title')}</DialogTitle>
          <DialogContent>
            <Typography sx={{ fontSize: '0.9rem', mb: 1.5 }}>{t('service.node_link_secret_body')}</Typography>
            <Typography sx={{ fontFamily: MONO, fontSize: '0.8rem', mb: 1.5 }}>remote.key.pem / vrf.key.pem / config-harvesting.properties</Typography>
            <Alert severity="info">{t('service.node_link_secret_safe')}</Alert>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setKeyFileOpen(false)}>{t('service.node_link_secret_cancel')}</Button>
            <Button variant="contained" onClick={() => void readKeyFiles()}>{t('service.node_link_secret_go')}</Button>
          </DialogActions>
        </Dialog>
        {/* 秘密鍵が画面に出るコマンドの確認（--show-private・openssl pkey … -text）。同意（チェック）しないと実行できない */}
        <Dialog open={secretLine !== null} onClose={() => setSecretLine(null)} maxWidth="sm" fullWidth>
          <DialogTitle>{t('service.node_secret_title')}</DialogTitle>
          <DialogContent>
            <Alert severity="warning" sx={{ mb: 2 }}>{t('service.node_secret_lead')}</Alert>
            <Typography sx={{ fontWeight: 700, fontSize: '0.9rem' }}>{t('service.node_secret_cmd_title')}</Typography>
            <Typography sx={{ fontFamily: MONO, fontSize: '0.85rem', mb: 1.5, wordBreak: 'break-all' }}>{secretLine}</Typography>
            <Typography sx={{ fontSize: '0.9rem', mb: 1 }}>{t('service.node_secret_body')}</Typography>
            <Box component="ul" sx={{ mt: 0.5, mb: 1.5, pl: 2.5, fontSize: '0.9rem' }}>
              <li>{t('service.node_secret_check_screen')}</li>
              <li>{t('service.node_secret_check_copy')}</li>
              <li>{t('service.node_secret_check_clear')}</li>
            </Box>
            <FormControlLabel control={<Checkbox checked={secretAgree} onChange={(e) => setSecretAgree(e.target.checked)} />} label={<Typography sx={{ fontSize: '0.9rem' }}>{t('service.node_secret_agree')}</Typography>} />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setSecretLine(null)}>{t('service.node_secret_cancel')}</Button>
            <Button color="error" variant="contained" disabled={!secretAgree || running} onClick={() => { const line = secretLine; setSecretLine(null); if (line !== null) void runLine(line, false, true); }}>{t('service.node_secret_go')}</Button>
          </DialogActions>
        </Dialog>
        {/* Docker を入れる前の確認。Linux は sudo を 1 回使う。Mac は sudo を使わず、Docker Desktop を置いて起動する。Windows は、署名を確かめて、Windows の確認画面（UAC）でご自身が「はい」を押す */}
        <Dialog open={dockerAsk} onClose={() => setDockerAsk(false)} maxWidth="sm" fullWidth>
          <DialogTitle>{t(`${dkp}title`)}</DialogTitle>
          <DialogContent>
            <Alert severity={dockerMac || dockerWin ? 'info' : 'warning'} sx={{ mb: 2 }}>{t(`${dkp}lead`)}</Alert>
            <Typography sx={{ fontWeight: 700, fontSize: '0.9rem' }}>{t(`${dkp}does_title`)}</Typography>
            <Box sx={{ mb: 1.5 }}><GuideText size="0.9rem" text={t(`${dkp}does_body`)} /></Box>
            <Typography sx={{ fontWeight: 700, fontSize: '0.9rem' }}>{t('service.node_dk_limits_title')}</Typography>
            <Box sx={{ mb: 1.5 }}><GuideText size="0.9rem" text={t(`${dkp}limits_body`)} /></Box>
            <Typography sx={{ fontWeight: 700, fontSize: '0.9rem' }}>{t(dockerMac || dockerWin ? `${dkp}first_title` : 'service.node_dk_group_title')}</Typography>
            <Box sx={{ mb: 1.5 }}><GuideText size="0.9rem" text={t(dockerMac || dockerWin ? `${dkp}first_body` : 'service.node_dk_group_body')} /></Box>
            <FormControlLabel control={<Checkbox checked={dockerAgree} onChange={(e) => setDockerAgree(e.target.checked)} />} label={<Typography sx={{ fontSize: '0.9rem' }}>{t('service.node_dk_agree')}</Typography>} />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDockerAsk(false)}>{t('service.node_dk_cancel')}</Button>
            <Button color={dockerMac || dockerWin ? 'primary' : 'warning'} variant="contained" disabled={!dockerAgree || running} onClick={() => { setDockerAsk(false); void runLine('irome install docker', true); }}>{t(`${dkp}do`)}</Button>
          </DialogActions>
        </Dialog>
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
                <Box sx={{ mb: 1.5 }}><GuideText size="0.9rem" text={t('service.node_un_keeps_body')} /></Box>
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
      </Box>
    </Box>
  );
}
