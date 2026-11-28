// IROME paper wallet: builds the printable card PDF (recovery phrase or private key + QR codes).
//
// Layout: a landscape card with the same proportions as the official Symbol paper wallet (left: IROME mark on a
// faint wave pattern, middle: two QR cards + the secret in text form, right: a dark band with the brush-written
// IROME wordmark, "PAPER WALLET" and the chain / network). One page per sheet.
// (The A4 helpers below - header, footer, qrCard ... - are still used by the invoice PDF, lib/invoicePdf.ts.)
//
// This module is pure - it only lays out a page with pdf-lib from data the caller hands over
// (see paperWalletExport.ts for where that data comes from). No PDF template and no embedded
// font are needed: everything is drawn as vector shapes and standard PDF fonts, so the file stays
// small and the secret never leaves the device. All printed text is therefore plain ASCII
// (the BIP39 words, addresses and keys are ASCII anyway).
import type { SymbolNetwork } from './symbol/constants';
import { IROME_BRUSH, IROME_BRUSH_VIEWBOX } from './iromeBrushPaths';
import {
  PDFDocument,
  PDFFont,
  PDFPage,
  StandardFonts,
  appendBezierCurve,
  clip,
  closePath,
  degrees,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from 'pdf-lib';

export type PaperChain = 'symbol' | 'nem';
export type PaperKind = 'mnemonic' | 'key';

export interface PaperWalletInput {
  chain: PaperChain;
  network: SymbolNetwork;
  kind: PaperKind;
  /** Recovery phrase words (kind = 'mnemonic'). */
  words?: string[];
  /** Private key, 64 hex chars (kind = 'key'). */
  privateKey?: string;
  /** Address and public key of the account printed on the sheet. */
  address: string;
  /** The two addresses printed on the sheet (the wallet is one wallet for both chains). Default: `address` for the sheet's own chain. */
  symbolAddress?: string;
  nemAddress?: string;
  publicKey: string;
  /** BIP44 path of the printed account (kind = 'mnemonic'), e.g. m/44'/4343'/0'/0'/0'. */
  derivationPath?: string;
  /** PNG of the secret QR (recovery phrase / private key). Symbol only - NEM has no such QR standard. */
  secretQrPng?: Uint8Array;
  /** PNG of the public QR (address / contact). */
  publicQrPng: Uint8Array;
  /** PNG of the Symbol contact QR / the NEM address QR. Default: `publicQrPng` for the sheet's own chain. */
  symbolQrPng?: Uint8Array;
  nemQrPng?: Uint8Array;
  /** PNG of the IROME mark (transparent background). */
  markPng: Uint8Array;
  /** PNGs of the Symbol / NEM logos: they replace the IROME mark in the top right of a private-key sheet of that chain. */
  symbolLogoPng?: Uint8Array;
  nemLogoPng?: Uint8Array;
  createdAt: Date;
  /** Short ASCII tag printed next to the date (which account of the profile the sheet is for), e.g. "INDEX 2". */
  accountLabel?: string;
  /**
   * Private-key sheets added after the main sheet(s) - one account of one chain each (page 2 onwards).
   * Each entry is a complete input of kind 'key' for a single chain (`chain`, `address`, `privateKey`, `publicQrPng`,
   * and for Symbol `secretQrPng`); its own `extraSheets` are ignored.
   */
  extraSheets?: PaperWalletInput[];
}

// ---- IROME palette (same values as theme/iromeTheme.ts) ----
export const C = {
  coral: '#FA7268',
  pink: '#E58AAE',
  lavender: '#B79BD0',
  aqua: '#7ED1C0',
  mint: '#55E2A0',
  lime: '#EAF4A6',
  ink: '#262129',
  stage: '#2B262D',
  text: '#262129',
  muted: '#7A7080',
  line: '#E4DDEC',
  tint: '#F6F2FA',
  cream: '#FFF8F1',
  warnBg: '#FFF1EF',
  warnText: '#B23A30',
} as const;
export const GRADIENT: [number, string][] = [
  [0, C.coral],
  [0.34, C.pink],
  [0.62, C.lavender],
  [1, C.mint],
];

export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
export const MARGIN = 32;
export const CONTENT_W = PAGE_W - MARGIN * 2;
export const HEADER_H = 92;

// The card: A4 landscape width, height from the official Symbol paper wallet's proportions (1568 x 626).
export const CARD_W = 841.89;
export const CARD_H = (CARD_W * 626) / 1568;

// ---- small drawing helpers (all take "top-down" y, converted to PDF's bottom-up here) ----
function hex(color: string) {
  const n = parseInt(color.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function lerpStops(stops: [number, string][], t: number) {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i += 1) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = t1 === t0 ? 0 : (x - t0) / (t1 - t0);
      const a = parseInt(c0.slice(1), 16);
      const b = parseInt(c1.slice(1), 16);
      const ch = (shift: number) => (((a >> shift) & 255) + ((((b >> shift) & 255) - ((a >> shift) & 255)) * k)) / 255;
      return rgb(ch(16), ch(8), ch(0));
    }
  }
  return hex(stops[stops.length - 1][1]);
}

