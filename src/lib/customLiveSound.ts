import localForage from 'localforage';
import type { ChainKey } from './chain';

// 通知音の「カスタム」: 利用者が選んだ音声ファイルを、チェーン（Symbol / NEM）ごと・音の種類（取引の開始 / 承認）ごとに
// 端末の IndexedDB に置く。ウォレット本体のデータベースとは別にして、ここで何かあってもウォレットには触れない。
// ファイルは端末の中だけで扱い、どこにも送らない。鳴らすときは Blob の URL（CSP の media-src に blob: がある）を使う。
const store = localForage.createInstance({ name: 'IromeLiveSounds', storeName: 'custom_sounds' });

export type LiveSoundKind = 'started' | 'confirmed';
export const LIVE_SOUND_KINDS: readonly LiveSoundKind[] = ['started', 'confirmed'];

/** 1つのファイルの大きさと長さの上限（通知音なので短くてよい）。 */
export const CUSTOM_SOUND_MAX_BYTES = 1024 * 1024;
export const CUSTOM_SOUND_MAX_SECONDS = 10;

export type CustomSoundResult = { ok: true } | { ok: false; reason: 'type' | 'size' | 'duration' | 'unreadable' | 'storage' };

const keyOf = (chain: ChainKey, kind: LiveSoundKind) => `${chain}:${kind}`;

// 鳴らすときに同期で読めるように、置いてある音の URL を持っておく（読み込みは起動時と、置く・消すたび）。
const urls = new Map<string, string>();
// Web Audio で鳴らすために、Blob そのものも持つ（URL だけだと、端末によっては <audio> で再生できないことがあるため）。
const blobs = new Map<string, Blob>();

/** The Blob URL of the person's own sound, or null when none is set for this chain and kind. */
export function getCustomSoundUrl(chain: ChainKey, kind: LiveSoundKind): string | null {
  return urls.get(keyOf(chain, kind)) ?? null;
}

/** The Blob of the person's own sound (for Web Audio playback), or null when none is set. */
export function getCustomSoundBlob(chain: ChainKey, kind: LiveSoundKind): Blob | null {
  return blobs.get(keyOf(chain, kind)) ?? null;
}

export function hasCustomSound(chain: ChainKey, kind: LiveSoundKind): boolean {
  return urls.has(keyOf(chain, kind));
}

function setUrl(key: string, blob: Blob | null) {
  const old = urls.get(key);
  if (old) URL.revokeObjectURL(old);
  if (blob) {
    urls.set(key, URL.createObjectURL(blob));
    blobs.set(key, blob);
  } else {
    urls.delete(key);
    blobs.delete(key);
  }
}

/** Reads the saved sounds once at start-up (until then, a custom choice plays the standard sound). */
export async function preloadCustomSounds(): Promise<void> {
  try {
    for (const chain of ['symbol', 'nem'] as const) {
      for (const kind of LIVE_SOUND_KINDS) {
        const key = keyOf(chain, kind);
        const blob = await store.getItem<unknown>(key);
        if (blob instanceof Blob && blob.size > 0 && blob.size <= CUSTOM_SOUND_MAX_BYTES) setUrl(key, blob);
      }
    }
  } catch (e) {
    console.warn('Failed to load the custom sounds', e);
  }
}

/** The length of an audio file in seconds, or null when the browser cannot play the file. */
function audioDuration(blob: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    const done = (value: number | null) => { audio.removeAttribute('src'); URL.revokeObjectURL(url); resolve(value); };
    const timer = window.setTimeout(() => done(null), 8000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => { window.clearTimeout(timer); done(Number.isFinite(audio.duration) ? audio.duration : null); };
    audio.onerror = () => { window.clearTimeout(timer); done(null); };
    audio.src = url;
  });
}

/** Checks the file (an audio file the browser can play, small and short) and keeps it as this chain's sound. */
export async function saveCustomSound(chain: ChainKey, kind: LiveSoundKind, file: File): Promise<CustomSoundResult> {
  if (!file.type.startsWith('audio/')) return { ok: false, reason: 'type' };
  if (file.size === 0 || file.size > CUSTOM_SOUND_MAX_BYTES) return { ok: false, reason: 'size' };
  const seconds = await audioDuration(file);
  if (seconds === null) return { ok: false, reason: 'unreadable' };
  if (seconds > CUSTOM_SOUND_MAX_SECONDS) return { ok: false, reason: 'duration' };
  const key = keyOf(chain, kind);
  try {
    // A plain Blob of the bytes: the file object itself may keep a reference to the person's file on disk.
    const blob = new Blob([await file.arrayBuffer()], { type: file.type });
    await store.setItem(key, blob);
    setUrl(key, blob);
    return { ok: true };
  } catch (e) {
    console.warn('Failed to save the custom sound', e);
    return { ok: false, reason: 'storage' };
  }
}

export async function removeCustomSound(chain: ChainKey, kind: LiveSoundKind): Promise<void> {
  const key = keyOf(chain, kind);
  setUrl(key, null);
  try { await store.removeItem(key); } catch (e) { console.warn('Failed to remove the custom sound', e); }
}

void preloadCustomSounds();
