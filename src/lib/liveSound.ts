import dingUrl from '../assets/ding.ogg';
import ding2Url from '../assets/ding2.ogg';
import dingClassicUrl from '../assets/ding-classic.ogg';
import ding2ClassicUrl from '../assets/ding2-classic.ogg';
import dingSoftUrl from '../assets/ding-soft.ogg';
import ding2SoftUrl from '../assets/ding2-soft.ogg';
import tomatoThrowUrl from '../assets/tomato-throw.ogg';
import tomatoSplatUrl from '../assets/tomato-splat.ogg';
import { CUSTOM_SOUND_MAX_SECONDS, getCustomSoundBlob, getCustomSoundUrl } from './customLiveSound';
import type { ChainKey } from './chain';

/**
 * 通知音の種類（表示名は i18n の settings.live_sound_theme_*）。
 * 'default' = 「IROME チャイム」（IROME の標準の音。保存済みの設定との互換のため、キーは default のまま）、
 * 'soft' = 「ソフトベル」（やわらかい低めのベル）、
 * 'classic' = 「クラシック」（これまでの音。公式 Symbol Desktop Wallet 1.2.0 の ding.ogg、Apache-2.0）。
 * 'tomatina' = 「トマティーナ」（started = トマトを投げる音、confirmed = トマトを投げつけられた音。スペインのトマト投げ祭りにちなむ）。
 *   この種類にしていなくても、取引のモザイクの名前空間のサブ／サブサブに tomato があれば、'custom' 以外ではこの音になる（lib/tomatina.ts）。
 * 'custom' = 「カスタム」（利用者が選んだ音声ファイル。チェーンごと・音ごとに lib/customLiveSound.ts が持つ。まだ選んでいない音は標準の音）。
 * どれも2つで1組：started = 取引が始まった（ノードに通知された）とき、confirmed = 承認されたとき。
 */
export type LiveSoundTheme = 'default' | 'soft' | 'classic' | 'tomatina' | 'custom';
export const LIVE_SOUND_THEMES: readonly LiveSoundTheme[] = ['default', 'soft', 'classic', 'tomatina', 'custom'];
export const DEFAULT_LIVE_SOUND_THEME: LiveSoundTheme = 'default';

export const isLiveSoundTheme = (v: unknown): v is LiveSoundTheme => v === 'default' || v === 'soft' || v === 'classic' || v === 'tomatina' || v === 'custom';

const URLS: Record<Exclude<LiveSoundTheme, 'custom'>, { started: string; confirmed: string }> = {
  default: { started: dingUrl, confirmed: ding2Url },
  soft: { started: dingSoftUrl, confirmed: ding2SoftUrl },
  classic: { started: dingClassicUrl, confirmed: ding2ClassicUrl },
  tomatina: { started: tomatoThrowUrl, confirmed: tomatoSplatUrl },
};

// One player per sound, kept so a repeated sound does not load the file again.
const players = new Map<string, HTMLAudioElement>();

/** Plays a sound file through an <audio> element. Resolves false when the browser refuses or cannot play it. */
async function playUrl(url: string, onEnded?: () => void): Promise<boolean> {
  try {
    let player = players.get(url);
    if (!player) {
      player = new Audio(url);
      players.set(url, player);
    }
    player.onended = onEnded ?? null;
    player.currentTime = 0;
    await player.play();
    return true;
  } catch (e) {
    console.warn('Could not play the sound', e);
    return false;
  }
}

// --- The person's own ("custom") sounds are played with Web Audio. ---
// A Blob URL in an <audio> element is not reliable everywhere (Safari / iOS refuse a Blob that came out of IndexedDB, and a new
// element needs its own tap to be allowed to play). One AudioContext, woken by any tap or key press on the page, can play at any
// later time, which is what a notification that arrives on its own needs.
let audioContext: AudioContext | null = null;
const decoded = new WeakMap<Blob, AudioBuffer>();

function getContext(): AudioContext | null {
  if (audioContext) return audioContext;
  try {
    const Ctor: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor) audioContext = new Ctor();
  } catch { /* no Web Audio */ }
  return audioContext;
}

function wakeContext(): void {
  const c = getContext();
  if (c && c.state !== 'running') void c.resume().catch(() => undefined);
}

if (typeof window !== 'undefined') {
  // Kept for the whole session: the browser may put the context to sleep again (a phone call, the screen locking).
  for (const type of ['pointerdown', 'touchend', 'click', 'keydown']) window.addEventListener(type, wakeContext, { passive: true });
}

async function playBlob(blob: Blob, onEnded?: () => void): Promise<boolean> {
  const c = getContext();
  if (!c) return false;
  if (c.state !== 'running') {
    try { await c.resume(); } catch { /* still asleep */ }
    if ((c.state as AudioContextState) !== 'running') return false;
  }
  let buffer = decoded.get(blob);
  if (!buffer) {
    buffer = await c.decodeAudioData(await blob.arrayBuffer());
    decoded.set(blob, buffer);
  }
  const source = c.createBufferSource();
  source.buffer = buffer;
  source.connect(c.destination);
  if (onEnded) source.onended = onEnded;
  source.start();
  return true;
}