/** Rounded-rectangle path in SVG coordinates (origin top-left, y down), for drawSvgPath. */
function roundedRectPath(w: number, h: number, radius: number): string {
  const r = Math.min(radius, w / 2, h / 2);
  const k = r * 0.5523;
  return [
    `M ${r} 0`, `H ${w - r}`, `C ${w - r + k} 0 ${w} ${r - k} ${w} ${r}`,
    `V ${h - r}`, `C ${w} ${h - r + k} ${w - r + k} ${h} ${w - r} ${h}`,
    `H ${r}`, `C ${r - k} ${h} 0 ${h - r + k} 0 ${h - r}`,
    `V ${r}`, `C 0 ${r - k} ${r - k} 0 ${r} 0`, 'Z',
  ].join(' ');
}

interface BoxStyle {
  fill?: string;
  border?: string;
  borderWidth?: number;
  radius?: number;
}

export function box(page: PDFPage, x: number, top: number, w: number, h: number, style: BoxStyle) {
  page.drawSvgPath(roundedRectPath(w, h, style.radius ?? 0), {
    x,
    y: page.getHeight() - top,
    color: style.fill ? hex(style.fill) : undefined,
    borderColor: style.border ? hex(style.border) : undefined,
    borderWidth: style.border ? (style.borderWidth ?? 0.75) : 0,
  });
}

/** Fills a rounded rectangle with the IROME gradient (horizontal) by clipping thin strips. */
export function gradientBox(page: PDFPage, x: number, top: number, w: number, h: number, radius: number, stops = GRADIENT) {
  const r = Math.min(radius, w / 2, h / 2);
  const k = r * 0.5523;
  const y0 = page.getHeight() - top - h; // bottom edge in PDF space
  const x1 = x + w;
  const y1 = y0 + h;
  page.pushOperators(
    pushGraphicsState(),
    moveTo(x + r, y0),
    lineTo(x1 - r, y0),
    appendBezierCurve(x1 - r + k, y0, x1, y0 + r - k, x1, y0 + r),
    lineTo(x1, y1 - r),
    appendBezierCurve(x1, y1 - r + k, x1 - r + k, y1, x1 - r, y1),
    lineTo(x + r, y1),
    appendBezierCurve(x + r - k, y1, x, y1 - r + k, x, y1 - r),
    lineTo(x, y0 + r),
    appendBezierCurve(x, y0 + r - k, x + r - k, y0, x + r, y0),
    closePath(),
    clip(),
    endPath(),
  );
  const strips = Math.max(24, Math.ceil(w / 2));
  const sw = w / strips;
  for (let i = 0; i < strips; i += 1) {
    page.drawRectangle({ x: x + i * sw, y: y0, width: sw + 0.6, height: h, color: lerpStops(stops, (i + 0.5) / strips) });
  }
  page.pushOperators(popGraphicsState());
}

export function text(page: PDFPage, s: string, x: number, top: number, size: number, font: PDFFont, color: string) {
  page.drawText(s, { x, y: page.getHeight() - top - size * 0.82, size, font, color: hex(color) });
}

/** Text with extra letter spacing (pdf-lib has none built in). Returns the drawn width. */
export function spaced(page: PDFPage, s: string, x: number, top: number, size: number, font: PDFFont, color: string, spacing: number): number {
  let cx = x;
  for (const ch of s) {
    page.drawText(ch, { x: cx, y: page.getHeight() - top - size * 0.82, size, font, color: hex(color) });
    cx += font.widthOfTextAtSize(ch, size) + spacing;
  }
  return cx - x - spacing;
}

