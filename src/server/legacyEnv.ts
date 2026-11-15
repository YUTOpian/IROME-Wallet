// 改名前（KASANE_）の環境変数も、当面は読む。IROME_ の同じ名前があれば、そちらを優先する。
// （サーバー専用。ブラウザのウォレット（src/ の画面側）はこのファイルを読み込まない。）
export function withLegacyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(env)) {
    if (!key.startsWith('KASANE_')) continue;
    const next = `IROME_${key.slice('KASANE_'.length)}`;
    if (out[next] === undefined) out[next] = env[key];
  }
  return out;
}
