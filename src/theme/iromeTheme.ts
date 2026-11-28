import { alpha, createTheme } from '@mui/material/styles';
import type { ChainKey } from '../lib/chain';
import type { ThemeMode } from '../store/appStore';
import { resolveCustomValues } from './customTheme';
import type { CustomImages, CustomThemeData, CustomValues, LookValues } from './customTheme';

// IROME design for every screen of the app (the stored data, QR / file formats and the --kasane-* custom-theme variables keep their original "kasane" names, so that saved data still opens).
// Taken from the IROME logo: a muted mauve-grey stage, the coral -> pink -> lavender -> aqua -> mint
// layers of the mark, and the pale yellow-green of the thin geometric wordmark.
//
// （「シンプル」テーマ（内部名 'business'）は廃止した。保存されていた選択は、起動時に「色目」へ置き換える。）
//
// さくら (blossom): made for women - a cute, pastel look: a cream-pink stage sprinkled with tiny flowers, hearts
// and sparkles, a bright pastel pink -> lilac gradient, extra-round corners, pink hairlines, soft pink glows, a rounded font,
// a rose -> orchid balance card and a blush side menu.
// It keeps its own character, but the chain still tints it (Symbol rose / NEM mint / mijin sky blue).
//
// トマティーナ (tomatina): the tomato-fight festival. Same soft & round structure as さくら, but a ripe-red look: a cream stage with
// tiny tomatoes, a tomato-red -> deep-red gradient and a deep red balance card with white text, basil-green leaves.
// Like 色目 it is the same for Symbol, NEM and mijin (the chain never tints it).
//
// 色目 (irome): the colourful one - the whole five-colour logo gradient everywhere on a warm cream stage with soft corner
// glows and a faint seigaiha pattern. It is the same for Symbol and NEM (and mijin): the chain never tints it.
//
// The chain changes the *tint* of that design, never its character:
//   Symbol = the warm half of the gradient (coral -> pink -> lavender) on a mauve stage,
//   NEM    = the cool half of the gradient (lavender -> aqua -> mint) on a teal-grey stage,
//   mijin  = (mijin v2, a Symbol-chain network) a sky-blue / teal tint taken from the mijin site's blue,
//            on a blue-grey stage; dark / light follows the setting like Symbol and NEM.
export const IROME_LOGO = {
  coral: '#FA7268',
  pink: '#E58AAE',
  lavender: '#B79BD0',
  aqua: '#7ED1C0',
  mint: '#55E2A0',
  lime: '#EAF4A6', // wordmark
  limeSoft: 'rgba(234,244,166,0.68)',
  limeLine: 'rgba(234,244,166,0.30)',
  ink: '#262129', // text on the gradient
  bg: '#2B262D',
  bgGlow: '#554C58',
  paper: '#3A343D',
} as const;

// Symbolダーク: Symbol 公式サイト（docs.symbol.dev）のダーク配色。紫がかった黒の背景、紫のアクセント、シアンのリンク。
// Symbol と NEM（と最初の画面）で同じ見た目にする。チェーンの色は付けない。mijin だけは従来どおり水色の味付け。
export const SYMBOL_DARK = {
  surface: { bg: '#0B0416', glow: '#2B1058', paper: '#150A27', menuTop: '#1B0B33' },
  accent: '#B792FF', // 紫（見出し・選択中の項目）
  link: '#4CC3F0', // シアン（リンク）
  wordmark: '#D9C9FF',
  gradientStops: '#6D2BE0 0%, #A878FF 55%, #3CC4EA 100%',
  stops: ['#6D2BE0', '#A878FF', '#3CC4EA'] as [string, string, string],
  heroStops: ['#3F12A0', '#6B2FD0', '#157FA8'] as [string, string, string],
  text: { primary: '#FAF8FF', secondary: 'rgba(238,233,250,0.90)', disabled: 'rgba(238,233,250,0.58)' }, // 暗い背景でも読みやすいよう、明るめにする
  line: 'rgba(168,120,255,0.30)',
  fieldLine: 'rgba(168,120,255,0.60)',
  fieldHover: 'rgba(168,120,255,0.88)',
  menuText: '#FAF8FF',
  menuIcon: 'rgba(238,233,250,0.80)',
  menuLine: 'rgba(168,120,255,0.18)',
  menuHover: 'rgba(168,120,255,0.09)',
  grey: { 50: '#1B0E30', 100: 'rgba(168,120,255,0.08)', 200: 'rgba(168,120,255,0.14)', 300: '#2E1B4D', 400: '#4A3474', 500: '#B3A7CE', 600: '#A296BF', 700: '#C4BAD9', 800: '#DDD6EA', 900: '#F1EDF8' },
} as const;

// NEMホワイト: NEM 公式ドキュメントの配色（真っ白なページ、淡い水色のサイドメニュー）に、NEM のロゴの橙・青緑・青を加えたもの。
// Symbol と NEM（と最初の画面）で同じ見た目にする。チェーンの色は付けない。mijin だけは従来どおり水色の味付け。
export const NEM_WHITE = {
  // NEM のロゴの3色: 橙・青緑・青。
  logo: { orange: '#F5A623', teal: '#2DB8A4', blue: '#4A9EE0' },
  surface: { bg: '#FFFFFF', glow: '#EAF3F8', menuBottom: '#EAF3F8' },
  accent: '#1F9E8F', // 青緑（選択中の項目・見出し。白地でも読める濃さ）
  link: '#3B8FD9', // 青（リンク）
  menuLine: '#4A9EE0', // 選択中の項目の枠
  ink: '#222222',
  inkRgb: '34,34,34',
  wordmark: '#1B8F82',
  gradientStops: '#F5A623 0%, #2DB8A4 52%, #4A9EE0 100%',
  stops: ['#F5A623', '#2DB8A4', '#4A9EE0'] as [string, string, string],
  heroStops: ['#E08A0A', '#1B9484', '#2F7FC4'] as [string, string, string],
  line: 'rgba(34,34,34,0.12)',
  grey: { 50: '#F7FAFC', 100: '#EEF3F7', 200: '#E1E9EF', 300: '#CBD7E0', 400: '#A9B8C4', 500: '#7C8B97', 600: '#5F6E7A', 700: '#475560', 800: '#2F3A44', 900: '#222222' },
} as const;

