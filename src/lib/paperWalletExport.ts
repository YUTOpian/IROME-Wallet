// Paper wallet export: turns the secret the screen already holds (recovery phrase or private key)
// into the QR codes + printable PDF of lib/paperWallet.ts and hands it to the person as a download.
// Everything happens on this device; nothing is uploaded and nothing is written to storage.
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { QRCodeCanvas } from 'qrcode.react';
import markUrl from '../assets/irome_mark.png';
import { CHAIN_LOGOS } from './chainIcons';
import { Environment } from './environment';
import { getChain } from './chain';
import type { ChainKey } from './chain';
import { buildNemAddressQr } from './nem/qr';
import { nemAddressFromPublicKey, nemKeyPairFromPrivateKey } from './nem/crypto';
import { nemAccountFromMnemonic, nemPath } from './nem/hd';
import { addressFromPublicKey, keyPairFromPrivateKey } from './symbol/crypto';
import { MnemonicHelper, symbolPath } from './symbol/hd';
import { getNetwork, getNetworkConfig } from './symbol/network';
import type { PublicNetwork, SymbolNetwork } from './symbol/constants';
import { buildPaperWalletPdf } from './paperWallet';
import type { PaperWalletInput } from './paperWallet';

// Symbol QR v3 type numbers, as in the official symbol-qr-library (the one the official wallets
// and their paper wallets use): 1 = contact (public key), 2 = account (private key), 5 = mnemonic.
const QR_TYPE_CONTACT = 1;
const QR_TYPE_ACCOUNT = 2;
const QR_TYPE_MNEMONIC = 5;

function symbolQr(network: SymbolNetwork, type: number, data: Record<string, string>): string {
  const cfg = getNetworkConfig(network);
  return JSON.stringify({ v: 3, type, network_id: cfg.networkByte, chain_id: cfg.generationHash, data });
}

function hasDarkPixel(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0 && data[i] < 100) return true;
  }
  return false;
}

/** Draws `value` as a QR code on an off-screen canvas and returns it as PNG bytes. */
export async function qrToPng(value: string, opts: { level?: 'L' | 'M' | 'Q' | 'H'; size?: number } = {}): Promise<Uint8Array> {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden;';
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => {
      root.render(createElement(QRCodeCanvas, { value, size: opts.size ?? 560, level: opts.level ?? 'M', marginSize: 2, bgColor: '#ffffff', fgColor: '#000000' }));
    });
    // qrcode.react paints in an effect; give any still-pending effect a turn before reading the canvas.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const canvas = host.querySelector('canvas');
    if (!canvas) throw new Error('paper wallet: QR canvas was not created');
    // A QR that was never painted would silently print as a blank square - refuse to go on.
    if (!hasDarkPixel(canvas)) throw new Error('paper wallet: QR canvas is blank');
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('paper wallet: QR image could not be encoded');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    root.unmount();
    host.remove();
  }
}

