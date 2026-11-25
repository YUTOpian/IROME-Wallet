// 「トランザクションURI」 of an aggregate (まとめて送信): web+symbol://transaction?data=<unsigned aggregate, hex>.
//   - build: the draft's items as an unsigned AggregateComplete / AggregateBonded (see aggregate.ts), with the
//            fee level and deadline of the screen. Whoever opens the URI reviews and signs it.
//   - parse: the other way round. Only the kinds of transaction the aggregate screen itself makes are read back
//            (送金 / モザイク定義 / 供給量変更 / ネームスペース登録); anything else is refused, never guessed at.
// Nothing here trusts the URI: the inner transactions are checked against the hash in the aggregate's header,
// the network is checked, and every mosaic / namespace id is recomputed from its owner and nonce / name.
import { SymbolFacade, models } from 'symbol-sdk/symbol';
import { addressBytesToString, addressFromPublicKey, hexToBytes } from './crypto';
import { CURRENCY_DIVISIBILITY, CURRENCY_SYMBOL, TX_TYPE_AGGREGATE_BONDED, TX_TYPE_AGGREGATE_COMPLETE, TX_TYPE_TRANSFER } from './constants';
import { feeMultipliers, getMosaicInfos, networkTimeMs, resolveMosaicId, resolveNode } from './api';
import { aggregateMosaicId, aggregateNamespaceId, MAX_AGGREGATE_INNER, needsBonded, serializeUnsignedAggregate } from './aggregate';
import type { AggregateItem, AggregateSigner } from './aggregate';
import { resolveSigner } from './aggregateApi';
import { fetchNamespaceNames } from './namespaceNames';
import { getNetworkConfig } from './network';
import { BONDED_LIFETIME_MS } from './tx';
import { buildTransactionUri, parseTransactionUri } from './txUri';
import type { FeeSpeed } from './feeSpeed';

const TX_TYPE_MOSAIC_DEFINITION = 0x414d;
const TX_TYPE_MOSAIC_SUPPLY_CHANGE = 0x424d;
const TX_TYPE_NAMESPACE_REGISTRATION = 0x414e;
const COMPLETE_LIFETIME_MS = 2n * 60n * 60n * 1000n; // same as an aggregate sent from this wallet

/** Why a URI could not be read; the aggregate screen turns it into a message (`aggregate_uri.error_<code>`). */
export type AggregateUriErrorCode =
  | 'invalid' | 'not_aggregate' | 'wrong_network' | 'other_signer' | 'too_many' | 'empty'
  | 'unsupported_type' | 'encrypted_message' | 'recipient_alias' | 'mosaic_unreadable' | 'signer_unresolved';

export class AggregateUriError extends Error {
  code: AggregateUriErrorCode;
  detail: string;

