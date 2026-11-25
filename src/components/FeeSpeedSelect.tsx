import { MenuItem, Select } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { FEE_SPEEDS } from '../lib/symbol/feeSpeed';
import type { FeeSpeed } from '../lib/symbol/feeSpeed';

/** 手数料の速さ（最も遅い〜最も速い）を選ぶプルダウン。幅は中身に合わせる。 */
export default function FeeSpeedSelect({ value, onChange, label }: { value: FeeSpeed; onChange: (speed: FeeSpeed) => void; label: string }) {
  const { t } = useTranslation();
  return (
    <Select size="small" sx={{ minWidth: 200, mb: 1.5 }} value={value} onChange={(e) => onChange(e.target.value as FeeSpeed)} inputProps={{ 'aria-label': label }}>
      {FEE_SPEEDS.map((s) => <MenuItem key={s} value={s}>{t(`send.fee_speed_${s}`)}</MenuItem>)}
    </Select>
  );
}
