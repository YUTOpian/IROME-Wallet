import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useTranslation } from 'react-i18next';
import { COMMAND_PRESETS } from '../../lib/node/nodeCommands';
import { NEM_GUIDE_STEPS } from '../../lib/node/nemGuide';
import GuideText from './GuideText';

// 「NEM（NIS1）でノードを建てる手順」: 公式ドキュメントの順に、説明とコマンドのひな型を並べる。ひな型は、押すと入力欄に入るだけ（実行は Enter）。中身は lib/node/nemGuide.ts。
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

interface Props {
  cardSx: object;
  connected: boolean;
  running: boolean;
  onPickLine: (line: string) => void;
  /** 設定ファイルの欄に、この内容を入れる（保存は、使う人が押す。パスは作業フォルダからの相対） */
  onFileTemplate: (name: string, content: string) => void;
}

const noteOf = (line: string): string | null => COMMAND_PRESETS.find((p) => p.line === line)?.noteKey ?? null;

export default function NemNodeGuide({ cardSx, connected, running, onPickLine, onFileTemplate }: Props) {
  const { t } = useTranslation();
  return (
    <Box sx={cardSx}>
      <Typography sx={{ fontWeight: 700 }}>{t('service.node_nem_g_title')}</Typography>
      <Box sx={{ color: 'text.secondary', mt: 0.5, mb: 1.5 }}><GuideText text={t('service.node_nem_g_intro')} size="0.85rem" /></Box>
      {!connected && <Alert severity="info" sx={{ mb: 1.5 }}>{t('service.node_ss_not_connected')}</Alert>}
      <Box>
        {NEM_GUIDE_STEPS.map((step, i) => {
          const tpl = step.fileTemplate;
          return (
            <Accordion key={step.id} disableGutters variant="outlined" slotProps={{ transition: { unmountOnExit: true } }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
                  <Typography sx={{ fontWeight: 700, fontSize: '0.95rem' }}>{`${i + 1}. ${t(`service.node_nem_g_${step.id}_title`)}`}</Typography>
                  {step.optional && <Chip size="small" variant="outlined" label={t('service.node_ss_optional')} />}
                </Stack>
              </AccordionSummary>
              <AccordionDetails sx={{ textAlign: 'left' }}>
                <GuideText text={t(`service.node_nem_g_${step.id}_body`)} />
                {step.snippet && (() => { const k = `service.node_nem_g_${step.id}_snippet`; const cap = t(k); return cap === k ? null : <Typography sx={{ mt: 2, color: 'text.secondary', fontSize: '0.85rem', lineHeight: 1.7, textAlign: 'left' }}>{cap}</Typography>; })()}
                {step.snippet && <Box component="pre" sx={{ mt: 1, mb: 0, p: 1.5, borderRadius: 1, bgcolor: 'action.hover', fontFamily: MONO, fontSize: '0.8rem', lineHeight: 1.7, overflowX: 'auto' }}>{step.snippet}</Box>}
                {tpl && (
                  <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
                    <Button size="small" variant="outlined" disabled={!connected || running} onClick={() => onFileTemplate(tpl.name, tpl.content)}>{t('service.node_nem_g_file_template')}</Button>
                  </Stack>
                )}
                {step.lines && (
                  <Stack spacing={1.5} sx={{ mt: 2, pt: 1.5, borderTop: '1px dashed', borderColor: 'divider' }}>
                    {step.lines.map((line) => {
                      const note = noteOf(line);
                      return (
                        <Box key={line}>
                          <Button size="small" variant="outlined" disabled={!connected || running} onClick={() => onPickLine(line)} sx={{ fontFamily: MONO, textTransform: 'none', textAlign: 'left', justifyContent: 'flex-start', wordBreak: 'break-all', maxWidth: '100%' }}>{line}</Button>
                          {note && <Typography sx={{ color: 'text.secondary', fontSize: '0.82rem', lineHeight: 1.7, mt: 0.5, pl: 0.5, textAlign: 'left' }}>{t(note)}</Typography>}
                        </Box>
                      );
                    })}
                  </Stack>
                )}
              </AccordionDetails>
            </Accordion>
          );
        })}
      </Box>
    </Box>
  );
}