/** A bundled image asset as bytes - a data: URL in the single-file build. */
async function loadAsset(url: string): Promise<Uint8Array> {
  const match = /^data:[^;,]*;base64,(.*)$/.exec(url);
  if (match) {
    const binary = atob(match[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

/** The IROME mark is bundled as an asset. */
export async function loadMark(): Promise<Uint8Array> {
  return loadAsset(markUrl);
}

export function addressOf(chain: ChainKey, publicKey: string, network: SymbolNetwork = getNetwork()): string {
  const networkByte = getNetworkConfig(network).networkByte;
  return chain === 'nem' ? nemAddressFromPublicKey(publicKey, networkByte) : addressFromPublicKey(publicKey, networkByte);
}

export async function saveFile(bytes: Uint8Array, filename: string, mime = 'application/pdf'): Promise<void> {
  // iOS (especially the home-screen app) ignores <a download>; hand the file to the share sheet instead.
  if (Environment.isIos() && typeof navigator.canShare === 'function' && typeof navigator.share === 'function') {
    const file = new File([bytes as BlobPart], filename, { type: mime });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
      } catch (e) {
        // Closing the share sheet is not an error.
        if (!(e instanceof DOMException && e.name === 'AbortError')) throw e;
      }
      return;
    }
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function stamp(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

/** An account of the profile whose private key goes on its own page (2nd page onwards) of the paper wallet. */
export interface PaperWalletAccount {
  /** BIP44 account index of the recovery phrase. */
  index: number;
  chain: ChainKey;
  /** The name the person gave the account; printed only when it is plain ASCII (the sheet's fonts have no Japanese). */
  name?: string;
}

export type PaperWalletSource =
  // chain: 省略するとアプリで選んでいるチェーン。Symbol オプトイン（デモ）は Symbol で固定して作る。
  // network: 用紙に印刷するネットワーク（メインネット / テストネット）。省略はアプリで選んでいるネットワーク。
  // accounts: ニーモニック版の 2 ページ目以降に、秘密鍵のページを付けるアカウント（プロファイルで表示中のもの）。省略は付けない。
  // symbolCoinType: このプロファイルの Symbol テストネットのアカウントが使う鍵のコイン種別（公式互換の鍵なら 1）。
  //   テストネットの用紙にだけ使い、メインネットの用紙は常に 4343。省略は 4343。
  | { kind: 'mnemonic'; mnemonic: string; chain?: ChainKey; network?: PublicNetwork; symbolCoinType?: number; accounts?: PaperWalletAccount[] }
  | { kind: 'key'; chain: ChainKey; privateKey: string; publicKey: string; network?: PublicNetwork };

/** The Symbol contact QR and the NEM address QR of the sheet; `publicQrPng` is the one of the sheet's own chain. */
async function addressQrs(network: SymbolNetwork, chain: ChainKey, symbolPub: string, nemPub: string, name: string): Promise<{ publicQrPng: Uint8Array; symbolQrPng: Uint8Array; nemQrPng: Uint8Array }> {
  const symbolQrPng = await qrToPng(symbolQr(network, QR_TYPE_CONTACT, { name, publicKey: symbolPub }));
  const nemQrPng = await qrToPng(buildNemAddressQr(addressOf('nem', nemPub, network)));
  return { publicQrPng: chain === 'nem' ? nemQrPng : symbolQrPng, symbolQrPng, nemQrPng };
}

/** "INDEX 2" or "INDEX 2 / My Account" - ASCII only, because the sheet's built-in fonts cannot print anything else. */
function accountLabel(account: PaperWalletAccount): string {
  const name = (account.name ?? '').trim();
  const plain = /^[\x20-\x7E]+$/.test(name) ? name.slice(0, 20).toUpperCase() : '';
  return plain ? `INDEX ${account.index} / ${plain}` : `INDEX ${account.index}`;
}

/** One private-key page: the key of one account of the profile on one chain, derived from the recovery phrase. */
async function accountKeySheet(
  phrase: string, account: PaperWalletAccount, network: SymbolNetwork, coinType: number | undefined,
  common: { markPng: Uint8Array; symbolLogoPng: Uint8Array; nemLogoPng: Uint8Array; createdAt: Date },
): Promise<PaperWalletInput> {
  const { chain } = account;
  const pair = chain === 'nem' ? nemAccountFromMnemonic(phrase, account.index) : MnemonicHelper.accountFromMnemonic(phrase, account.index, coinType);
  const address = addressOf(chain, pair.publicKey, network);
  return {
    chain,
    network,
    kind: 'key',
    privateKey: pair.privateKey,
    address,
    publicKey: pair.publicKey,
    // Symbol has a standard QR for the private key; NEM does not (its sheet says how to restore instead).
    secretQrPng: chain === 'symbol' ? await qrToPng(symbolQr(network, QR_TYPE_ACCOUNT, { privateKey: pair.privateKey })) : undefined,
    publicQrPng: chain === 'symbol'
      ? await qrToPng(symbolQr(network, QR_TYPE_CONTACT, { name: account.name?.trim() || `Account ${account.index}`, publicKey: pair.publicKey }))
      : await qrToPng(buildNemAddressQr(address)),
    accountLabel: accountLabel(account),
    ...common,
  };
}

/** Builds the paper wallet PDF for the given secret. */
export async function createPaperWalletPdf(source: PaperWalletSource, now: Date = new Date()): Promise<{ bytes: Uint8Array; filename: string }> {
  const network: SymbolNetwork = source.network ?? getNetwork();
  const markPng = await loadMark();
  const symbolLogoPng = await loadAsset(CHAIN_LOGOS.symbol);
  const nemLogoPng = await loadAsset(CHAIN_LOGOS.nem);
  let input: PaperWalletInput;

  if (source.kind === 'mnemonic') {
    // The phrase is shared by both chains; the sheet follows the chain the person is working in
    // (the same rule the recovery-phrase screens use for their notice text).
    const chain = source.chain ?? getChain();
    const phrase = MnemonicHelper.normalize(source.mnemonic);
    // The Symbol key follows the network printed on the sheet: mainnet is always coin type 4343, testnet uses the
    // coin type of the person's testnet account (1 = official-wallet compatible).
    const coinType = network === 'testnet' ? source.symbolCoinType : undefined;
    const root = chain === 'nem' ? nemAccountFromMnemonic(phrase, 0) : MnemonicHelper.accountFromMnemonic(phrase, 0, coinType);
    const address = addressOf(chain, root.publicKey, network);
    // One wallet for both chains: the same phrase gives the Symbol account and the NEM account.
    const symbolRoot = MnemonicHelper.accountFromMnemonic(phrase, 0, coinType);
    const nemRoot = nemAccountFromMnemonic(phrase, 0);
    input = {
      chain,
      network,
      kind: 'mnemonic',
      symbolAddress: addressOf('symbol', symbolRoot.publicKey, network),
      nemAddress: addressOf('nem', nemRoot.publicKey, network),
      words: phrase.split(' '),
      address,
      publicKey: root.publicKey,
      derivationPath: chain === 'nem' ? nemPath(0) : symbolPath(0, coinType),
      secretQrPng: chain === 'symbol' ? await qrToPng(symbolQr(network, QR_TYPE_MNEMONIC, { plainMnemonic: phrase })) : undefined,
      ...(await addressQrs(network, chain, symbolRoot.publicKey, nemRoot.publicKey, 'Root account')),
      markPng,
      symbolLogoPng,
      nemLogoPng,
      createdAt: now,
    };
    // Page 2 onwards: the private key of each account of the profile (Symbol first, then NEM, by index).
    const accounts = [...(source.accounts ?? [])].sort((a, b) => a.index - b.index || (a.chain === b.chain ? 0 : a.chain === 'symbol' ? -1 : 1));
    if (accounts.length > 0) {
      const common = { markPng, symbolLogoPng, nemLogoPng, createdAt: now };
      input.extraSheets = [];
      for (const account of accounts) input.extraSheets.push(await accountKeySheet(phrase, account, network, coinType, common));
    }
  } else {
    const { chain, privateKey, publicKey } = source;
    const address = addressOf(chain, publicKey, network);
    // The same private key also controls an account on the other chain; print both addresses.
    const symbolPub = chain === 'symbol' ? publicKey : keyPairFromPrivateKey(privateKey).publicKey;
    const nemPub = chain === 'nem' ? publicKey : nemKeyPairFromPrivateKey(privateKey).publicKey;
    input = {
      chain,
      network,
      kind: 'key',
      symbolAddress: addressOf('symbol', symbolPub, network),
      nemAddress: addressOf('nem', nemPub, network),
      privateKey,
      address,
      publicKey,
      // the Symbol sheet of the key carries it (the same key also gives the Symbol account)
      secretQrPng: await qrToPng(symbolQr(network, QR_TYPE_ACCOUNT, { privateKey })),
      ...(await addressQrs(network, chain, symbolPub, nemPub, 'IROME account')),
      markPng,
      symbolLogoPng,
      nemLogoPng,
      createdAt: now,
    };
  }

  const bytes = await buildPaperWalletPdf(input);
  const filename = `irome-paper-wallet-${input.chain}-${network}-${source.kind === 'mnemonic' ? 'phrase' : 'key'}-${stamp(now)}.pdf`;
  return { bytes, filename };
}

/** Builds the paper wallet PDF and downloads it (or opens the share sheet on iOS). */
export async function downloadPaperWallet(source: PaperWalletSource): Promise<void> {
  const { bytes, filename } = await createPaperWalletPdf(source);
  await saveFile(bytes, filename);
}
