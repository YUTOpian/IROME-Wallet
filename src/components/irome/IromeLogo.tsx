import { useId } from 'react';
import { Box, useTheme } from '@mui/material';
import { IROME_LOGO } from '../../theme/iromeTheme';
import { BrushIrome, BrushWallet } from './BrushLogo';

// The IROME logo (the original IROME hexagon mark), drawn as SVG: a rounded hexagon filled with the coral -> mint gradient and a
// faint seigaiha (wave) pattern, with the stacked-roof pagoda drawn in dark grey-purple on it, and the thin
// geometric wordmark underneath.

const CX = 435;
// Flat-topped rounded hexagon: centre (435,173.5), 182 wide to each side, 156 high to top / bottom.
function roundedHexagon(cx: number, cy: number, rx: number, ry: number, radius: number): string {
  const pts: [number, number][] = [
    [cx + rx, cy], [cx + rx / 2, cy + ry], [cx - rx / 2, cy + ry], [cx - rx, cy], [cx - rx / 2, cy - ry], [cx + rx / 2, cy - ry],
  ];
  const n = pts.length;
  let d = '';
  for (let i = 0; i < n; i += 1) {
    const prev = pts[(i + n - 1) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const toward = (from: [number, number], to: [number, number]) => {
      const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
      const k = Math.min(radius, len / 2) / len;
      return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
    };
    const a1 = toward(cur, prev);
    const a2 = toward(cur, next);
    d += `${i === 0 ? 'M' : 'L'} ${a1[0].toFixed(1)} ${a1[1].toFixed(1)} Q ${cur[0]} ${cur[1]} ${a2[0].toFixed(1)} ${a2[1].toFixed(1)} `;
  }
  return `${d}Z`;
}
const HEX = roundedHexagon(435, 173.5, 182, 156, 34);

// Seigaiha (wave) scales: rows of overlapping circles from top to bottom, each lower row painted
// over the one above, so only the upper crescent of every scale shows. Filled with the same
// gradient as the background so the covering is invisible except for the thin ring lines.
const SCALE_R = 20;
const SCALES: { cx: number; cy: number }[] = (() => {
  const out: { cx: number; cy: number }[] = [];
  for (let row = 0, y = 6; y < 360; row += 1, y += SCALE_R / 2) {
    for (let x = row % 2 === 0 ? 240 : 240 + SCALE_R; x < 640; x += SCALE_R * 2) out.push({ cx: x, cy: y });
  }
  return out;
})();

// The pagoda: spire, four roofs, eave line and base. It is painted in a fixed dark grey-purple on top of the hexagon (not cut out of it),
// so it keeps this colour whatever the theme's background is.
const PAGODA_COLOR = '#4F4752';
const CUTS: string[] = [
  `M ${CX} 36 L ${CX + 6} 84 L ${CX - 6} 84 Z`,
  // roofs, top to bottom: apex first, then the eaves, then back along the underside
  `M ${CX} 82 L 506 108 L 502 118 L ${CX} 98 L 368 118 L 364 108 Z`,
  `M ${CX} 118 L 516 146 L 510 158 L ${CX} 134 L 360 158 L 354 146 Z`,
  `M ${CX} 150 L 530 184 L 522 198 L ${CX} 168 L 348 198 L 340 184 Z`,
  `M ${CX} 196 Q 480 200 548 212 L 538 222 L ${CX + 20} 220 L ${CX} 214 L ${CX - 20} 220 L 332 222 L 322 212 Q 390 200 ${CX} 196 Z`,
  `M 348 250 L 522 250 L 522 258 L 348 258 Z`,
  `M 342 266 L 528 266 Q 536 276 532 286 L 338 286 Q 334 276 342 266 Z`,
];

export function IromeMark({ size = 160 }: { size?: number }) {
  const uid = useId().replace(/:/g, '');
  // カスタムテーマの画像があれば、同じ大きさの枠の中に、縦横比を保って入れる。
  const custom = useTheme().irome.images.logoMark;
  const grad = `kg${uid}`;
  const mask = `km${uid}`;
  if (custom) {
    return <Box component="img" src={custom} alt="IROME" sx={{ display: 'block', width: size, height: (size * 328) / 380, objectFit: 'contain', flexShrink: 0 }} />;
  }
  return (
    <Box
      component="svg"
      viewBox="245 10 380 328"
      width={size}
      height={(size * 328) / 380}
      role="img"
      aria-label="IROME"
      sx={{ display: 'block', overflow: 'visible', flexShrink: 0 }}
    >
      <defs>
        <linearGradient id={grad} gradientUnits="userSpaceOnUse" x1="0" y1="17" x2="0" y2="330">
          {[[0, IROME_LOGO.coral], [0.36, IROME_LOGO.pink], [0.58, IROME_LOGO.lavender], [0.8, IROME_LOGO.aqua], [1, IROME_LOGO.mint]].map(([o, c]) => (
            <stop key={String(o)} offset={o as number} stopColor={c as string} />
          ))}
        </linearGradient>
        <mask id={mask} maskUnits="userSpaceOnUse" x="245" y="10" width="380" height="328">
          <path d={HEX} fill="#fff" />
        </mask>
      </defs>
      <g mask={`url(#${mask})`}>
        <rect x="245" y="10" width="380" height="328" fill={`url(#${grad})`} />
        {SCALES.map((c) => (
          <g key={`${c.cx}-${c.cy}`} fill="none" stroke="#fff" strokeOpacity="0.34" strokeWidth="1">
            <circle cx={c.cx} cy={c.cy} r={SCALE_R} fill={`url(#${grad})`} />
            <circle cx={c.cx} cy={c.cy} r={SCALE_R * 0.68} />
            <circle cx={c.cx} cy={c.cy} r={SCALE_R * 0.36} />
          </g>
        ))}
      </g>
      {CUTS.map((d, i) => <path key={i} d={d} fill={PAGODA_COLOR} />)}
    </Box>
  );
}

// "IROME" in thin, wide geometric strokes (pale yellow-green).
export function IromeWordmark({ width = 260, color }: { width?: number; color?: string }) {
  const theme = useTheme();
  const stroke = color ?? theme.irome.wordmark;
  const custom = theme.irome.images.logoWordmark;
  if (custom) {
    return <Box component="img" src={custom} alt="IROME" sx={{ display: 'block', width, height: (width * 166) / 856, objectFit: 'contain', flexShrink: 0 }} />;
  }
  // 習字（筆）で書いたような「IROME」。
  return <BrushIrome width={width} color={stroke} />;
}

// "WALLET" in the same thin geometric strokes, set smaller and wide-spaced under the IROME wordmark.
export function IromeWalletWord({ width = 170, color }: { width?: number; color?: string }) {
  const theme = useTheme();
  const stroke = color ?? theme.irome.wordmark;
  return <BrushWallet width={width} color={stroke} />;
}