export function spacedWidth(s: string, size: number, font: PDFFont, spacing: number): number {
  return [...s].reduce((sum, ch) => sum + font.widthOfTextAtSize(ch, size) + spacing, 0) - spacing;
}

export function centered(page: PDFPage, s: string, cx: number, top: number, size: number, font: PDFFont, color: string) {
  text(page, s, cx - font.widthOfTextAtSize(s, size) / 2, top, size, font, color);
}

export function wrap(s: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of s.split(' ')) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** "NAAAAA-BBBBBB-..." - groups of six, the way wallets show addresses. */
export function formatAddress(address: string): string {
  return (address.replace(/-/g, '').match(/.{1,6}/g) ?? []).join('-');
}

// The IROME wordmark: the brush-written "IROME" of the on-screen logo (components/irome/BrushLogo.tsx), filled.
const BRUSH = IROME_BRUSH_VIEWBOX;
/** Height / width of the wordmark. */
export const WORDMARK_RATIO = BRUSH.h / BRUSH.w;

export function wordmark(page: PDFPage, x: number, top: number, width: number, color: string) {
  const sc = width / BRUSH.w;
  IROME_BRUSH.forEach((d) => {
    page.drawSvgPath(d, { x: x - BRUSH.x * sc, y: page.getHeight() - (top - BRUSH.y * sc), scale: sc, color: hex(color) });
  });
}

/** The wordmark standing upright, reading bottom to top (like the vertical title of the official sheet). */
export function wordmarkVertical(page: PDFPage, left: number, bottomTop: number, length: number, color: string) {
  const sc = length / BRUSH.w;
  IROME_BRUSH.forEach((d) => {
    // rotated 90 degrees counter-clockwise around (x, y): svg (px, py) lands at (x + py*sc, y + px*sc)
    page.drawSvgPath(d, { x: left - BRUSH.y * sc, y: page.getHeight() - bottomTop - BRUSH.x * sc, scale: sc, rotate: degrees(90), color: hex(color) });
  });
}

// ---- page sections ----
/** The page header of every IROME PDF: dark card with the mark, wordmark, a subtitle and the chain / network pill. */
export function drawHeader(page: PDFPage, mark: Awaited<ReturnType<PDFDocument['embedPng']>>, f: Fonts, subtitle: string, pillLabel: string) {
  const top = MARGIN;
  const h = HEADER_H;
  box(page, MARGIN, top, CONTENT_W, h, { fill: C.stage, radius: 18 });

  const markW = 76;
  const markH = (markW * 984) / 1140;
  page.drawImage(mark, { x: MARGIN + 24, y: page.getHeight() - top - (h - markH) / 2 - markH + 2, width: markW, height: markH });

  wordmark(page, MARGIN + 124, top + 24, 168, C.lime);
  spaced(page, subtitle, MARGIN + 125, top + 24 + 168 * WORDMARK_RATIO + 11, 10, f.regular, C.lime, 3.4);

  // chain / network pill, top right
  const pillW = spacedWidth(pillLabel, 8.5, f.bold, 1.4) + 28;
  const pillX = MARGIN + CONTENT_W - 22 - pillW;
  gradientBox(page, pillX, top + 18, pillW, 22, 11, GRADIENT);
  spaced(page, pillLabel, pillX + 14, top + 18 + 7, 8.5, f.bold, C.ink, 1.4);

  // thin gradient rule along the bottom edge of the card
  gradientBox(page, MARGIN + 24, top + h - 9, CONTENT_W - 48, 1.6, 0.8, GRADIENT);
}

export function sectionTitle(page: PDFPage, f: Fonts, top: number, title: string, right?: string) {
  spaced(page, title, MARGIN, top, 9.5, f.bold, C.text, 2);
  gradientBox(page, MARGIN, top + 16, 34, 2.4, 1.2, GRADIENT);
  if (right) {
    const w = spacedWidth(right, 7.6, f.bold, 1.2);
    spaced(page, right, MARGIN + CONTENT_W - w, top + 1.5, 7.6, f.bold, C.warnText, 1.2);
  }
}

