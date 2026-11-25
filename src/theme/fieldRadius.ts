import type { Theme } from '@mui/material/styles';

// 入力欄・プルダウン・値を入れる灰色の箱の角丸：ホームの送金フォームの入力欄（MuiOutlinedInput）と同じ、テーマの field.radius。
// sx の `borderRadius: 1.5` は「テーマの基準値の1.5倍」になって丸薬のようになるので、欄の形の箱にはこちらを使う。
export const fieldRadius = (t: Theme): string => `${t.irome.field.radius}px`;
