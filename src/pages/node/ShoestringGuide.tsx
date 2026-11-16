import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useTranslation } from 'react-i18next';
import { COMMAND_PRESETS } from '../../lib/node/nodeCommands';
import { SHOESTRING_STEPS } from '../../lib/node/shoestringGuide';

// 「Shoestring でノードを建てる手順」: 公式ドキュメント（インストール / ノードの作成と実行 / ノードの保守）の順に、
// 説明とコマンドのひな型を並べる。ひな型は、押すと入力欄に入るだけ（実行は Enter）。中身は lib/node/shoestringGuide.ts。
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

interface Props {
  cardSx: object;
  /** エージェントに繋がっているか（繋がっていなくても説明は読める。ボタンだけ止める） */
  connected: boolean;
  /** コマンドの実行中（ひな型は入れない） */
  running: boolean;
  onPickLine: (line: string) => void;
  onFileTemplate: (name: string, content: string) => void;
  onOpenConfig: () => void;
}

const noteOf = (line: string): string | null => COMMAND_PRESETS.find((p) => p.line === line)?.noteKey ?? null;

export default function ShoestringGuide({ cardSx, connected, running, onPickLine, onFileTemplate, onOpenConfig }: Props) {
  const { t } = useTranslation();
  return (
    <Box sx={cardSx}>
      <Typography sx={{ fontWeight: 700 }}>{t('service.node_ss_title')}</Typography>
      <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem', mt: 0.5, mb: 1.5, whiteSpace: 'pre-line' }}>{t('service.node_ss_intro')}</Typography>
      {!connected && <Alert severity="info" sx={{ mb: 1.5 }}>{t('service.node_ss_not_connected')}</Alert>}
      <Box>
        {/* 概要（番号なし。手順の番号は変えない） */}
        <Accordion disableGutters variant="outlined" slotProps={{ transition: { unmountOnExit: true } }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography sx={{ fontWeight: 700, fontSize: '0.95rem' }}>{t('service.node_ss_overview_title')}</Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ textAlign: 'left' }}>
            <Typography sx={{ fontSize: '0.9rem', whiteSpace: 'pre-line' }}>{t('service.node_ss_overview_body')}</Typography>
          </AccordionDetails>
        </Accordion>
        {SHOESTRING_STEPS.map((step, i) => {
          const tpl = step.fileTemplate;
          return (
          <Accordion key={step.id} disableGutters variant="outlined" slotProps={{ transition: { unmountOnExit: true } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
                <Typography sx={{ fontWeight: 700, fontSize: '0.95rem' }}>{`${i + 1}. ${t(`service.node_ss_${step.id}_title`)}`}</Typography>
                {step.optional && <Chip size="small" variant="outlined" label={t('service.node_ss_optional')} />}
              </Stack>
            </AccordionSummary>
            <AccordionDetails sx={{ textAlign: 'left' }}>
              <Typography sx={{ fontSize: '0.9rem', whiteSpace: 'pre-line' }}>{t(`service.node_ss_${step.id}_body`)}</Typography>
              {step.snippet && (
                <Box component="pre" sx={{ mt: 1.5, mb: 0, p: 1.5, borderRadius: 1, bgcolor: 'action.hover', fontFamily: MONO, fontSize: '0.8rem', overflowX: 'auto' }}>{step.snippet}</Box>
              )}
              {(step.openConfig || tpl) && (
                <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
                  {step.openConfig && <Button size="small" variant="outlined" disabled={!connected || running} onClick={onOpenConfig}>{t('service.node_ss_open_config')}</Button>}
                  {tpl && <Button size="small" variant="outlined" disabled={!connected || running} onClick={() => onFileTemplate(tpl.name, tpl.content)}>{t('service.node_ss_file_template', { name: tpl.name })}</Button>}
                </Stack>
              )}
              {step.lines && (
                <Stack spacing={0.75} sx={{ mt: 1.5 }}>
                  {step.lines.map((line) => {
                    const note = noteOf(line);
                    return (
                      <Stack key={line} direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
                        <Button size="small" variant="outlined" disabled={!connected || running} onClick={() => onPickLine(line)} sx={{ fontFamily: MONO, textTransform: 'none', textAlign: 'left', wordBreak: 'break-all' }}>{line}</Button>
                        {note && <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>{t(note)}</Typography>}
                      </Stack>
                    );
                  })}
                </Stack>
              )}
              {step.terminalOnly && (
                <Box sx={{ mt: 1.5 }}>
                  <Typography sx={{ color: 'text.secondary', fontSize: '0.8rem', mb: 0.5 }}>{t('service.node_ss_terminal_only')}</Typography>
                  <Stack spacing={0.75}>
                    {step.terminalOnly.map((line, j) => (
                      <Box key={line}>
                        <Box component="code" sx={{ display: 'inline-block', p: 0.75, borderRadius: 1, bgcolor: 'action.hover', fontFamily: MONO, fontSize: '0.8rem', wordBreak: 'break-all' }}>{line}</Box>
                        <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>{t(`service.node_ss_${step.id}_t${j}`)}</Typography>
                      </Box>
                    ))}
                  </Stack>
                </Box>
              )}
            </AccordionDetails>
          </Accordion>
          );
        })}
      </Box>
    </Box>
  );
}
