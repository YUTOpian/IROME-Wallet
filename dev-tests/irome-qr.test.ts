// Signing QR envelope (signed transaction / cosign request / cosignature / multisig template): build -> parse.
// Run: npx tsx dev-tests/irome-qr.test.ts
import { buildIromeQr, isIromeQr, networkProblem, parseIromeQr } from '../src/lib/symbol/iromeQr';
import { getNetworkConfig, setNetwork } from '../src/lib/symbol/network';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }

const H = 'AB'.repeat(32);
const PK = '12'.repeat(32);
const SIG = 'CD'.repeat(64);
const ADDR_A = 'NBRVVAPBAF5G36NEFI3KMHVBB4Z2AGR2GSBYLTI';
const ADDR_B = 'NDNWNQ7X5FKZEBS4TFSEDDFNYKCZ75IIGBU3CKA';

// 1. signed transaction
{
  const text = buildIromeQr({ kind: 'signed', payload: 'aabbccdd', hash: H.toLowerCase() });
  ok(isIromeQr(text), 'isIromeQr');
  const p = parseIromeQr(text);
  ok(p?.qr.kind === 'signed', 'kind signed', p);
  ok(p?.qr.kind === 'signed' && p.qr.payload === 'AABBCCDD' && p.qr.hash === H, 'signed fields upper-cased');
  ok(p !== null && networkProblem(p) === null, 'same network accepted');
}

// 2. cosign request, with and without the payload
{
  const a = parseIromeQr(buildIromeQr({ kind: 'cosign_request', hash: H }));
  ok(a?.qr.kind === 'cosign_request' && a.qr.payload === undefined && a.qr.hash === H, 'cosign request, hash only');
  const b = parseIromeQr(buildIromeQr({ kind: 'cosign_request', hash: H, payload: '0011' }));
  ok(b?.qr.kind === 'cosign_request' && b.qr.payload === '0011', 'cosign request with payload');
}

// 3. cosignature
{
  const p = parseIromeQr(buildIromeQr({ kind: 'cosignature', parentHash: H, signerPublicKey: PK, signature: SIG, version: '0' }));
  ok(p?.qr.kind === 'cosignature' && p.qr.signature === SIG && p.qr.signerPublicKey === PK.toUpperCase() && p.qr.version === '0', 'cosignature fields', p);
}

// 4. multisig template, hyphenated address is normalised
{
  const p = parseIromeQr(buildIromeQr({
    kind: 'template', account: ADDR_A, recipient: `${ADDR_B.slice(0, 6)}-${ADDR_B.slice(6)}`,
    mosaics: [{ id: '6bed913fa20223f8', amount: '1500000' }], message: 'こんにちは',
  }));
  ok(p?.qr.kind === 'template', 'template parses', p);
  if (p?.qr.kind === 'template') {
    ok(p.qr.recipient === ADDR_B && p.qr.account === ADDR_A, 'addresses normalised');
    ok(p.qr.mosaics[0].id === '6BED913FA20223F8' && p.qr.mosaics[0].amount === '1500000', 'mosaic kept');
    ok(p.qr.message === 'こんにちは', 'message kept');
  }
}

// 5. malformed input is refused
{
  ok(parseIromeQr('hello') === null, 'plain text refused');
  ok(parseIromeQr('{"v":3,"type":0,"data":{}}') === null, 'official QR v3 is not ours');
  ok(!isIromeQr('{"v":3,"type":0}'), 'isIromeQr false for official QR');
  ok(!isIromeQr('web+symbol://transaction?data=00'), 'isIromeQr false for a URI');
  const base = { kasane: 1, network_id: 104, chain_id: getNetworkConfig().generationHash };
  const mk = (kind: string, data: unknown) => JSON.stringify({ ...base, kind, data });
  ok(parseIromeQr(mk('signed', { payload: 'ZZ', hash: H })) === null, 'bad hex payload refused');
  ok(parseIromeQr(mk('signed', { payload: 'AA', hash: 'AB' })) === null, 'short hash refused');
  ok(parseIromeQr(mk('signed', { payload: 'AAB', hash: H })) === null, 'odd-length payload refused');
  ok(parseIromeQr(mk('cosignature', { parentHash: H, signerPublicKey: PK, signature: 'AB' })) === null, 'short signature refused');
  ok(parseIromeQr(mk('template', { account: ADDR_A, recipient: 'x', mosaics: [{ id: '6BED913FA20223F8', amount: '1' }] })) === null, 'bad recipient refused');
  ok(parseIromeQr(mk('template', { account: ADDR_A, recipient: ADDR_B, mosaics: [] })) === null, 'no mosaic refused');
  ok(parseIromeQr(mk('template', { account: ADDR_A, recipient: ADDR_B, mosaics: [{ id: '6BED913FA20223F8', amount: '0' }] })) === null, 'zero amount refused');
  ok(parseIromeQr(mk('template', { account: ADDR_A, recipient: ADDR_B, mosaics: [{ id: '6BED913FA20223F8', amount: '-5' }] })) === null, 'negative amount refused');
  ok(parseIromeQr(mk('unknown', {})) === null, 'unknown kind refused');
  ok(parseIromeQr(JSON.stringify({ ...base, kasane: 2, kind: 'signed', data: { payload: 'AA', hash: H } })) === null, 'other version refused');
}

// 6. another network is refused
{
  const text = buildIromeQr({ kind: 'cosign_request', hash: H });
  setNetwork('testnet');
  const p = parseIromeQr(text);
  ok(p !== null && networkProblem(p) === 'wrong_network', 'mainnet QR refused on testnet');
  const testText = buildIromeQr({ kind: 'cosign_request', hash: H });
  const q = parseIromeQr(testText);
  ok(q !== null && networkProblem(q) === null, 'testnet QR accepted on testnet');
  setNetwork('mainnet');
  const q2 = parseIromeQr(testText);
  ok(q2 !== null && networkProblem(q2) === 'wrong_network', 'testnet QR refused on mainnet');
  const noNet = parseIromeQr(JSON.stringify({ kasane: 1, kind: 'cosign_request', data: { hash: H } }));
  ok(noNet !== null && networkProblem(noNet) === 'wrong_network', 'QR without a network refused');
}

console.log(fails === 0 ? `OK (${checks} checks)` : `${fails} of ${checks} checks FAILED`);
process.exit(fails === 0 ? 0 : 1);
