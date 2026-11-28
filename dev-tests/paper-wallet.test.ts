// Run: npx tsx dev-tests/paper-wallet.test.ts
// Checks that lib/paperWallet.ts lays out every variant (Symbol / NEM x recovery phrase / private key,
// 24 and 12 words) as landscape card pages (one; two for a private key of both chains) (the official Symbol paper wallet's proportions), with no secret leaking into the PDF metadata.
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { CARD_H, CARD_W, buildPaperWalletPdf, formatAddress } from '../src/lib/paperWallet';
import type { PaperWalletInput } from '../src/lib/paperWallet';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

// 1x1 white PNG, stands in for the QR images (the real ones come from qrcode.react in the browser).
const PIXEL = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const MARK = new Uint8Array(readFileSync(new URL('../src/assets/irome_mark.png', import.meta.url)));

const words24 = `${'abandon '.repeat(23)}art`.split(' ');
const base = { network: 'mainnet' as const, publicKey: 'A'.repeat(64), markPng: MARK, publicQrPng: PIXEL, createdAt: new Date('2026-10-09T00:00:00Z') };
const SECRET_KEY = 'DEADBEEF'.repeat(8);

const cases: [string, PaperWalletInput][] = [
  ['symbol phrase (24)', { ...base, chain: 'symbol', kind: 'mnemonic', words: words24, address: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG', derivationPath: "m/44'/4343'/0'/0'/0'", secretQrPng: PIXEL, symbolAddress: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG', nemAddress: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGH' }],
  ['symbol phrase (12)', { ...base, chain: 'symbol', kind: 'mnemonic', words: words24.slice(0, 12), address: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG', derivationPath: "m/44'/4343'/0'/0'/0'", secretQrPng: PIXEL }],
  ['symbol private key', { ...base, chain: 'symbol', kind: 'key', privateKey: SECRET_KEY, address: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG', secretQrPng: PIXEL }],
  ['nem phrase (24, testnet)', { ...base, network: 'testnet', chain: 'nem', kind: 'mnemonic', words: words24, address: 'TBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGH', derivationPath: "m/44'/43'/0'/0'/0'" }],
  ['private key (both chains: one sheet each)', { ...base, chain: 'symbol', kind: 'key', privateKey: SECRET_KEY, address: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG', symbolAddress: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG', nemAddress: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGH', secretQrPng: PIXEL, symbolQrPng: PIXEL, nemQrPng: PIXEL, symbolLogoPng: MARK, nemLogoPng: MARK }],
  ['nem private key', { ...base, chain: 'nem', kind: 'key', privateKey: SECRET_KEY, address: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGH' }],
];

(async () => {
  for (const [name, input] of cases) {
    const bytes = await buildPaperWalletPdf(input);
    const doc = await PDFDocument.load(bytes);
    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
    const pages = input.kind === 'key' && input.symbolAddress && input.nemAddress ? 2 : 1; // a private key gets one sheet per chain
    check(`${name}: ${pages} card page(s)`, doc.getPageCount() === pages && Math.abs(w - CARD_W) < 0.01 && Math.abs(h - CARD_H) < 0.01);
    check(`${name}: card is 2.5 : 1`, Math.abs(w / h - 1568 / 626) < 0.001);
    check(`${name}: metadata holds no secret`, !`${doc.getTitle()}${doc.getSubject()}${doc.getKeywords()}${doc.getAuthor()}`.includes(SECRET_KEY));
  }

  // Recovery phrase + private-key pages of the profile's accounts (page 2 onwards, one per account and chain).
  const keySheet = (chain: 'symbol' | 'nem', label: string): PaperWalletInput => ({
    ...base, chain, kind: 'key', privateKey: SECRET_KEY, address: 'NBCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG', accountLabel: label,
    publicQrPng: PIXEL, secretQrPng: chain === 'symbol' ? PIXEL : undefined,
  });
  const withKeys = await PDFDocument.load(await buildPaperWalletPdf({
    ...cases[0][1],
    extraSheets: [keySheet('symbol', 'INDEX 0'), keySheet('nem', 'INDEX 0'), keySheet('symbol', 'INDEX 1 / SAVINGS')],
  }));
  check('phrase + 3 account key sheets: 4 card pages', withKeys.getPageCount() === 4 && Math.abs(withKeys.getPage(3).getWidth() - CARD_W) < 0.01);
  let threw = false;
  try { await buildPaperWalletPdf({ ...cases[0][1], extraSheets: [{ ...keySheet('symbol', 'INDEX 0'), privateKey: '' }] }); } catch { threw = true; }
  check('an extra sheet without a private key is refused', threw);
  threw = false;
  try { await buildPaperWalletPdf({ ...cases[0][1], words: [] }); } catch { threw = true; }
  check('empty recovery phrase is refused', threw);
  threw = false;
  try { await buildPaperWalletPdf({ ...cases[2][1], privateKey: '' }); } catch { threw = true; }
  check('empty private key is refused', threw);

  check('formatAddress groups of six', formatAddress('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG') === 'ABCDEF-GHIJKL-MNOPQR-STUVWX-YZ2345-67ABCD-EFG');
  check('formatAddress ignores existing hyphens', formatAddress('ABCDEF-GHIJKL') === 'ABCDEF-GHIJKL');
  console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
