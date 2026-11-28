import type { Theme } from '@mui/material/styles';

// 入力欄・プルダウン（OutlinedInput）と同じ見た目の枠。費用などの情報ボックスの sx に展開して使う。
// 枠線の色・背景・角丸は、テーマの kasane.field（= MuiOutlinedInput と同じ値）から取る。
export const fieldBoxSx = {
  bgcolor: (t: Theme) => t.irome.field.bg,
  border: '1px solid transparent',
  borderRadius: (t: Theme) => `${t.irome.field.radius}px`,
  px: 2,
  py: 1.5,
};