  constructor(code: AggregateUriErrorCode, detail = '') {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------- build ----

export interface BuildAggregateUriInput {
  signerPublicKey: string;
  ownerAddress: string;
  items: AggregateItem[];
  feeSpeed: FeeSpeed;
}

/** The items as a transaction URI (unsigned), at the chosen fee level, valid for the same time as a normal send. */
export async function buildAggregateUri(input: BuildAggregateUriInput): Promise<{ uri: string; bonded: boolean }> {
  const cfg = getNetworkConfig();
  const bonded = needsBonded(input.items);
  const [multipliers, now, nodeUrl] = await Promise.all([
    feeMultipliers(),
    networkTimeMs().then(BigInt).catch(() => BigInt(Date.now() - cfg.epochAdjustment * 1000)),
    // The node is only a hint for whoever opens the URI; leave it out if none can be resolved.
    resolveNode().catch(() => undefined),
  ]);
  const { payload } = serializeUnsignedAggregate({
    signerPublicKey: input.signerPublicKey,
    ownerAddress: input.ownerAddress,
    networkByte: cfg.networkByte,
    items: input.items,
    feeMultiplier: multipliers[input.feeSpeed],
    deadline: now + (bonded ? BONDED_LIFETIME_MS : COMPLETE_LIFETIME_MS),
  });
  return { uri: buildTransactionUri({ payload, type: bonded ? TX_TYPE_AGGREGATE_BONDED : TX_TYPE_AGGREGATE_COMPLETE, nodeUrl }), bonded };
}

// ---------------------------------------------------------------- parse ----

// The few fields of a deserialized (embedded) transaction this file reads.
interface LooseInner {
  type: { value: number };
  network: { value: number } | number;
  signerPublicKey: { toString(): string };
  recipientAddress?: { bytes: Uint8Array };
  mosaics?: Array<{ mosaicId: { value: bigint }; amount: { value: bigint } }>;
  message?: Uint8Array;
  id?: { value: bigint };
  nonce?: { value: number } | number;
  flags?: { value: number } | number;
  divisibility?: number;
  duration?: { value: bigint };
  mosaicId?: { value: bigint };
  delta?: { value: bigint };
  action?: { value: number } | number;
  registrationType?: { value: number } | number;
  parentId?: { value: bigint };
  name?: Uint8Array;
}
interface LooseAggregate extends LooseInner {
  transactions?: LooseInner[];
  transactionsHash?: { toString(): string };
}

const num = (v: { value: number } | number | undefined): number => (v === undefined ? 0 : typeof v === 'number' ? v : v.value);
const hex16 = (v: bigint) => v.toString(16).toUpperCase().padStart(16, '0');
const newUid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export interface ParseAggregateUriWallet {
  address: string; // base32
  publicKey: string;
}

/**
 * Reads an aggregate transaction URI into items for the draft. The aggregate has to be one of this wallet's: its
 * signer is the wallet (otherwise "my own" transactions would silently become another account's). Inner
 * transactions of other accounts become items of that account, which needs its signature (as when made by hand).
 * Throws AggregateUriError.
 */
export async function parseAggregateUri(text: string, wallet: ParseAggregateUriWallet): Promise<AggregateItem[]> {
  const parts = parseTransactionUri(text);
  if (parts === null) throw new AggregateUriError('invalid');
  const cfg = getNetworkConfig();
  if (parts.generationHash && parts.generationHash.toUpperCase() !== cfg.generationHash.toUpperCase()) throw new AggregateUriError('wrong_network');
  let tx: LooseAggregate;
  try {
    tx = models.TransactionFactory.deserialize(hexToBytes(parts.payload)) as unknown as LooseAggregate;
  } catch {
    throw new AggregateUriError('invalid');
  }
  if (tx.type.value !== TX_TYPE_AGGREGATE_COMPLETE && tx.type.value !== TX_TYPE_AGGREGATE_BONDED) throw new AggregateUriError('not_aggregate', tx.type.value === TX_TYPE_TRANSFER ? 'transfer' : '');
  const networkByte = num(tx.network);
  if (networkByte !== cfg.networkByte) throw new AggregateUriError('wrong_network');
  const inner = tx.transactions ?? [];
  // The aggregate's hash covers only its header and the hash of the inner transactions: a swapped body would keep it.
  try {
    if (SymbolFacade.hashEmbeddedTransactions(inner as never).toString().toUpperCase() !== (tx.transactionsHash?.toString() ?? '').toUpperCase()) throw new Error('mismatch');
  } catch {
    throw new AggregateUriError('invalid');
  }
  if (inner.length === 0) throw new AggregateUriError('empty');
  if (inner.length > MAX_AGGREGATE_INNER) throw new AggregateUriError('too_many');
  const walletKey = wallet.publicKey.toUpperCase();
  if (tx.signerPublicKey.toString().toUpperCase() !== walletKey) throw new AggregateUriError('other_signer');

  // Mosaics / namespaces this aggregate creates are not on the chain yet: their details come from the aggregate itself.
  const createdMosaics = new Map<string, number>(); // id -> divisibility
  const createdNamespaces = new Map<string, string>(); // id -> full name
  const signers = new Map<string, AggregateSigner>();
  const signerOf = async (key: string): Promise<AggregateSigner | undefined> => {
    if (key === walletKey) return undefined;
    const known = signers.get(key);
    if (known) return known;
    try {
      const resolved = await resolveSigner(wallet.address, addressFromPublicKey(key, networkByte), key);
      signers.set(key, resolved);
      return resolved;
    } catch {
      throw new AggregateUriError('signer_unresolved', addressFromPublicKey(key, networkByte));
    }
  };
  const mosaicDetails = async (rawIds: string[]): Promise<Array<{ id: string; symbol: string; divisibility: number }>> => {
    const ids = await Promise.all(rawIds.map((id) => resolveMosaicId(id)));
    const onChain = ids.filter((id) => !createdMosaics.has(id));
    let infos: Record<string, { symbol: string; divisibility: number }> = {};
    if (onChain.length > 0) infos = await getMosaicInfos(onChain).catch(() => ({}));
    return ids.map((id) => {
      const made = createdMosaics.get(id);
      if (made !== undefined) return { id, symbol: id, divisibility: made };
      const info = infos[id];
      if (!info) throw new AggregateUriError('mosaic_unreadable', id);
      return { id, symbol: info.symbol, divisibility: info.divisibility };
    });
  };

  const items: AggregateItem[] = [];
  for (const e of inner) {
    const key = e.signerPublicKey.toString().toUpperCase();
    const signerAddress = addressFromPublicKey(key, networkByte);
    const signer = await signerOf(key);
    const type = e.type.value;
    if (type === TX_TYPE_TRANSFER) {
      const bytes = Uint8Array.from(e.recipientAddress?.bytes ?? []);
      // The lowest bit of the first address byte marks a namespace alias, which has no plain address to keep.
      if (bytes.length !== 24 || (bytes[0] & 1) !== 0) throw new AggregateUriError('recipient_alias');
      const raw = e.message ? Uint8Array.from(e.message) : new Uint8Array(0);
      if (raw.length > 0 && raw[0] !== 0) throw new AggregateUriError('encrypted_message');
      const list = (e.mosaics ?? []).map((m) => ({ rawId: hex16(m.mosaicId.value), amount: m.amount.value }));
      const details = await mosaicDetails(list.map((m) => m.rawId));
      const main = details[0];
      items.push({
        uid: newUid(),
        kind: 'transfer',
        signer,
        recipient: addressBytesToString(bytes),
        mosaicId: main?.id ?? cfg.currencyMosaicId,
        mosaicSymbol: main?.symbol ?? CURRENCY_SYMBOL,
        divisibility: main?.divisibility ?? CURRENCY_DIVISIBILITY,
        amount: list[0]?.amount ?? 0n,
        extraMosaics: list.length > 1 ? list.slice(1).map((m, i) => ({ mosaicId: details[i + 1].id, amount: m.amount })) : undefined,
        message: raw.length > 0 ? new TextDecoder().decode(raw.slice(1)) : '',
      });
    } else if (type === TX_TYPE_MOSAIC_DEFINITION) {
      const nonce = num(e.nonce);
      const id = hex16(e.id?.value ?? 0n);
      if (aggregateMosaicId(signerAddress, nonce) !== id) throw new AggregateUriError('invalid');
      createdMosaics.set(id, e.divisibility ?? 0);
      items.push({ uid: newUid(), kind: 'mosaic_definition', signer, nonce, divisibility: e.divisibility ?? 0, flags: num(e.flags), durationBlocks: e.duration?.value ?? 0n });
    } else if (type === TX_TYPE_MOSAIC_SUPPLY_CHANGE) {
      const [d] = await mosaicDetails([hex16(e.mosaicId?.value ?? 0n)]);
      items.push({ uid: newUid(), kind: 'mosaic_supply', signer, mosaicId: d.id, mosaicSymbol: d.symbol, divisibility: d.divisibility, action: num(e.action) === 1 ? 'increase' : 'decrease', delta: e.delta?.value ?? 0n });
    } else if (type === TX_TYPE_NAMESPACE_REGISTRATION) {
      const name = new TextDecoder().decode(Uint8Array.from(e.name ?? []));
      const child = num(e.registrationType) === 1;
      const parentId = child ? hex16(e.parentId?.value ?? 0n) : undefined;
      if (aggregateNamespaceId(name, parentId) !== hex16(e.id?.value ?? 0n)) throw new AggregateUriError('invalid');
      let parent: { id: string; name: string } | undefined;
      if (parentId) {
        const parentName = createdNamespaces.get(parentId) ?? (await fetchNamespaceNames([parentId]).catch(() => ({} as Record<string, string>)))[parentId] ?? parentId;
        parent = { id: parentId, name: parentName };
      }
      createdNamespaces.set(hex16(e.id?.value ?? 0n), parent ? `${parent.name}.${name}` : name);
      items.push({ uid: newUid(), kind: 'namespace', signer, name, parent, durationBlocks: child ? 0n : (e.duration?.value ?? 0n) });
    } else {
      throw new AggregateUriError('unsupported_type', `0x${type.toString(16).toUpperCase()}`);
    }
  }
  return items;
}
