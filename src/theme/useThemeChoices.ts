import { useTranslation } from 'react-i18next';
import { selectActiveCustomTheme, useAppStore } from '../store/appStore';
import type { ThemeMode } from '../store/appStore';
import { isOnboardingPath } from './designScope';
import type { ChainKey } from '../lib/chain';

// The themes a person can pick from (設定 > テーマ, the start screen, the profile screen): the five built-in ones (色目 first, as it is the default; then 宵, さくら, Symbolダーク, NEMホワイト),
// then every saved カスタムテーマ by name. A choice is a plain string: 'dark' | 'light' | 'blossom' | 'tomatina' | 'irome' | 'yoi' | 'custom:<id>'.
//
// テーマの設定は2か所ある:
//   ・共通のテーマ（themeMode / customThemeId）… スタート画面・プロファイル選択画面など、プロファイルを開く前の画面。
//     プロファイルが自分のテーマを持っていなければ、プロファイルの中もこれに合わせる。
//   ・プロファイルのテーマ（profileThemes）… そのプロファイルを開いている間だけ使う。Symbol・NEM 共通のもの（キー = profileKey）と、
//     チェーンごとのもの（キー = `<profileKey>#symbol` / `<profileKey>#nem`）がある。そのチェーンを開いているときは、チェーンごとのものが先、無ければ共通のもの。
const BUILTIN: ThemeMode[] = ['irome', 'yoi', 'blossom', 'tomatina', 'dark', 'light']; // 順番: 色目（初期テーマ）、宵、さくら、トマティーナ、Symbolダーク、NEMホワイト

export function useThemeChoices(): { code: string; label: string }[] {
  const { t } = useTranslation();
  const customThemes = useAppStore((s) => s.customThemes);
  return [
    ...BUILTIN.map((code) => ({ code: code as string, label: t(`settings.theme_${code}`) })),
    ...customThemes.map((theme) => ({ code: `custom:${theme.id}`, label: theme.name || t('settings.theme_custom') })),
  ];
}

/** The common choice (start screen / profile select, and every profile without its own). */
export function useThemeChoice(): string {
  const themeMode = useAppStore((s) => s.themeMode);
  const active = useAppStore(selectActiveCustomTheme);
  if (themeMode === 'custom') return active ? `custom:${active.id}` : 'dark';
  return themeMode;
}

export function applyThemeChoice(code: string): void {
  const { setThemeMode, selectCustomTheme } = useAppStore.getState();
  if (code.startsWith('custom:')) selectCustomTheme(code.slice('custom:'.length));
  else setThemeMode(code as ThemeMode);
}

/** Which part of a profile a theme choice is for: both chains ('all') or one chain only. */
export type ProfileThemeScope = 'all' | ChainKey;

/** The key a profile's choice is saved under in `profileThemes` (see appStore.setProfileTheme). */
export function profileThemeKey(profileKey: string, scope: ProfileThemeScope = 'all'): string {
  return scope === 'all' ? profileKey : `${profileKey}#${scope}`;
}

/** The choice the open profile made for itself, for exactly this scope. '' = none (it follows the next level up, or no profile is open). */
export function useProfileThemeChoice(scope: ProfileThemeScope = 'all'): string {
  const key = useAppStore((s) => s.activeProfileKey);
  const choices = useAppStore((s) => s.profileThemes);
  const customThemes = useAppStore((s) => s.customThemes);
  const choice = key ? choices[profileThemeKey(key, scope)] : undefined;
  if (!choice) return '';
  if (choice.startsWith('custom:') && !customThemes.some((t) => `custom:${t.id}` === choice)) return '';
  return choice;
}

/** Sets the open profile's own theme for this scope. '' = follow the next level up again (the whole profile, then the common theme). */
export function applyProfileThemeChoice(code: string, scope: ProfileThemeScope = 'all'): void {
  const { activeProfileKey, setProfileTheme } = useAppStore.getState();
  if (!activeProfileKey) return;
  setProfileTheme(profileThemeKey(activeProfileKey, scope), code === '' ? null : code);
}

/** The theme a screen shows: the profile's own while a profile is open, the common one everywhere else. */
export function useEffectiveTheme(pathname: string): { mode: ThemeMode; customId: string | null } {
  const themeMode = useAppStore((s) => s.themeMode);
  const customThemeId = useAppStore((s) => s.customThemeId);
  // The theme of the open profile on the chain the app is on: that chain's own choice, else the whole profile's.
  const chain = useAppStore((s) => s.chain);
  const chainChoice = useProfileThemeChoice(chain);
  const wholeChoice = useProfileThemeChoice('all');
  const profileChoice = chainChoice || wholeChoice;
  // The start-screen group (welcome, profile select, new / import, profile settings, ...) always shows the common theme.
  if (isOnboardingPath(pathname) || profileChoice === '') return { mode: themeMode, customId: customThemeId };
  if (profileChoice.startsWith('custom:')) return { mode: 'custom', customId: profileChoice.slice('custom:'.length) };
  return { mode: profileChoice as ThemeMode, customId: customThemeId };
}