// 「カスタム」のとき、取引の開始の音がまだ鳴っている間は、その鳴り終わりを待つための目印。
// 開始の音が鳴り終わると解決され、null に戻る。承認の音は、これが解決されてから鳴らす（音が重ならないように）。
// 標準の種類（default / soft / classic / tomatina）は、これまでどおり待たずにすぐ鳴らす。
let customStartedPlaying: Promise<void> | null = null;
// 開始の音が鳴り終わってから承認の音までの間（試し聴きと同じ）。
const CUSTOM_CONFIRMED_GAP_MS = 250;

/** Plays one sound of a theme. Browsers refuse sound before the first tap on the page; that is fine, it is just skipped. */
// chain: 'custom' のとき、どのチェーンの自分の音を鳴らすか。
// 'custom' は、Web Audio → <audio> → 標準の音 の順に試す（自分の音が鳴らせない端末でも、無音にしない）。
// 'custom' の承認の音は、開始の音が鳴っている途中なら、鳴り終わるのを待ってから鳴らす。
// tomato: 取引にトマトのモザイクがあるとき true。'custom' 以外の種類は、トマティーナの音になる（'custom' は自分で選んだ音を優先）。
export function playLiveSound(theme: LiveSoundTheme, kind: 'started' | 'confirmed', chain: ChainKey = 'symbol', tomato = false, onEnded?: () => void): void {
  // onEnded: 音が鳴り終わったとき（鳴らせなかったときも）に、ちょうど1回だけ呼ぶ。試し聴きで、次の音を重ねないために使う。
  let finished = false;
  let release: () => void = () => undefined;
  const finish = (): void => { if (!finished) { finished = true; release(); onEnded?.(); } };
  try {
    if (tomato && theme !== 'custom') theme = 'tomatina';
    if (theme !== 'custom') { void playUrl(URLS[theme][kind], finish).then((ok) => { if (!ok) finish(); }); return; }

    // 開始の音：鳴り終わりまで目印を立てておく（鳴らせなかったとき・鳴り終わりが来ないときも、最長でこの時間で外す）。
    if (kind === 'started') {
      const mark = new Promise<void>((resolve) => {
        let timer = 0;
        release = () => { window.clearTimeout(timer); resolve(); if (customStartedPlaying === mark) customStartedPlaying = null; };
        timer = window.setTimeout(release, (CUSTOM_SOUND_MAX_SECONDS + 2) * 1000);
      });
      customStartedPlaying = mark;
    }

    const blob = getCustomSoundBlob(chain, kind);
    const url = getCustomSoundUrl(chain, kind);
    void (async () => {
      // 承認の音：開始の音が鳴っている途中なら、鳴り終わるのを待つ。
      if (kind === 'confirmed' && customStartedPlaying) {
        await customStartedPlaying;
        await new Promise<void>((resolve) => window.setTimeout(resolve, CUSTOM_CONFIRMED_GAP_MS));
      }
      if (!blob || !url) { if (!(await playUrl(URLS.default[kind], finish))) finish(); return; }
      try {
        if (await playBlob(blob, finish)) return;
      } catch (e) {
        console.warn('Web Audio could not play the custom sound', e);
      }
      if (await playUrl(url, finish)) return;
      if (!(await playUrl(URLS.default[kind], finish))) finish();
    })();
  } catch { finish(); /* no audio support */ }
}

// 試し聴き：取引の開始の音 → 承認の音を、重ならないように順に鳴らす。
// 開始の音が実際に鳴り終わってから、少し間を置いて承認の音を鳴らす（音の長さは種類やファイルごとに違うので、時間の決め打ちはしない）。
// 鳴り終わりの知らせが来ないときのために、最長でも CUSTOM_SOUND_MAX_SECONDS + 2 秒で次へ進む。
const PREVIEW_PAUSE_MS = 250;

export function previewLiveSound(theme: LiveSoundTheme, chain: ChainKey = 'symbol'): void {
  // 「IROME チャイム」は、以前の間合い（開始の0.9秒後に承認）のまま。音の後ろのほうは余韻なので、鳴り終わりを待つと間延びする。
  if (theme === 'default') {
    playLiveSound(theme, 'started', chain);
    window.setTimeout(() => playLiveSound(theme, 'confirmed', chain), 900);
    return;
  }
  let next = false;
  let fallback = 0;
  const playConfirmed = (): void => {
    if (next) return;
    next = true;
    window.clearTimeout(fallback);
    window.setTimeout(() => playLiveSound(theme, 'confirmed', chain), PREVIEW_PAUSE_MS);
  };
  fallback = window.setTimeout(playConfirmed, (CUSTOM_SOUND_MAX_SECONDS + 2) * 1000);
  playLiveSound(theme, 'started', chain, false, playConfirmed);
}
