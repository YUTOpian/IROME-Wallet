import { useCallback, useEffect, useRef, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import { useTranslation } from 'react-i18next';
import { AgentError, fetchExistingNodes } from '../../lib/node/agentClient';
import type { AgentConn } from '../../lib/node/agentClient';
import { existingPresets, nodeAt } from '../../lib/node/existingNodes';
import type { ExistingNode } from '../../lib/node/existingNodes';
import GuideText from './GuideText';

// 「既存のノードを使う」: すでに動いているノード（symbol-bootstrap 製・Shoestring 製）を、この画面で操る入口。
// エージェントが、作業場所の中から、ノードのフォルダを名前だけで探して返す（ファイルの中身は開かない）。見つかったものは、
// 作業フォルダにする・よく使うコマンドを入力欄に入れる、ができる（実行は Enter。新しい許可は増えない）。
// 作り直す・消すおそれのあるコマンドを、見つかったノードのフォルダで打つときの確認は、NodePage 側（riskOnExisting）。
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

interface Props {
  cardSx: object;
  agent: AgentConn;
  /** エージェントの作業場所（表示用） */
  workspace: string;
  /** 画面の「作業フォルダ」 */
  cwd: string;
  /** コマンドの実行中（作業フォルダの変更・ひな型の入力はしない） */
  running: boolean;
  /** 見つけたノード（null はまだ探していない）。確認の判定にも使うので、NodePage が持つ。 */
  nodes: ExistingNode[] | null;
  onNodes: (nodes: ExistingNode[]) => void;
  /** 作業フォルダを変える。line があれば、入力欄にも入れる（実行は Enter）。 */
  onUse: (cwd: string, line?: string) => void;
  describeError: (e: unknown) => string;
}

export default function ExistingNodeCard({ cardSx, agent, workspace, cwd, running, nodes, onNodes, onUse, describeError }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ old: boolean; text: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const found = await fetchExistingNodes(agent);
      if (alive.current) onNodes(found);
    } catch (e) {
      // 古いエージェントには、この機能が無い（not_found）
      if (alive.current) setError({ old: e instanceof AgentError && e.kind === 'other' && e.reason === 'not_found', text: describeError(e) });
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [agent, describeError, onNodes]);

  // 繋いだときに、1 回だけ自動で探す（名前を見るだけ。押し直すと、もう一度探す）
  const scanned = useRef(false);
  useEffect(() => { if (!scanned.current && nodes === null) { scanned.current = true; void scan(); } }, [nodes, scan]);

  const here = nodes ? nodeAt(cwd, nodes) : null;
  const dirLabel = (d: string) => (d === '' ? t('service.node_ex_root') : d);

  return (
    <Box sx={cardSx}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography sx={{ fontWeight: 700 }}>{t('service.node_ex_title')}</Typography>
        <Button size="small" variant="outlined" startIcon={loading ? <CircularProgress size={14} /> : <RefreshOutlinedIcon />} disabled={loading} onClick={() => void scan()}>
          {loading ? t('service.node_ex_finding') : t('service.node_ex_find')}
        </Button>
      </Stack>
      <Box sx={{ color: 'text.secondary', mb: 1.5 }}><GuideText size="0.85rem" text={t('service.node_ex_intro')} /></Box>
      <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', mb: 1.5, wordBreak: 'break-all' }}>
        {t('service.node_workspace')}: <Box component="span" sx={{ fontFamily: MONO }}>{workspace}</Box>
      </Typography>

      {error && <Alert severity={error.old ? 'info' : 'error'} sx={{ mb: 1.5 }}>{error.old ? t('service.node_ex_old_agent') : error.text}</Alert>}
      {nodes !== null && nodes.length === 0 && !error && <Alert severity="info" sx={{ mb: 1.5 }}><GuideText size="inherit" text={t('service.node_ex_none')} /></Alert>}

      {nodes !== null && nodes.length > 0 && (
        <Stack spacing={1.5} sx={{ mb: 1.5 }}>
          {nodes.map((n) => {
            const current = here === n;
            return (
              <Box key={`${n.kind}:${n.dir}`} sx={{ border: 1, borderColor: current ? 'primary.main' : 'divider', borderRadius: 1, p: 1.5, textAlign: 'left' }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5, mb: 1 }}>
                  <Chip size="small" color="primary" variant="outlined" label={t(`service.node_ex_kind_${n.kind}`)} />
                  <Typography sx={{ fontFamily: MONO, fontSize: '0.85rem', wordBreak: 'break-all' }}>{dirLabel(n.dir)}</Typography>
                  {current && <Chip size="small" color="success" label={t('service.node_ex_current')} />}
                </Stack>
                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1, mb: 1 }}>
                  <Button size="small" variant="outlined" disabled={running} onClick={() => onUse(n.dir)}>{t('service.node_ex_use_dir')}</Button>
                  {n.composeDir !== n.dir && <Button size="small" variant="outlined" disabled={running} onClick={() => onUse(n.composeDir)}>{t('service.node_ex_use_compose', { path: dirLabel(n.composeDir) })}</Button>}
                </Stack>
                <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', mb: 0.5 }}>{t('service.node_ex_cmds')}</Typography>
                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
                  {existingPresets(n).map((p) => (
                    <Button key={`${p.cwd}|${p.line}`} size="small" variant="text" disabled={running} sx={{ textTransform: 'none', fontFamily: MONO, fontSize: '0.78rem' }} onClick={() => onUse(p.cwd, p.line)}>{p.line}</Button>
                  ))}
                </Stack>
              </Box>
            );
          })}
        </Stack>
      )}

      <Accordion disableGutters variant="outlined" slotProps={{ transition: { unmountOnExit: true } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}><Typography sx={{ fontWeight: 700, fontSize: '0.9rem' }}>{t('service.node_ex_next_title')}</Typography></AccordionSummary>
        <AccordionDetails sx={{ textAlign: 'left' }}><GuideText size="0.85rem" text={t('service.node_ex_next')} /></AccordionDetails>
      </Accordion>
      <Accordion disableGutters variant="outlined" slotProps={{ transition: { unmountOnExit: true } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}><Typography sx={{ fontWeight: 700, fontSize: '0.9rem' }}>{t('service.node_ex_limits_title')}</Typography></AccordionSummary>
        <AccordionDetails sx={{ textAlign: 'left' }}><GuideText size="0.85rem" text={t('service.node_ex_limits')} /></AccordionDetails>
      </Accordion>
    </Box>
  );
}