export function qrCard(
  page: PDFPage,
  f: Fonts,
  qr: Awaited<ReturnType<PDFDocument['embedPng']>>,
  x: number,
  top: number,
  w: number,
  h: number,
  tag: { label: string; secret: boolean },
  title: string,
  caption: string[],
  size = 112,
) {
  box(page, x, top, w, h, { fill: '#FFFFFF', border: C.line, borderWidth: 0.9, radius: 14 });
  // coloured accent along the top of the card
  gradientBox(page, x + 14, top, w - 28, 2.6, 1.3, tag.secret
    ? [[0, C.coral], [1, C.pink]]
    : [[0, C.aqua], [1, C.mint]]);

  spaced(page, title, x + 16, top + 16, 8.6, f.bold, C.text, 1.5);
  const tagW = spacedWidth(tag.label, 7, f.bold, 1.2) + 14;
  const tagX = x + w - 14 - tagW;
  box(page, tagX, top + 13, tagW, 15, { fill: tag.secret ? C.coral : C.aqua, radius: 7.5 });
  spaced(page, tag.label, tagX + 7, top + 17.6, 7, f.bold, tag.secret ? '#FFFFFF' : C.ink, 1.2);

  page.drawImage(qr, { x: x + (w - size) / 2, y: page.getHeight() - top - 34 - size, width: size, height: size });
  caption.forEach((line, i) => centered(page, line, x + w / 2, top + 34 + size + 6 + i * 11, 7.6, f.regular, C.muted));
}

export function detailRow(page: PDFPage, f: Fonts, top: number, label: string, value: string, mono = true, size = 9) {
  spaced(page, label, MARGIN + 18, top + 1.5, 7, f.bold, C.muted, 1.4);
  text(page, value, MARGIN + 112, top, size, mono ? f.monoBold : f.bold, C.text);
}

function restoreInfo(chain: PaperChain, kind: PaperKind): string[] {
  if (kind === 'key') {
    return chain === 'symbol'
      ? ['Import the private key (or scan the SECRET QR) in any Symbol wallet, then check that the address matches this sheet.']
      : ['Import the private key in any NEM wallet, then check that the address matches this sheet.'];
  }
  return chain === 'symbol'
    ? ['Enter the words in order in any Symbol wallet that supports BIP39 (IROME, Symbol Wallet ...). Wallets that read Symbol mnemonic QR codes can also scan the SECRET QR. Check that the address matches this sheet.']
    : ['Enter the words in order in any NEM wallet that supports BIP39. NEM has no standard recovery-phrase QR, so none is printed. Check that the address matches this sheet.'];
}

/** The footer of every IROME PDF: gradient rule, generated-on-device note and the IROME tag. */
export function drawFooter(page: PDFPage, f: Fonts, createdAt: Date) {
  const footerTop = page.getHeight() - MARGIN - 10;
  gradientBox(page, MARGIN, footerTop - 10, CONTENT_W, 2, 1, GRADIENT);
  const date = createdAt.toISOString().slice(0, 10);
  text(page, `Generated locally on this device by IROME Wallet  -  ${date}`, MARGIN, footerTop, 7.6, f.regular, C.muted);
  const tagline = 'IROME';
  const tw = spacedWidth(tagline, 7.6, f.bold, 2.4);
  spaced(page, tagline, MARGIN + CONTENT_W - tw, footerTop, 7.6, f.bold, C.muted, 2.4);
}

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  monoBold: PDFFont;
}

// ---- the card ----
const CARD_BAND_X = 654; // the dark band on the right starts here
const CARD_TEXT_X = 214; // the QR cards and the text start here
const CARD_TEXT_W = 420;

type Img = Awaited<ReturnType<PDFDocument['embedPng']>>;

/** Text standing upright, reading bottom to top. `bottomTop` is where the text starts (top-down y). */
function verticalSpaced(page: PDFPage, s: string, cx: number, bottomTop: number, size: number, font: PDFFont, color: string, spacing: number): number {
  let y = page.getHeight() - bottomTop;
  const x = cx + size * 0.36; // baseline; the glyphs rise to its left
  for (const ch of s) {
    page.drawText(ch, { x, y, size, font, color: hex(color), rotate: degrees(90) });
    y += font.widthOfTextAtSize(ch, size) + spacing;
  }
  return y - (page.getHeight() - bottomTop) - spacing;
}

function verticalSpacedWidth(s: string, size: number, font: PDFFont, spacing: number): number {
  return spacedWidth(s, size, font, spacing);
}

function clipRect(page: PDFPage, x: number, top: number, w: number, h: number) {
  const y0 = page.getHeight() - top - h;
  page.pushOperators(pushGraphicsState(), moveTo(x, y0), lineTo(x + w, y0), lineTo(x + w, y0 + h), lineTo(x, y0 + h), closePath(), clip(), endPath());
}

