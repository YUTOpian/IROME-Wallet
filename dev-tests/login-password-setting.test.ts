// ログインのパスワード入力済みの記録（メモリだけ）と、廃止した「ログインのたびにパスワードを求める」設定の掃除。
// 設定そのものは廃止した（loginLock.ts）ので、入力済みの記録がメモリだけであることと、旧設定が残したキーがプロファイル削除で消えることを確かめる。
// 実行: npx tsx dev-tests/login-password-setting.test.ts
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
};
const { isLoginUnlocked, markLoginUnlocked, LOGIN_PASSWORD_KEY_PREFIX } = await import('../src/lib/loginLock');
const { isPurgeKey, purgeAccountData } = await import('../src/lib/accountPurge');

let failed = 0;
function check(name: string, ok: boolean) { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }

check('not unlocked by default', !isLoginUnlocked('pk1'));
markLoginUnlocked('pk3');
check('unlocked after marking', isLoginUnlocked('pk3'));
check('other profile stays locked', !isLoginUnlocked('pk1'));
check('unlock is memory only', ![...mem.keys()].some((k) => k.includes('pk3')));
check('purge key of a removed profile', isPurgeKey(`${LOGIN_PASSWORD_KEY_PREFIX}pk1`, new Set(), new Set(['pk1'])));
check('purge key of another profile stays', !isPurgeKey(`${LOGIN_PASSWORD_KEY_PREFIX}pk2`, new Set(), new Set(['pk1'])));
mem.set(`${LOGIN_PASSWORD_KEY_PREFIX}pk1`, '1');
purgeAccountData([{ id: 'w1', profileKey: 'pk1' }], { profileRemoved: true });
check('old setting removed with the profile', !mem.has(`${LOGIN_PASSWORD_KEY_PREFIX}pk1`));
process.exit(failed === 0 ? 0 : 1);
