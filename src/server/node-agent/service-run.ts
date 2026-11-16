// エージェントの常駐化の操作（サーバー専用）。使い方は service.ts の先頭を見る。
//
//   npm run node-agent-service -- install [--port 7391] [--workspace ~/irome-node] [--origin https://example.com]
//   npm run node-agent-service -- status | token [--rotate] | restart | uninstall [--purge]
import { spawnSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isElevatedWindows } from './platform';
import { installService, restartService, statusOf, tokenOf, uninstallService } from './service';
import type { ServiceHost } from './service';

const USAGE = [
  '使い方: npm run node-agent-service -- <操作>',
  '  install [--port N] [--workspace DIR] [--origin URL]   登録して起動する（--origin は何回でも）',
  '  status                                                 登録と、接続できるかを見る',
  '  token [--rotate]                                       トークンを表示する（--rotate で作り直して、起こし直す）',
  '  restart                                                再起動する',
  '  uninstall [--purge]                                    登録を外す（--purge で、設定とトークンも消す）',
].join('\n');

const die = (msg: string): never => { console.error(`[node-agent-service] ${msg}`); process.exit(1); };

const probe: ServiceHost['probe'] = async (port, token) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/files`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(3000) });
    return res.status === 401 ? 'unauthorized' : res.ok ? 'ok' : 'down';
  } catch { return 'down'; }
};

const host: ServiceHost = {
  plat: process.platform,
  home: homedir(),
  env: process.env,
  uid: process.getuid?.() ?? null,
  user: (() => { try { return userInfo().username; } catch { return null; } })(),
  repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
  nodeExe: process.execPath,
  exec: (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' };
  },
  probe,
  out: (t) => process.stdout.write(t),
};

const [op, ...rest] = process.argv.slice(2);
if (host.uid === 0 && process.env.IROME_NODE_AGENT_ALLOW_ROOT !== '1') die('root では実行しません。一般ユーザーで実行してください。');
if (host.plat === 'win32' && process.env.IROME_NODE_AGENT_ALLOW_ROOT !== '1' && isElevatedWindows()) die('管理者として実行されています。普通のターミナルで実行してください。');

const flags = (known: Record<string, 'bool' | 'value' | 'multi'>) => {
  const out: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const kind = known[a];
    if (kind === undefined) die(`知らない引数です: ${a.slice(0, 60)}\n${USAGE}`);
    if (kind === 'bool') { out[a] = true; continue; }
    const v = rest[++i];
    if (v === undefined || v.startsWith('--')) die(`${a} には値が要ります。`);
    if (kind === 'multi') (out[a] = (out[a] as string[] | undefined) ?? []).push(v); else out[a] = v;
  }
  return out;
};

const done = (r: { ok: boolean; message?: string }) => { if (!r.ok) die(r.message ?? '失敗しました。'); };

switch (op) {
  case 'install': {
    const f = flags({ '--port': 'value', '--workspace': 'value', '--origin': 'multi' });
    const port = f['--port'] === undefined ? undefined : Number(f['--port']);
    const ws = f['--workspace'] as string | undefined;
    done(installService(host, {
      ...(port !== undefined ? { port } : {}),
      ...(ws !== undefined ? { workspace: ws.replace(/^~(?=$|[\\/])/, homedir()) } : {}),
      ...(f['--origin'] !== undefined ? { origins: f['--origin'] as string[] } : {}),
    }));
    break;
  }
  case 'uninstall': { const f = flags({ '--purge': 'bool' }); done(uninstallService(host, f['--purge'] === true)); break; }
  case 'restart': { flags({}); done(restartService(host)); process.stdout.write('再起動しました。\n'); break; }
  case 'token': {
    const f = flags({ '--rotate': 'bool' });
    const r = tokenOf(host, f['--rotate'] === true);
    if (!r.ok) die(r.message);
    else {
      // 標準出力には、トークンだけを出す（`| clip` などに渡せるように）。説明は標準エラーへ。
      if (f['--rotate'] === true) console.error(r.restarted ? '作り直して、再起動しました。ウォレットには、新しいトークンを入れ直してください。' : '作り直しました（登録はされていないので、起動はしていません）。');
      process.stdout.write(`${r.token}\n`);
    }
    break;
  }
  case 'status': {
    flags({});
    const s = await statusOf(host);
    console.log(`登録     : ${s.registered ? `あり（${s.detail}）` : 'なし（install で登録）'}`);
    console.log(`設定     : ${s.configOk ? `読めた（ポート ${s.port}）` : '読めない（install で作り直し）'}`);
    console.log(`トークン : ${s.tokenOk ? `読めた（${s.tokenFile}）` : '読めない（install か token --rotate で作り直し）'}`);
    console.log(`接続     : ${s.reachable === 'ok' ? `繋がりました（http://127.0.0.1:${s.port}）` : s.reachable === 'unauthorized' ? '応答はあるが、トークンが合いません（別のエージェントが動いていませんか）' : '繋がりません（動いていません）'}`);
    break;
  }
  default:
    console.error(USAGE);
    process.exit(op === undefined || op === '--help' || op === '-h' ? 0 : 1);
}