/** Seigaiha (wave) scales, the pattern of the IROME mark, drawn faintly on the left of the card. */
function drawWaves(page: PDFPage, width: number) {
  const R = 22;
  clipRect(page, 0, 0, width, page.getHeight());
  for (let row = 0, y = 4; y < page.getHeight() + R; row += 1, y += R / 2) {
    for (let x = row % 2 === 0 ? 0 : R; x < width + R; x += R * 2) {
      const cy = page.getHeight() - y;
      page.drawCircle({ x, y: cy, size: R, color: hex(C.cream), borderColor: hex(C.lavender), borderWidth: 0.6, borderOpacity: 0.55 });
      page.drawCircle({ x, y: cy, size: R * 0.68, borderColor: hex(C.lavender), borderWidth: 0.5, borderOpacity: 0.4 });
      page.drawCircle({ x, y: cy, size: R * 0.36, borderColor: hex(C.lavender), borderWidth: 0.5, borderOpacity: 0.3 });
    }
  }
  page.pushOperators(popGraphicsState());
}

/** Gradient running top to bottom (the gradientBox helper runs left to right). */
function verticalGradient(page: PDFPage, x: number, top: number, w: number, h: number, stops = GRADIENT) {
  const strips = Math.max(24, Math.ceil(h / 2));
  const sh = h / strips;
  for (let i = 0; i < strips; i += 1) {
    page.drawRectangle({ x, y: page.getHeight() - top - (i + 1) * sh, width: w, height: sh + 0.6, color: lerpStops(stops, (i + 0.5) / strips) });
  }
}

/** A QR card of the sheet: the QR on the left, its name standing upright on the right. */
function cardQr(page: PDFPage, f: Fonts, qr: Img, x: number, top: number, side: number, label: string, secret: boolean) {
  box(page, x, top, side, side, { fill: '#FFFFFF', border: C.line, borderWidth: 0.9, radius: 12 });
  gradientBox(page, x + 14, top, side - 28, 2.6, 1.3, secret ? [[0, C.coral], [1, C.pink]] : [[0, C.aqua], [1, C.mint]]);
  const qrSize = side - 34;
  page.drawImage(qr, { x: x + 9, y: page.getHeight() - top - (side - qrSize) / 2 - qrSize, width: qrSize, height: qrSize });
  const len = verticalSpacedWidth(label, 7.2, f.bold, 1.7);
  verticalSpaced(page, label, x + side - 13, top + side / 2 + len / 2, 7.2, f.bold, secret ? C.warnText : C.text, 1.7);
}

/** Shrinks `size` until `s` fits in `maxW`. */
function fitSize(s: string, font: PDFFont, size: number, maxW: number): number {
  const w = font.widthOfTextAtSize(s, size);
  return w <= maxW ? size : (size * maxW) / w;
}

/** Which chain a card page is about: both (recovery phrase sheet) or one of them (a private key belongs to one chain). */
type CardView = PaperChain | 'both';

