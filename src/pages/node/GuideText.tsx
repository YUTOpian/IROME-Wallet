import { Fragment, useMemo } from 'react';
import { Box } from '@mui/material';
import { parseGuideText, type GuideBlock, type GuideItem, type Inline } from '../../lib/node/guideText';

// 「Shoestring でノードを建てる手順」の説明文を、見出し・箇条書き・番号・補足の枠・等幅のコードに分けて並べる。
// 文字列の書き方は lib/node/guideText.ts の冒頭を参照（HTML としては扱わない。すべて文字として出す）。
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

interface Props {
  text: string;
  /** 本文の文字の大きさ */
  size?: string;
}

function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'code' ? (
          <Box
            key={i}
            component="code"
            sx={{ fontFamily: MONO, fontSize: '0.86em', px: 0.5, py: '1px', borderRadius: 0.75, bgcolor: 'action.hover', overflowWrap: 'anywhere' }}
          >
            {p.text}
          </Box>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}

function Labeled({ label, body }: { label?: string; body: Inline[] }) {
  return (
    <>
      {label && <Box component="span" sx={{ fontWeight: 700, mr: 0.75 }}>{label}</Box>}
      <Inlines parts={body} />
    </>
  );
}

function Item({ item, ordered, first, nested }: { item: GuideItem; ordered: boolean; first: boolean; nested?: boolean }) {
  return (
    <Box component="li" sx={{ display: 'flex', gap: 0.75, mt: first ? 0 : nested ? 0.25 : 0.5 }}>
      <Box
        component="span"
        aria-hidden={ordered ? undefined : true}
        sx={{ flex: '0 0 auto', minWidth: ordered ? '1.7em' : '1em', textAlign: ordered ? 'left' : 'center', color: 'text.secondary' }}
      >
        {ordered ? item.marker : nested ? '–' : '•'}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box><Labeled label={item.label} body={item.body} /></Box>
        {item.notes.map((n, i) => (
          <Box key={i} sx={{ color: 'text.secondary', fontSize: '0.93em', mt: 0.25 }}><Inlines parts={n} /></Box>
        ))}
        {item.children.length > 0 && (
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, mt: 0.5, fontSize: '0.96em' }}>
            {item.children.map((c, i) => <Item key={i} item={c} ordered={false} first={i === 0} nested />)}
          </Box>
        )}
      </Box>
    </Box>
  );
}

function Block({ block, first }: { block: GuideBlock; first: boolean }) {
  const mt = first ? 0 : block.loose ? 1.75 : 0.5;
  switch (block.type) {
    case 'heading':
      return (
        <Box sx={{ mt: first ? 0 : 2.5, mb: 0.25, pl: 1, borderLeft: '3px solid', borderLeftColor: 'primary.main', fontWeight: 700, lineHeight: 1.6 }}>
          <Inlines parts={block.text} />
        </Box>
      );
    case 'callout':
      return (
        <Box sx={{ mt: first ? 0 : 1.25, px: 1.5, py: 1, borderLeft: '4px solid', borderLeftColor: block.warn ? 'warning.main' : 'info.main', bgcolor: 'action.hover', borderRadius: '0 6px 6px 0' }}>
          <Labeled label={block.label} body={block.body} />
        </Box>
      );
    case 'list':
      return (
        <Box component={block.ordered ? 'ol' : 'ul'} sx={{ listStyle: 'none', m: 0, p: 0, mt: first ? 0 : block.loose ? 1.25 : 0.5 }}>
          {block.items.map((it, i) => <Item key={i} item={it} ordered={block.ordered} first={i === 0} />)}
        </Box>
      );
    default:
      return (
        <Box sx={{ mt }}>
          <Labeled label={block.label} body={block.body} />
        </Box>
      );
  }
}

export default function GuideText({ text, size = '0.9rem' }: Props) {
  const blocks = useMemo(() => parseGuideText(text), [text]);
  return (
    <Box sx={{ fontSize: size, lineHeight: 1.85, textAlign: 'left', overflowWrap: 'break-word' }}>
      {blocks.map((b, i) => <Block key={i} block={b} first={i === 0} />)}
    </Box>
  );
}