export interface IromeMenuTokens {
  panel: string;
  text: string;
  icon: string;
  line: string;
  hover: string;
  shadow: string;
  activeGradient: string;
  activeShadow: string;
  avatarBg: string;
  activeText?: string; // text / icon colour of the open page's entry (defaults to `onGradient`)
}

// Everything chain / mode dependent that is not a plain MUI palette entry. Read it with
// `useTheme().irome` (or `(t) => t.irome...` inside sx).
// 'base' = the neutral IROME look of the first-run screens (no Symbol / NEM tint).
export type DesignKey = ChainKey | 'base' | 'mijin';

export interface IromeTokens {
  chain: DesignKey;
  bg: string; // page background colour (also the browser's theme-color)
  stageBg: string; // page / stage background (radial glow)
  gradient: string; // horizontal chain gradient: buttons, pills, bar underline
  gradientV: string; // vertical chain gradient
  hero: string; // the balance card (deeper IROME gradient so white text stays readable)
  heroText: string; // text on the balance card
  ink: string; // text on top of any gradient
  heroTextSoft: string; // secondary text on the balance card
  heroTextShadow: string; // text shadow on the balance card
  heroChipBg: string; // small chips on the balance card
  stageText: { fontWeight: number; textShadow: string }; // 模様のある背景の上に直接置く文字（「まだ〜していません」など）を読みやすくする太さと影
  wordmark: string; // colour of the IROME wordmark / thin titles
  accent: string; // chain accent (selected borders, glows)
  line: string; // hairlines
  cardShadow: string;
  cardShadowHover: string;
  // カード・枠の背景。ホームなどウォレットの画面では半透明にして、背景の模様がうっすら透けて見えるようにする（入力欄・ダイアログ・メニューは不透明のまま）。
  cardBg: string;
  menu: IromeMenuTokens;
  onGradient: string; // text / icons on top of `gradient` (buttons, selected toggles, the active menu entry)
  cardRadius: number; // corner radius of cards and tiles
  field: { bg: string; line: string; hover: string; radius: number }; // the look of an input / pull-down; info boxes (費用 etc.) share it
  images: CustomImages; // images of the カスタムテーマ (logo, side menu icons; the background and the balance card image are already in stageBg / hero)
  look: LookValues; // the values above as the plain colours the カスタムテーマ template is made of
}

declare module '@mui/material/styles' {
  interface Theme {
    irome: IromeTokens;
  }
  interface ThemeOptions {
    irome?: IromeTokens;
  }
  interface Palette {
    textSlightGray: string;
    textGray: string;
    textDarkGray: string;
    textLightGray: string;
    nemBlue: string;
    nemOrange: string;
    nemGreen: string;
    ribbonBlue: string;
  }
  interface PaletteOptions {
    textSlightGray?: string;
    textGray?: string;
    textDarkGray?: string;
    textLightGray?: string;
    nemBlue?: string;
    nemOrange?: string;
    nemGreen?: string;
    ribbonBlue?: string;
  }
}

const FONT = '"Segoe UI", "Helvetica Neue", Arial, Roboto, "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic UI", "Yu Gothic", "Meiryo", "Noto Sans JP", "PingFang SC", "Microsoft YaHei", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif';

const FONT_BLOSSOM = '"Hiragino Maru Gothic ProN", "HG丸ｺﾞｼｯｸM-PRO", "Zen Maru Gothic", "M PLUS Rounded 1c", "Kosugi Maru", "Quicksand", "Hiragino Sans", "Yu Gothic", "Meiryo", "Noto Sans JP", "PingFang SC", "Microsoft YaHei", "Malgun Gothic", "Segoe UI", system-ui, sans-serif';

// さくら colours per design. The theme keeps its own character (soft & round),
// but the chain still tints them like the dark / white themes: Symbol = warm rose, NEM = fresh mint, mijin = sky blue,
// 'base' (first-run screens) = the neutral rose-lilac.
interface BlossomLook {
  bg: string; glow: string; menuBottom: string; accent: string; ink: string; inkRgb: string; wordmark: string;
  gradientStops: string; hero: string;
  petal: string; // colour of the little flowers / hearts / sparkles on the stage
  menuActive: string; // fill of the open page's entry in the side menu (white text on it)
}
const BLOSSOM: Record<DesignKey, BlossomLook> = {
  base: {
    bg: '#FFF5F8', glow: '#FFE0EA', menuBottom: '#FFE9F0', accent: '#C94F80', ink: '#4A2536', inkRgb: '74,37,54', wordmark: '#9B3F6A',
    gradientStops: '#FFA3BF 0%, #FFB7CF 45%, #E2B8F6 100%',
    hero: 'linear-gradient(135deg, #FFD6E4 0%, #FFC4DB 50%, #EBCDFA 100%)',
    petal: '#F58FB0',
    menuActive: 'linear-gradient(135deg, #F78DB4 0%, #E5619B 100%)',
  },
  symbol: {
    bg: '#FFF4F3', glow: '#FFDCD9', menuBottom: '#FFE6E2', accent: '#D0506E', ink: '#4D2530', inkRgb: '77,37,48', wordmark: '#A23F5C',
    gradientStops: '#FFB09C 0%, #FFA3BE 50%, #E3B8F0 100%',
    hero: 'linear-gradient(135deg, #FFD9CF 0%, #FFC6D6 50%, #EACDF7 100%)',
    petal: '#F79A8E',
    menuActive: 'linear-gradient(135deg, #FF8F8A 0%, #E9638F 100%)',
  },
  nem: {
    bg: '#F2FAF6', glow: '#D9F2E6', menuBottom: '#E0F4EA', accent: '#2E9E7F', ink: '#1F3A33', inkRgb: '31,58,51', wordmark: '#2A6E5C',
    gradientStops: '#A8EBD0 0%, #A5E0EA 50%, #D9C6F6 100%',
    hero: 'linear-gradient(135deg, #CFF5E4 0%, #C6EAF0 50%, #E3D6FA 100%)',
    petal: '#7FD1B0',
    menuActive: 'linear-gradient(135deg, #46C4A0 0%, #2E9E8F 100%)',
  },
  mijin: {
    bg: '#F1F7FC', glow: '#D8EAF8', menuBottom: '#E0EEF9', accent: '#2F7FB8', ink: '#1E3445', inkRgb: '30,52,69', wordmark: '#245C86',
    gradientStops: '#A5D8FA 0%, #A3CCF5 50%, #C9CDF8 100%',
    hero: 'linear-gradient(135deg, #CFE8FB 0%, #C6DBF8 50%, #D9DCFA 100%)',
    petal: '#8CC4EE',
    menuActive: 'linear-gradient(135deg, #5AAEE8 0%, #3A82C4 100%)',
  },
};