function drawCard(page: PDFPage, f: Fonts, input: PaperWalletInput, img: { mark: Img; bandLogo: Img; symbolQr: Img | null; nemQr: Img | null; secretQr: Img | null }, view: CardView) {
  const H = page.getHeight();
  const networkName = input.network === 'mainnet' ? 'MAINNET' : input.network === 'mijin' ? 'MIJIN V2' : 'TESTNET';

  // background + left decoration
  page.drawRectangle({ x: 0, y: 0, width: CARD_W, height: H, color: hex(C.cream) });
  drawWaves(page, 196);
  // the IROME mark, large, on the left
  const markW = 150;
  const markH = (markW * 984) / 1140;
  page.drawImage(img.mark, { x: 24, y: (H - markH) / 2, width: markW, height: markH });

  // QR cards: both chains = the secret, the Symbol address, the NEM address (small); one chain = the secret, that address
  const single = view !== 'both';
  const side = single ? 150 : 132;
  const gap = 12;
  const cardTop = 20;
  const slot = (i: number) => CARD_TEXT_X + i * (side + gap);
  const secretLabel = input.kind === 'mnemonic' ? 'MNEMONIC' : 'PRIVATE KEY';
  if (img.secretQr) {
    cardQr(page, f, img.secretQr, slot(0), cardTop, side, secretLabel, true);
  } else {
    // NEM has no standard QR for the secret: the slot says how to restore instead
    const pad = single ? 14 : 12;
    box(page, slot(0), cardTop, side, side, { fill: C.tint, border: C.line, borderWidth: 0.9, radius: 12 });
    spaced(page, 'HOW TO RESTORE', slot(0) + pad, cardTop + pad, single ? 8 : 7.4, f.bold, C.text, 1.2);
    const fs = single ? 7.8 : 6.9;
    wrap(restoreInfo(view === 'both' ? input.chain : view, input.kind)[0], f.regular, fs, side - pad * 2).forEach((line, i) => text(page, line, slot(0) + pad, cardTop + pad + 17 + i * (fs + 2.7), fs, f.regular, C.text));
  }
  if (view === 'both') {
    if (img.symbolQr) cardQr(page, f, img.symbolQr, slot(1), cardTop, side, 'SYMBOL ADDRESS', false);
    if (img.nemQr) cardQr(page, f, img.nemQr, slot(2), cardTop, side, 'NEM ADDRESS', false);
  } else {
    const qr = view === 'symbol' ? img.symbolQr : img.nemQr;
    if (qr) cardQr(page, f, qr, slot(1), cardTop, side, `${view.toUpperCase()} ADDRESS`, false);
  }

  // addresses and the secret in text form
  const symbolAddress = view === 'nem' ? undefined : input.symbolAddress ?? (input.chain === 'symbol' ? input.address : undefined);
  const nemAddress = view === 'symbol' ? undefined : input.nemAddress ?? (input.chain === 'nem' ? input.address : undefined);
  let y = cardTop + side + 16;
  const heading = (title: string, accent: [number, string][]) => {
    text(page, title, CARD_TEXT_X, y, 13, f.bold, C.text);
    gradientBox(page, CARD_TEXT_X, y + 17, 28, 2, 1, accent);
    y += 24;
  };
  const addressRow = (title: string, address: string) => {
    heading(title, GRADIENT);
    const pretty = formatAddress(address);
    text(page, pretty, CARD_TEXT_X, y, fitSize(pretty, f.monoBold, 10.5, CARD_TEXT_W), f.monoBold, C.ink);
    y += 21;
  };
  if (symbolAddress) addressRow('Your Symbol Address', symbolAddress);
  if (nemAddress) addressRow('Your NEM Address', nemAddress);

  const chainWord = view === 'symbol' ? 'Symbol ' : view === 'nem' ? 'NEM ' : '';
  heading(input.kind === 'mnemonic' ? 'Your Mnemonic' : `Your ${chainWord}Private Key`, [[0, C.coral], [1, C.pink]]);
  if (input.kind === 'mnemonic') {
    const words = input.words as string[];
    const rows: string[] = [];
    for (let i = 0; i < words.length; i += 12) rows.push(words.slice(i, i + 12).join(' '));
    const size = Math.min(...rows.map((r) => fitSize(r, f.bold, 9.6, CARD_TEXT_W)));
    rows.forEach((row, i) => text(page, row, CARD_TEXT_X, y + i * 13.5, size, f.bold, C.ink));
  } else {
    const key = input.privateKey as string;
    text(page, key, CARD_TEXT_X, y, fitSize(key, f.monoBold, 10, CARD_TEXT_W), f.monoBold, C.ink);
  }

  // creation date, top left
  const date = input.createdAt.toISOString().slice(0, 10);
  const dateW = spacedWidth(date, 7.6, f.bold, 1) + 18;
  box(page, 10, 10, dateW, 17, { fill: C.cream, border: C.line, borderWidth: 0.8, radius: 8.5 });
  spaced(page, date, 19, 10 + 5.2, 7.6, f.bold, C.text, 1);
  // which account of the profile this sheet is for (private-key sheets of a profile)
  if (input.accountLabel) {
    const label = input.accountLabel;
    const labelW = spacedWidth(label, 7.6, f.bold, 1) + 18;
    box(page, 10 + dateW + 6, 10, labelW, 17, { fill: C.cream, border: C.line, borderWidth: 0.8, radius: 8.5 });
    spaced(page, label, 10 + dateW + 6 + 9, 10 + 5.2, 7.6, f.bold, C.text, 1);
  }

  // the dark band on the right
  const bandW = CARD_W - CARD_BAND_X;
  page.drawRectangle({ x: CARD_BAND_X, y: 0, width: bandW, height: H, color: hex(C.stage) });
  verticalGradient(page, CARD_BAND_X, 0, 4, H);
  const bandCx = CARD_BAND_X + 4 + (bandW - 4) / 2;
  // top right: the IROME mark, or on a private-key sheet the logo of its chain (fitted into a 62 x 56 box)
  const logoScale = Math.min(62 / img.bandLogo.width, 56 / img.bandLogo.height);
  const logoW = img.bandLogo.width * logoScale;
  const logoH = img.bandLogo.height * logoScale;
  page.drawImage(img.bandLogo, { x: bandCx - logoW / 2, y: H - 18 - 56 / 2 - logoH / 2, width: logoW, height: logoH });

  const bottom = H - 20; // the vertical texts start here and read upward
  const wmLen = 152;
  const wmThick = wmLen * WORDMARK_RATIO;
  wordmarkVertical(page, bandCx - 46 - wmThick / 2, bottom, wmLen, C.lime);
  const title = 'PAPER WALLET';
  verticalSpaced(page, title, bandCx + 4, bottom, 17, f.bold, '#FFFFFF', 4.2);
  verticalSpaced(page, `${view === 'both' ? 'SYMBOL / NEM' : view.toUpperCase()}  ${networkName}`, bandCx + 48, bottom, 8, f.bold, C.lime, 2.4);
}

