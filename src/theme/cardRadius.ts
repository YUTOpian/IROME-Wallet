import type { Theme } from '@mui/material/styles';

// ホームのカード（<Card>）と同じ角丸：テーマのカードの角丸（t.irome.cardRadius）をそのまま使う。
// sx の `borderRadius: 3` は「テーマの基準値の3倍」になって丸すぎるので、カード状の枠にはこちらを使う。
export const cardRadius = (t: Theme): string => `${t.irome.cardRadius}px`;