// A tile of tiny flowers, hearts and sparkles in the chain's pastel colour, as a CSS background layer (used by さくら).
function petalPattern(color: string, opacity = 0.30): string {
  const flower = [0, 72, 144, 216, 288].map((deg) => `<ellipse cx='0' cy='-7' rx='4.5' ry='7' transform='rotate(${deg})'/>`).join('');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'>`
    + `<g fill='${color}' fill-opacity='${opacity}'>`
    + `<g transform='translate(32 34)'>${flower}</g>`
    + `<path transform='translate(114 78) scale(0.95)' d='M0 -3C-6 -9 -12 -1 0 8C12 -1 6 -9 0 -3Z'/>`
    + `<path transform='translate(64 124)' d='M0 -8L2 -2L8 0L2 2L0 8L-2 2L-8 0L-2 -2Z'/>`
    + `<path transform='translate(136 20) scale(0.6)' d='M0 -8L2 -2L8 0L2 2L0 8L-2 2L-8 0L-2 -2Z'/>`
    + `<circle cx='92' cy='30' r='2.2'/><circle cx='20' cy='96' r='2'/><circle cx='140' cy='132' r='2.4'/>`
    + `</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0 / 160px 160px repeat`;
}


// 色目 (iro-me): the colourful theme. It is the same for Symbol, NEM and mijin - the chain never tints it - and it uses the
// whole logo gradient (coral -> pink -> lavender -> aqua -> mint) everywhere: buttons, tabs, the bar underline, the open
// menu entry, the stage's four soft corner glows and the balance card. A faint seigaiha (wave) pattern, as in the logo, is
// laid over the stage and the balance card.
const IROME = {
  bg: '#FFF8F1',
  menuBottom: '#EAF8F2',
  accent: '#7C5FA3',
  wordmark: '#6A4C93',
  heroStops: ['#D9534A', '#C74F8B', '#8B5FBF', '#2F9C8B', '#249E63'] as const,
};

const TOMATINA: BlossomLook = {
  bg: '#FFF4EC', glow: '#FFDACE', menuBottom: '#FFE5DB', accent: '#C9301F', ink: '#3E1713', inkRgb: '62,23,19', wordmark: '#A52617',
  gradientStops: '#F0553A 0%, #DC3326 52%, #B3201A 100%',
  hero: 'linear-gradient(135deg, #E8503A 0%, #CF2E22 55%, #8E1B14 100%)',
  petal: '#E5503C',
  menuActive: 'linear-gradient(135deg, #F0553A 0%, #C9301F 100%)',
};

// A tile of tiny tomatoes (with a green calyx) and juice drops as a CSS background layer (used by トマティーナ).
function tomatoPattern(color: string, opacity = 0.22, leaf = '#4E9F3D'): string {
  const tomato = (x: number, y: number, k: number) => `<g transform='translate(${x} ${y}) scale(${k})'><ellipse cx='0' cy='2' rx='9' ry='8' fill='${color}' fill-opacity='${opacity}'/>`
    + `<path d='M0 -6L2 -2L6 -5L3 -1L7 1L2 1L0 5L-2 1L-7 1L-3 -1L-6 -5L-2 -2Z' fill='${leaf}' fill-opacity='${Math.min(1, opacity * 2.2)}' transform='translate(0 -4) scale(0.7)'/></g>`;
  const drop = (x: number, y: number, k: number) => `<path transform='translate(${x} ${y}) scale(${k})' d='M0 -7C5 0 6 3 0 6C-6 3 -5 0 0 -7Z' fill='${color}' fill-opacity='${opacity}'/>`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'>`
    + `${tomato(30, 32, 1)}${tomato(118, 84, 0.85)}${tomato(66, 128, 0.7)}${drop(100, 26, 0.9)}${drop(24, 98, 0.8)}${drop(142, 140, 0.9)}`
    + `<circle cx='80' cy='70' r='2.4' fill='${color}' fill-opacity='${opacity}'/><circle cx='142' cy='34' r='2' fill='${color}' fill-opacity='${opacity}'/><circle cx='12' cy='150' r='2.2' fill='${color}' fill-opacity='${opacity}'/>`
    + `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0 / 160px 160px repeat`;
}

