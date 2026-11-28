// ログイン後の「パスワード入力済み」の記録（メモリ上だけ）。
// パスワードは、プロファイルを選ぶたびに求める（WalletSelect）。起動時の画面がホーム画面のとき（前回のプロファイルへ直接入る）は、
// 開いたホーム画面の上に LoginPasswordGate がポップアップで求める。入力済みかどうかはメモリ上だけで持つので、ページを読み込み直す（=アプリを開き直す）と、また求める。
// 以前あった「ログインのたびにパスワードを求める」の設定（プロファイルごとのオン／オフ）は廃止した。
const unlocked = new Set<string>();

// このアプリを開いてから（ページを読み込んでから）新しく作った・取り込んだプロファイル。パスワードは作成時に入力したばかりなので、
// プロファイル選択で選んでも、もう一度は求めない（読み込み直すと消える）。既存のプロファイルは、これまでどおり選ぶたびに求める。
const fresh = new Set<string>();

export function markProfileFresh(profileKey: string): void {
  fresh.add(profileKey);
  unlocked.add(profileKey);
}

export function isProfileFresh(profileKey: string): boolean {
  return fresh.has(profileKey);
}

export function isLoginUnlocked(profileKey: string): boolean {
  return unlocked.has(profileKey);
}

export function markLoginUnlocked(profileKey: string): void {
  unlocked.add(profileKey);
}

// 旧設定が localStorage に残したキーの接頭辞。プロファイルを削除したときに、残りを消すために使う。
export const LOGIN_PASSWORD_KEY_PREFIX = 'kasane.loginPassword.';