export async function buildPaperWalletPdf(input: PaperWalletInput): Promise<Uint8Array> {
  if (input.kind === 'mnemonic' && (!input.words || input.words.length === 0)) throw new Error('paper wallet: no recovery phrase');
  if (input.kind === 'key' && !input.privateKey) throw new Error('paper wallet: no private key');

  const pdf = await PDFDocument.create();
  pdf.setTitle('IROME Paper Wallet');
  pdf.setCreator('IROME Wallet');
  pdf.setProducer('IROME Wallet');
  pdf.setCreationDate(input.createdAt);
  pdf.setModificationDate(input.createdAt);

  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    monoBold: await pdf.embedFont(StandardFonts.CourierBold),
  };
  const mark = await pdf.embedPng(input.markPng);
  const symbolLogo = input.symbolLogoPng ? await pdf.embedPng(input.symbolLogoPng) : mark;
  const nemLogo = input.nemLogoPng ? await pdf.embedPng(input.nemLogoPng) : mark;

  // Adds the card page(s) of one input: `views` says which chain(s) each page is about.
  const addSheets = async (sheet: PaperWalletInput, views: CardView[]) => {
    const ownQr = await pdf.embedPng(sheet.publicQrPng);
    const symbolQr = sheet.symbolQrPng ? await pdf.embedPng(sheet.symbolQrPng) : sheet.chain === 'symbol' ? ownQr : null;
    const nemQr = sheet.nemQrPng ? await pdf.embedPng(sheet.nemQrPng) : sheet.chain === 'nem' ? ownQr : null;
    const secretQr = sheet.secretQrPng ? await pdf.embedPng(sheet.secretQrPng) : null;
    for (const view of views) {
      const page = pdf.addPage([CARD_W, CARD_H]);
      drawCard(page, fonts, sheet, {
        mark,
        bandLogo: view === 'symbol' ? symbolLogo : view === 'nem' ? nemLogo : mark,
        symbolQr,
        nemQr,
        // the secret QR is in the Symbol format: not on the NEM sheet
        secretQr: view === 'nem' ? null : secretQr,
      }, view);
    }
  };

  // A recovery phrase is one sheet for both chains. A private key belongs to one chain, so it gets one sheet per
  // chain (Symbol first, then NEM), each with that chain's logo in the top right.
  const hasSymbol = input.symbolAddress != null || input.chain === 'symbol';
  const hasNem = input.nemAddress != null || input.chain === 'nem';
  const views: CardView[] = input.kind === 'mnemonic' ? ['both'] : [...(hasSymbol ? ['symbol' as const] : []), ...(hasNem ? ['nem' as const] : [])];
  await addSheets(input, views);

  // Page 2 onwards: the private key of each account of the profile, one page per account and chain.
  for (const extra of input.extraSheets ?? []) {
    if (extra.kind !== 'key' || !extra.privateKey) throw new Error('paper wallet: an extra sheet needs a private key');
    await addSheets(extra, [extra.chain]);
  }

  return pdf.save();
}