// A tile of seigaiha arcs (three concentric half circles per scale) as a CSS background layer.
function seigaihaPattern(color: string, opacity: number): string {
  const scale = (cx: number, cy: number) => [12, 8, 4].map((r) => `<path d='M${cx - r} ${cy}A${r} ${r} 0 0 1 ${cx + r} ${cy}'/>`).join('');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='24' viewBox='0 0 48 24'>`
    + `<g fill='none' stroke='${color}' stroke-opacity='${opacity}' stroke-width='1'>`
    + `${scale(12, 12)}${scale(36, 12)}${scale(0, 24)}${scale(24, 24)}${scale(48, 24)}`
    + `</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0 / 48px 24px repeat`;
}

interface ChainLook {
  gradientStops: string; // CSS colour stops of the button / pill gradient, left -> right
  stops: [string, string, string]; // main colours of that gradient
  heroStops: [string, string, string]; // deeper version of the stops for the balance card
  accent: { dark: string; light: string };
  dark: { bg: string; glow: string; paper: string; menuTop: string };
  light: { bg: string; glow: string; menuBottom: string };
}

// NEM の dark は「Symbol の dark」にほぼ揃える。サイドメニューや中央のカード(paper)・グレーの地色が緑寄りだと、
// チェーンを切り替えたときに画面ぜんたいの印象が変わりすぎるため。違いは グラデーションとアクセント色 を主役にして、
// 地色は NEM_DARK_TINT の分(0 = Symbol と同じ、1 = 以前の緑グレー)だけ緑を残す。
const NEM_DARK_TINT = 0.25;
function mixHex(a: string, b: string, t: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return '#' + [0, 1, 2].map((i) => Math.round(ch(a, i) * (1 - t) + ch(b, i) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
}
const nemDark = (symbolHex: string, oldNemHex: string) => mixHex(symbolHex, oldNemHex, NEM_DARK_TINT);

const LOOK: Record<DesignKey, ChainLook> = {
  // Neutral: the whole logo gradient (coral -> pink -> lavender -> aqua -> mint) on the logo's own
  // mauve-grey stage. Used by welcome -> profile -> create / import -> recovery phrase -> done.
  base: {
    gradientStops: `${IROME_LOGO.coral} 0%, ${IROME_LOGO.pink} 30%, ${IROME_LOGO.lavender} 56%, ${IROME_LOGO.aqua} 80%, ${IROME_LOGO.mint} 100%`,
    stops: [IROME_LOGO.coral, IROME_LOGO.lavender, IROME_LOGO.mint],
    heroStops: ['#C24A47', '#7A5AA0', '#1B7F55'],
    accent: { dark: IROME_LOGO.lavender, light: '#7C5FA3' },
    dark: { bg: '#2B262D', glow: '#554C58', paper: '#3A343D', menuTop: '#3B3041' },
    light: { bg: '#F8F2F5', glow: '#EEE6F0', menuBottom: '#F1E8F0' },
  },
  symbol: {
    gradientStops: `${IROME_LOGO.coral} 0%, ${IROME_LOGO.pink} 52%, ${IROME_LOGO.lavender} 100%`,
    stops: [IROME_LOGO.coral, IROME_LOGO.pink, IROME_LOGO.lavender],
    heroStops: ['#C24A47', '#B04A78', '#7A5AA0'],
    accent: { dark: IROME_LOGO.pink, light: '#B8517F' },
    dark: { bg: '#2B262D', glow: '#5A4A64', paper: '#3A343D', menuTop: '#3B3041' },
    light: { bg: '#F8F2F5', glow: '#EEDFEA', menuBottom: '#F1E4EE' },
  },
  mijin: {
    gradientStops: '#7FD3DC 0%, #4FA5CC 52%, #7096D6 100%',
    stops: ['#7FD3DC', '#4FA5CC', '#7096D6'],
    heroStops: ['#2F8AA8', '#1D6E98', '#3A5FA5'],
    accent: { dark: '#6FBBD9', light: '#006699' },
    dark: { bg: '#222A31', glow: '#3B5769', paper: '#2D3841', menuTop: '#2A4455' },
    light: { bg: '#F0F6FA', glow: '#D6E8F3', menuBottom: '#E0EDF6' },
  },
  nem: {
    gradientStops: `${IROME_LOGO.lavender} 0%, ${IROME_LOGO.aqua} 52%, ${IROME_LOGO.mint} 100%`,
    stops: [IROME_LOGO.lavender, IROME_LOGO.aqua, IROME_LOGO.mint],
    heroStops: ['#7A5AA0', '#238570', '#1B7F55'],
    accent: { dark: IROME_LOGO.aqua, light: '#23917C' },
    dark: { bg: '#2B262D', glow: nemDark('#5A4A64', '#554C58'), paper: nemDark('#3A343D', '#2F3A38'), menuTop: nemDark('#3B3041', '#2D3834') },
    light: { bg: '#F0F7F5', glow: '#D8EDE7', menuBottom: '#E2F1ED' },
  },
};

// The three main colours of a CSS gradient written as `#hex 0%, #hex 50%, ...` (first, middle, last).
function stopColors(stops: string): [string, string, string] {
  const colors = stops.match(/#[0-9A-Fa-f]{6}/g) ?? [];
  return [colors[0], colors[Math.floor((colors.length - 1) / 2)], colors[colors.length - 1]] as [string, string, string];
}

// requestedMode 'custom' = the dark or white look (whichever the person's CSS says, `--kasane-mode`) with their values laid over it.
// Every value read from `custom` has been checked and normalised by theme/customTheme.ts (colours, numbers, a plain font list).
export function createIromeTheme(requestedMode: ThemeMode, chain: DesignKey = 'symbol', custom?: CustomThemeData | null) {
  const cv: CustomValues = requestedMode === 'custom' && custom ? resolveCustomValues(custom, chain) : {};
  const baseMode: Exclude<ThemeMode, 'custom'> = requestedMode === 'custom' ? (cv.mode ?? 'dark') : requestedMode;
  const irome = baseMode === 'irome';
  // 色目 never takes the chain's tint: it always uses the whole-gradient look of the first-run screens.
  const look = irome ? LOOK.base : LOOK[chain];
  const tomatina = baseMode === 'tomatina';
  // トマティーナ shares さくら's soft & round structure (rounded font and corners, menu pill, glows); its colours and the deep hero card are its own.
  const blossom = baseMode === 'blossom' || tomatina;
  const bl = tomatina ? TOMATINA : BLOSSOM[chain];
  // The themes other than dark / 宵 are light schemes as far as MUI is concerned.
  const mode: 'dark' | 'light' = baseMode === 'dark' || baseMode === 'yoi' ? 'dark' : 'light'; // 宵 は以前のダーク
  const dark = mode === 'dark';
  // Symbolダーク: Symbol / NEM / 最初の画面のダークは同じ見た目（mijin だけ別）。
  const sd = baseMode === 'dark' && chain !== 'mijin'; // 宵（以前のダーク）は含めない
  // NEMホワイト: ホワイト（baseMode 'light'）も、Symbol / NEM / 最初の画面で同じ見た目（mijin だけ別）。
  const sw = baseMode === 'light' && chain !== 'mijin';
  // RGB of the dark text colour (used for the translucent greys below).
  const inkRgb = blossom ? bl.inkRgb : sw ? NEM_WHITE.inkRgb : '43,38,45';
  let gradientStops = blossom ? bl.gradientStops : look.gradientStops;
  let stops3: [string, string, string] = blossom ? stopColors(bl.gradientStops) : [...look.stops];
  if (sd) { gradientStops = SYMBOL_DARK.gradientStops; stops3 = [...SYMBOL_DARK.stops]; }
  if (sw) { gradientStops = NEM_WHITE.gradientStops; stops3 = [...NEM_WHITE.stops]; }
  if (cv.gradientStart || cv.gradientMid || cv.gradientEnd) {
    stops3 = [cv.gradientStart ?? stops3[0], cv.gradientMid ?? stops3[1], cv.gradientEnd ?? stops3[2]];
    gradientStops = `${stops3[0]} 0%, ${stops3[1]} 52%, ${stops3[2]} 100%`;
  }
  const darkLook = sd ? SYMBOL_DARK.surface : look.dark;
  const lightLook = sw ? NEM_WHITE.surface : look.light;
  const surface = dark ? darkLook : lightLook;
  const bg = cv.bg ?? (blossom ? bl.bg : irome ? IROME.bg : surface.bg);
  const glow = cv.glow ?? (blossom ? bl.glow : surface.glow);
  const paper = cv.paper ?? (dark ? darkLook.paper : '#FFFFFF');
  const accent = cv.accent ?? (blossom ? bl.accent : irome ? IROME.accent : sw ? NEM_WHITE.accent : sd ? SYMBOL_DARK.accent : dark ? look.accent.dark : look.accent.light);
  const ink = blossom ? bl.ink : sw ? NEM_WHITE.ink : IROME_LOGO.ink;
  // グラデーションの上の文字・アイコンは、どのテーマでも白（グラデーションの上では黒より白のほうが見やすい）。
  const onGradient = cv.onGradient ?? '#FFFFFF';
  const line = cv.line ?? (sd ? SYMBOL_DARK.line : sw ? NEM_WHITE.line : dark ? IROME_LOGO.limeLine : blossom ? alpha(accent, 0.28) : irome ? alpha(accent, 0.24) : `rgba(${inkRgb},0.14)`);
  const gradient = `linear-gradient(90deg, ${gradientStops})`;
  const gradientV = `linear-gradient(180deg, ${gradientStops})`;

  // Primary is the pale lime of the wordmark on the dark stage (the look of the first-run screens);
  // on the light stage lime would vanish, so it becomes the deep chain accent.
  const primary = dark
    ? (cv.primary
      ? { main: cv.primary, light: alpha(cv.primary, 0.8), dark: cv.primary, contrastText: onGradient }
      : sd
      ? { main: SYMBOL_DARK.accent, light: '#C4A5FF', dark: '#8A5CF0', contrastText: onGradient }
      : { main: IROME_LOGO.lime, light: '#F4FAC8', dark: '#C9D87F', contrastText: onGradient })
    : { main: cv.primary ?? accent, light: alpha(cv.primary ?? accent, 0.8), dark: cv.primary ?? accent, contrastText: '#FFFFFF' };
  const textBase = dark
    ? (sd ? { ...SYMBOL_DARK.text } : { primary: '#F1F6CF', secondary: IROME_LOGO.limeSoft, disabled: 'rgba(234,244,166,0.4)' })
    : { primary: ink, secondary: `rgba(${inkRgb},${irome ? 0.84 : 0.68})`, disabled: `rgba(${inkRgb},0.4)` }; // 色目は青海波の模様の上でも読めるよう、補助文字を濃くする
  const text = {
    primary: cv.text ?? textBase.primary,
    secondary: cv.textSoft ?? (cv.text ? alpha(cv.text, irome ? 0.84 : 0.68) : textBase.secondary),
    disabled: cv.text ? alpha(cv.text, 0.4) : textBase.disabled,
  };
  const grey = sd
    ? { ...SYMBOL_DARK.grey }
    : sw
    ? { ...NEM_WHITE.grey }
    : dark
    ? (chain === 'nem'
      ? { 50: nemDark('#322D35', '#2A312F'), 100: 'rgba(234,244,166,0.08)', 200: 'rgba(234,244,166,0.14)', 300: nemDark('#4A444E', '#414947'), 400: nemDark('#615A66', '#575F5D'), 500: nemDark('#8E8693', '#838C89'), 600: nemDark('#7A7280', '#707875'), 700: nemDark('#A39BA8', '#98A19E'), 800: nemDark('#C4BDC8', '#BAC2C0'), 900: nemDark('#E2DDE5', '#D9E1DF') }
      : { 50: '#322D35', 100: 'rgba(234,244,166,0.08)', 200: 'rgba(234,244,166,0.14)', 300: '#4A444E', 400: '#615A66', 500: '#8E8693', 600: '#7A7280', 700: '#A39BA8', 800: '#C4BDC8', 900: '#E2DDE5' })
    : blossom
        ? { 50: '#FFF9FB', 100: '#FBEEF3', 200: '#F4DEE7', 300: '#E7C9D6', 400: '#CDA7B9', 500: '#9E7F8F', 600: '#846675', 700: '#684F5D', 800: '#4F3A47', 900: '#3A2630' }
        : { 50: '#FAF7F9', 100: '#F1EBEF', 200: '#E6DDE3', 300: '#D3C8D0', 400: '#B8AAB5', 500: '#8E8693', 600: '#756D7B', 700: '#5C5562', 800: '#433D49', 900: '#2B262D' };

  // The balance card's three colours (top left -> bottom right) and the side menu's top / bottom colours.
  let heroStops3: [string, string, string] = blossom ? stopColors(bl.hero) : irome ? [IROME.heroStops[0], IROME.heroStops[2], IROME.heroStops[4]] : sd ? [...SYMBOL_DARK.heroStops] : sw ? [...NEM_WHITE.heroStops] : [...look.heroStops];
  const heroCustom = Boolean(cv.heroStart || cv.heroMid || cv.heroEnd);
  if (heroCustom) heroStops3 = [cv.heroStart ?? heroStops3[0], cv.heroMid ?? heroStops3[1], cv.heroEnd ?? heroStops3[2]];
  const menuTop0 = dark ? darkLook.menuTop : sw ? NEM_WHITE.surface.menuBottom : '#FFFFFF';
  const menuBottom0 = dark ? bg : blossom ? bl.menuBottom : irome ? IROME.menuBottom : lightLook.menuBottom;
  const menuText0 = sd ? SYMBOL_DARK.menuText : dark ? '#F1F6CF' : ink;
  const menuText = cv.menuText ?? menuText0;
  const menuCustom = Boolean(cv.menuTop || cv.menuBottom || cv.menuText);
  const heroText = cv.heroText ?? (blossom && !tomatina ? bl.ink : '#FFFFFF'); // the deep red card of トマティーナ has white text
  // カスタムテーマ images (data:image/... strings that theme/customTheme.ts has already checked).
  const images: CustomImages = requestedMode === 'custom' && custom?.images ? custom.images : {};
  // 背景・残高カードの画像は、切り取らず、枠に収まる最大の大きさに合わせて（contain）真ん中に置く。縦横比が枠と合わない分は、背景色（残高カードはグラデーション）が見える。
  // 背景は画面（ビューポート）に固定して、ページが長くても画像が引き伸ばされないようにする。
  const backgroundDim = cv.backgroundDim ?? 0.35;
  const heroDim = cv.heroDim ?? 0.3;
  const heroImageLayer = images.hero ? `linear-gradient(rgba(0,0,0,${heroDim}), rgba(0,0,0,${heroDim})), url("${images.hero}") center / contain no-repeat, ` : '';
  const cardRadius = cv.radius ?? (blossom ? 28 : 20);
  const shapeRadius = cv.radius !== undefined ? Math.round(cv.radius * 0.8) : blossom ? 24 : 16;
  const buttonRadius = cv.buttonRadius ?? (999);
  const fontFamily = cv.font ?? (blossom ? FONT_BLOSSOM : FONT);
  const errorMain = cv.error ?? (dark ? '#FF8F86' : '#D6453D');
  const infoMain = cv.info ?? (sd ? SYMBOL_DARK.link : sw ? NEM_WHITE.link : dark ? IROME_LOGO.lavender : '#7C5FA3');
  const successMain = cv.success ?? (dark ? IROME_LOGO.mint : '#23915F');
  const warningMain = cv.warning ?? (dark ? '#F6C177' : '#B9770E');
  const wordmark = cv.wordmark ?? (sd ? SYMBOL_DARK.wordmark : sw ? NEM_WHITE.wordmark : dark ? IROME_LOGO.lime : blossom ? bl.wordmark : irome ? IROME.wordmark : '#4A4150');


  // 入力欄は白ではなく、背景の模様が透ける薄いグレー（枠線なし）にする。カードの白と並んでも浮かない。
  const fieldFill = dark ? 'rgba(255,255,255,0.08)' : 'rgba(60,40,40,0.075)';
  const fieldFillHover = dark ? 'rgba(255,255,255,0.12)' : 'rgba(60,40,40,0.10)';

  const tokens: IromeTokens = {
    chain,
    bg,
    stageBg: images.background ? `linear-gradient(${alpha(bg, backgroundDim)}, ${alpha(bg, backgroundDim)}) fixed, url("${images.background}") center / contain no-repeat fixed, ${bg}` : sw ? `radial-gradient(circle at 4% 6%, ${alpha(NEM_WHITE.logo.orange, 0.14)} 0%, transparent 38%), radial-gradient(circle at 96% 8%, ${alpha(NEM_WHITE.logo.blue, 0.14)} 0%, transparent 40%), radial-gradient(circle at 50% 100%, ${alpha(NEM_WHITE.logo.teal, 0.14)} 0%, transparent 46%), ${bg}` : blossom ? `${tomatina ? tomatoPattern(bl.petal) : petalPattern(bl.petal)}, radial-gradient(ellipse at 50% 22%, ${glow} 0%, ${bg} 70%)` : irome ? `${seigaihaPattern(IROME_LOGO.lavender, 0.2)}, radial-gradient(circle at 6% 4%, ${alpha(IROME_LOGO.coral, 0.30)} 0%, transparent 44%), radial-gradient(circle at 94% 10%, ${alpha(IROME_LOGO.lavender, 0.34)} 0%, transparent 46%), radial-gradient(circle at 8% 94%, ${alpha(IROME_LOGO.aqua, 0.34)} 0%, transparent 46%), radial-gradient(circle at 96% 92%, ${alpha(IROME_LOGO.mint, 0.30)} 0%, transparent 44%), ${bg}` : `radial-gradient(ellipse at 50% 22%, ${glow} 0%, ${bg} 70%)`,
    gradient,
    gradientV,
    hero: heroImageLayer + (heroCustom
      ? `linear-gradient(135deg, ${heroStops3[0]} 0%, ${heroStops3[1]} 55%, ${heroStops3[2]} 100%)`
      : blossom
      ? `${tomatina ? tomatoPattern('#FFFFFF', 0.16, '#FFFFFF') : petalPattern('#FFFFFF', 0.7)}, ${bl.hero}`
      : irome
      ? `${seigaihaPattern('#FFFFFF', 0.26)}, linear-gradient(135deg, ${IROME.heroStops[0]} 0%, ${IROME.heroStops[1]} 27%, ${IROME.heroStops[2]} 52%, ${IROME.heroStops[3]} 78%, ${IROME.heroStops[4]} 100%)`
      : `linear-gradient(135deg, ${look.heroStops[0]} 0%, ${look.heroStops[1]} 55%, ${look.heroStops[2]} 100%)`),
    heroText,
    ink: cv.onGradient ?? ink,
    heroTextSoft: cv.heroText ? alpha(cv.heroText, 0.86) : blossom && !tomatina ? alpha(bl.ink, 0.72) : 'rgba(255,255,255,0.86)',
    // A soft pastel card with dark text: no dark shadow, just a faint white glow.
    heroTextShadow: blossom && !tomatina ? '0 1px 0 rgba(255,255,255,0.7)' : '0 1px 3px rgba(0,0,0,0.28)',
    heroChipBg: blossom && !tomatina ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.22)',
    // 背景の模様や色むらの上でも文字が埋もれないよう、少し太くして、背景色の細い縁取り（影）を付ける。
    stageText: { fontWeight: 500, textShadow: dark ? `0 1px 3px ${alpha(bg, 0.95)}, 0 0 8px ${alpha(bg, 0.85)}` : '0 0 2px rgba(255,255,255,0.95), 0 0 6px rgba(255,255,255,0.9), 0 1px 10px rgba(255,255,255,0.8)' },
    wordmark,
    accent,
    line,
    cardShadow: dark ? '0 6px 24px rgba(0,0,0,0.28)' : blossom ? `0 8px 24px ${alpha(accent, 0.20)}, 0 2px 6px ${alpha(accent, 0.10)}` : sw ? '0 2px 12px rgba(34,34,34,0.08)' : `0 6px 22px ${alpha(accent, 0.14)}`,
    // 最初の画面群（新規作成・インポート・オフラインなど）も同じ。自分で「カード・ダイアログの背景色」を決めたときは、その色のまま。
    cardBg: cv.paper ? (dark ? alpha(paper, 0.82) : paper) : alpha(paper, dark ? 0.7 : 0.6),
    cardShadowHover: dark ? `0 8px 28px ${alpha(accent, 0.28)}` : `0 8px 28px ${alpha(accent, blossom ? 0.34 : 0.26)}`,
    onGradient,
    cardRadius,
    field: { bg: fieldFill, line: 'transparent', hover: fieldFillHover, radius: 20 },
    images,
    look: undefined as unknown as LookValues, // filled in below, once the theme's palette is known
    menu: dark
      ? {
          panel: `linear-gradient(180deg, ${darkLook.menuTop} 0%, ${bg} 100%)`,
          text: sd ? SYMBOL_DARK.menuText : '#F1F6CF',
          icon: sd ? SYMBOL_DARK.menuIcon : 'rgba(234,244,166,0.62)',
          line: sd ? SYMBOL_DARK.menuLine : 'rgba(234,244,166,0.16)',
          hover: sd ? SYMBOL_DARK.menuHover : 'rgba(234,244,166,0.07)',
          shadow: '2px 0 18px rgba(0,0,0,0.45)',
          activeGradient: gradient,
          activeShadow: `0 6px 18px ${alpha(accent, 0.35)}`,
          avatarBg: alpha(accent, 0.18),
        }
      : {
          panel: sw ? NEM_WHITE.surface.menuBottom : irome ? `linear-gradient(180deg, #FFFFFF 0%, #F6EEFA 55%, ${IROME.menuBottom} 100%)` : `linear-gradient(180deg, #FFFFFF 0%, ${blossom ? bl.menuBottom : look.light.menuBottom} 100%)`,
          text: ink,
          icon: `rgba(${inkRgb},0.6)`,
          line: blossom ? alpha(accent, 0.18) : `rgba(${inkRgb},0.10)`,
          hover: blossom ? alpha(accent, 0.08) : `rgba(${inkRgb},0.05)`,
          shadow: '2px 0 14px rgba(43,38,45,0.10)',
          // さくら: the open page is a candy-coloured rounded pill with white text and a soft glow.
          activeGradient: blossom ? bl.menuActive : sw ? '#FFFFFF' : gradient,
          activeShadow: blossom ? `0 6px 16px ${alpha(accent, 0.38)}` : sw ? `inset 0 0 0 1.5px ${NEM_WHITE.menuLine}` : `0 6px 16px ${alpha(accent, 0.30)}`,
          avatarBg: alpha(accent, 0.14),
          ...(blossom ? { activeText: '#FFFFFF' } : sw ? { activeText: accent } : {}),
        },
  };

  // カスタムテーマ: the side menu's own colours (any of the three; the others keep the standard of the base brightness).
  const menuTop = cv.menuTop ?? menuTop0;
  const menuBottom = cv.menuBottom ?? menuBottom0;
  if (menuCustom) {
    tokens.menu = {
      ...tokens.menu,
      panel: `linear-gradient(180deg, ${menuTop} 0%, ${menuBottom} 100%)`,
      text: menuText,
      icon: alpha(menuText, 0.62),
      line: alpha(menuText, 0.16),
      hover: alpha(menuText, 0.07),
    };
  }

  // The plain values the カスタムテーマ template is made of (what the design is right now).
  tokens.look = {
    mode: dark ? 'dark' : 'light',
    bg, glow, paper,
    text: text.primary,
    textSoft: text.secondary,
    accent,
    primary: primary.main,
    wordmark,
    gradientStart: stops3[0], gradientMid: stops3[1], gradientEnd: stops3[2],
    onGradient,
    heroStart: heroStops3[0], heroMid: heroStops3[1], heroEnd: heroStops3[2],
    heroText,
    menuTop, menuBottom, menuText,
    line,
    error: errorMain, success: successMain, warning: warningMain, info: infoMain,
    radius: cardRadius,
    buttonRadius,
    font: fontFamily,
    backgroundDim,
    heroDim,
  };

  return createTheme({
    irome: tokens,
    palette: {
      mode,
      primary,
      secondary: { main: dark ? accent : IROME_LOGO.lavender },
      error: { main: errorMain },
      info: { main: infoMain },
      success: { main: successMain },
      warning: { main: warningMain },
      background: { default: bg, paper },
      text,
      divider: line,
      grey,
      textSlightGray: text.secondary,
      textGray: cv.text ? alpha(cv.text, 0.78) : sd ? 'rgba(244,240,252,0.94)' : dark ? 'rgba(234,244,166,0.78)' : `rgba(${inkRgb},0.78)`,
      textDarkGray: text.primary,
      textLightGray: text.disabled,
      // Names kept from the earlier theme so existing screens keep working; the hues are now the
      // IROME gradient's coral / mint / lavender.
      nemOrange: dark ? IROME_LOGO.coral : '#D9534A',
      nemGreen: dark ? IROME_LOGO.mint : '#23915F',
      nemBlue: dark ? IROME_LOGO.lavender : '#7C5FA3',
      // A true blue (nemBlue is the gradient's lavender, i.e. purple): the インボイス ribbon on Home.
      ribbonBlue: dark ? '#7DB7F5' : '#2F6DB5',
    },
    shape: { borderRadius: shapeRadius },
    typography: {
      fontFamily,
      h6: blossom ? { fontWeight: 500, letterSpacing: 1 } : { fontWeight: 500, letterSpacing: 1 },
      fontWeightLight: 400,
    },
    components: {
      // 「コピーしました」「送信しました」などの通知は、すべて画面の右上に出す（右上は他に何も置いていないため）。
      MuiSnackbar: {
        defaultProps: { anchorOrigin: { vertical: 'top', horizontal: 'right' } },
        styleOverrides: {
          root: { top: 'calc(16px + env(safe-area-inset-top, 0px))', right: 16, left: 'auto', maxWidth: 'calc(100vw - 32px)' },
        },
      },
      MuiCssBaseline: {
        styleOverrides: {
          body: { background: tokens.stageBg, backgroundColor: bg, backgroundAttachment: 'fixed', minHeight: '100svh' },
        },
      },
      ...(sd || sw ? (() => { const lc = sd ? SYMBOL_DARK.link : NEM_WHITE.link; return { MuiLink: { styleOverrides: { root: { color: lc, textDecorationColor: alpha(lc, 0.5) } } } }; })() : {}),
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none' },
          elevation1: { boxShadow: tokens.cardShadow },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            border: `1px solid ${line}`,
            borderRadius: tokens.cardRadius,
            backgroundColor: tokens.cardBg,
            boxShadow: tokens.cardShadow,
          },
        },
      },
      // 折りたたみ（ノード構築の手順など）の枠も、カードと同じ半透明の背景にする。
      MuiAccordion: { styleOverrides: { root: { backgroundColor: tokens.cardBg } } },
      // 警告などの枠（Alert）も、ホームのカードと同じ角丸にする。
      MuiAlert: { styleOverrides: { root: { borderRadius: tokens.cardRadius } } },
      MuiAppBar: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          colorDefault: {
            // A translucent stage-coloured bar with the chain gradient as a thin underline.
            backgroundColor: alpha(bg, dark ? 0.86 : 0.9),
            backgroundImage: 'none',
            backdropFilter: 'blur(12px)',
            color: text.primary,
            boxShadow: 'none',
            borderBottom: `1px solid ${line}`,
            '&::after': { content: '""', position: 'absolute', left: 0, right: 0, bottom: -1, height: 2, background: gradient, opacity: 0.9 },
            '& .MuiSvgIcon-colorPrimary, & .MuiIconButton-colorPrimary': { color: primary.main },
            '& .MuiButton-textPrimary': { color: primary.main },
            '& .MuiIconButton-root:not(.Mui-disabled)': { color: primary.main },
          },
        },
      },
      MuiDialog: {
        styleOverrides: { paper: { border: 'none', borderRadius: cv.radius !== undefined ? cv.radius + 4 : 24, backgroundColor: paper } },
      },
      MuiMenu: { styleOverrides: { paper: { border: `1px solid ${line}`, borderRadius: 16 } } },
      MuiTooltip: {
        styleOverrides: { tooltip: { backgroundColor: dark ? '#4A4150' : '#3A343D', color: '#F1F6CF', borderRadius: 10 } },
      },
      MuiButton: {
        styleOverrides: {
          root: { textTransform: 'none', fontWeight: 600, letterSpacing: 1.5, borderRadius: buttonRadius },
        },
        variants: [
          {
            props: { variant: 'contained', color: 'primary' },
            style: {
              background: gradient,
              color: onGradient,
              textShadow: '0 1px 2px rgba(0,0,0,0.28)', // 明るいグラデーションの上でも、白い文字が読めるように
              boxShadow: `0 8px 26px ${alpha(accent, 0.28)}`,
              '&:hover': { background: gradient, filter: 'brightness(1.08)', boxShadow: `0 10px 32px ${alpha(accent, 0.4)}` },
              '&.Mui-disabled': {
                background: sd ? 'rgba(168,120,255,0.12)' : dark ? 'rgba(234,244,166,0.10)' : `rgba(${inkRgb},0.08)`,
                color: sd ? 'rgba(238,233,250,0.45)' : dark ? 'rgba(234,244,166,0.35)' : `rgba(${inkRgb},0.35)`,
                boxShadow: 'none',
              },
            },
          },
          { props: { variant: 'outlined', color: 'primary' }, style: { borderColor: sd ? SYMBOL_DARK.line : dark ? IROME_LOGO.limeLine : alpha(accent, 0.55) } },
        ],
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: tokens.field.radius,
            backgroundColor: tokens.field.bg,
            '& .MuiOutlinedInput-notchedOutline': { borderColor: 'transparent' },
            '&:hover': { backgroundColor: fieldFillHover },
            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'transparent' },
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: alpha(accent, 0.7), borderWidth: 1 },
            '&.Mui-error .MuiOutlinedInput-notchedOutline': { borderColor: errorMain },
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            '&.Mui-selected': { backgroundColor: alpha(accent, 0.16) },
            '&.Mui-selected:hover': { backgroundColor: alpha(accent, 0.24) },
          },
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            '&.Mui-selected, &.Mui-selected:hover': { background: gradient, color: onGradient },
          },
        },
      },
      MuiTabs: { styleOverrides: { indicator: { height: 3, borderRadius: 3, background: gradient } } },
      // タブは、白いカードの外でIROME模様の上に置かれることがある。選ばれていないタブの文字は、明るいテーマでは濃い黒にして、模様と重なっても読めるようにする。
      MuiTab: { styleOverrides: { root: dark ? {} : { '&:not(.Mui-selected)': { color: '#111', opacity: 1 } } } },
      MuiLinearProgress: { styleOverrides: { bar: { background: gradient } } },
      MuiChip: { styleOverrides: { root: { borderRadius: buttonRadius } } },
      MuiCheckbox: { defaultProps: { color: 'primary' } },
      MuiBottomNavigation: { styleOverrides: { root: { borderTop: `1px solid ${line}` } } },
    },
  });
}
