// トマティーナ（スペインのトマト投げ祭り）にちなんだ通知音の判定。
// 取引に入っているモザイクの名前空間が、サブ（2階層目）またはサブサブ（3階層目）に「tomato」を持つとき
// （例: `foo.tomato`、`foo.bar.tomato`。大文字・小文字は区別しない）、取引の開始（ブロードキャスト）では「トマトを投げる音」、
// 承認（受け取り）では「トマトを投げつけられた音」で鳴らす。ルート（1階層目）の `tomato` は対象にしない。
import { nodeRequest, resolveMosaicId } from './symbol/api';
import { getNetwork } from './symbol/network';
import type { LiveEvent } from './symbol/live';
import type { ChainKey } from './chain';

/** True when the namespace name has "tomato" as its 2nd or 3rd level ("a.tomato", "a.b.tomato"). */
export function hasTomatoLevel(name: string): boolean {
  const parts = name.trim().toLowerCase().split('.');
  return parts.length >= 2 && (parts[1] === 'tomato' || parts[2] === 'tomato');
}

// network:mosaic id -> whether one of its names has the tomato level. Only answers from the node are kept.
const symbolCache = new Map<string, boolean>();

async function symbolHasTomato(ids: string[]): Promise<boolean> {
  const network = getNetwork();
  const unknown: string[] = [];
  for (const id of new Set(ids.map((i) => i.toUpperCase()))) {
    const hit = symbolCache.get(`${network}:${id}`);
    if (hit === true) return true;
    if (hit === undefined) unknown.push(id);
  }
  if (unknown.length === 0) return false;
  try {
    // A transfer may name a mosaic by a namespace alias (high bit set): look up the real mosaic id first.
    const resolved = await Promise.all(unknown.map(async (id) => [id, await resolveMosaicId(id)] as const));
    const res = await nodeRequest<{ mosaicNames: Array<{ mosaicId: string; names: string[] }> }>('/namespaces/mosaic/names', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mosaicIds: [...new Set(resolved.map(([, real]) => real))] }),
    });
    const byReal = new Map(res.mosaicNames.map((m) => [m.mosaicId.toUpperCase(), m.names.some(hasTomatoLevel)] as const));
    let any = false;
    for (const [id, real] of resolved) {
      const tomato = byReal.get(real.toUpperCase()) ?? false;
      symbolCache.set(`${network}:${id}`, tomato);
      any = any || tomato;
    }
    return any;
  } catch (e) {
    console.warn('Could not look up the mosaic names for the tomato sound', e);
    return false;
  }
}

/** Does this live event carry a tomato mosaic? (Symbol: looks the names up on the node, cached. NEM: the names are in the event.) */
export async function eventHasTomato(event: LiveEvent, chain: ChainKey): Promise<boolean> {
  if (chain === 'nem') return (event.mosaicNames ?? []).some(hasTomatoLevel);
  const ids = (event.mosaicIds ?? []).filter((id) => /^[0-9A-Fa-f]{16}$/.test(id));
  return ids.length > 0 ? symbolHasTomato(ids) : false;
}
