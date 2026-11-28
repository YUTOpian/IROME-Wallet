// ノード構築エージェント: Docker Engine を入れる手順（Linux の Ubuntu / Debian 系だけ。Docker 公式の apt リポジトリの方法）。
//
// これは、このエージェントで **sudo を使う、ただ 1 つの手順**。使う範囲は、次のとおり絞る。
// - sudo を起動するのは、`irome install docker` のときの 1 回だけ（パスワードも 1 回）。画面から打った `sudo …` は、これまでどおり通さない（許可リストに無い）。
// - sudo に渡すのは、このファイルの固定のスクリプト（SUDO_SCRIPT）と、確かめ済みの 5 つの値（ディストリ名・コードネーム・CPU・ユーザー名・公式の公開鍵）だけ。
//   画面から入る文字は、1 文字も入らない。5 つの値は、エージェントで形を確かめ、スクリプトの中でも、もう一度確かめる（どちらも、シェルの式としては評価しない。位置引数として渡すだけ）。
// - sudo の実行ファイルは `/usr/bin/sudo`（なければ `/bin/sudo`）の絶対パスだけ。PATH の先頭に tools/ のものが足されているので、PATH 任せにすると、
//   tools/node_modules/.bin に紛れた `sudo` という名前のものに、パスワードを渡してしまうおそれがある。スクリプトの中も、PATH を固定してから始める。
// - 鍵（公開鍵）は、download.docker.com から https だけで取る（ほかのホストには繋がない）。root の一時フォルダに書き、公式の指紋
//   （9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88）と、鍵が 1 つだけであることを、`gpg` で確かめてから /etc/apt/keyrings に置く。合わなければ、何も足さずに止まる。
// - root で触るのは、次の場所と操作だけ: apt-get（ca-certificates・gnupg と、Docker のパッケージ 5 つ）・/etc/apt/keyrings/docker.asc・/etc/apt/sources.list.d/docker.sources・
//   systemctl enable --now docker・usermod -aG docker <いまのユーザー>。ほかのファイル・パッケージは、消さず、変えない（元から入っている docker.io などがあれば、apt が断る）。
// - すでに docker が使えるときは、sudo を起動せずに終わる。
//
// 注意（画面でも伝える）: docker グループに入れると、そのユーザーは、docker 経由で root と同じことができる。ノードのコマンド（`docker compose …`）を、
// sudo なしで動かすために必要なので入れるが、それを望まないときは、この手順を使わず、公式の手順で入れる（rootless Docker など）。
// グループの変更は、ログインし直したあとに効く。エージェントも、ログインし直してから起動し直す。
//
// Mac は、Docker Desktop（Docker.app）を、sudo なしで置く（下の「Mac」）。
// Windows は、Docker Desktop のインストーラーが管理者権限（と WSL2 / 仮想化の設定）を要する。このエージェントは昇格しない決まりなので、
// 「Docker 公式から取得 → Authenticode 署名の確認 → Windows 自身の確認画面（UAC）でご自身が「はい」を押す」の形にする（下の「Windows」）。エージェントは、昇格しない。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, win32 } from 'node:path';
import { download, downloadToFile, probeCmd, sweepTmp, toolsPath } from './provision';
import type { Step } from './agent';

/** Docker 公式の apt 鍵（Docker Release (CE deb)）の指紋。https://docs.docker.com/engine/install/ubuntu/ のとおり。 */
export const DOCKER_KEY_FINGERPRINT = '9DC858229FC7DD38854AE2D88D81803C0EBFCD88';
/** 鍵を取りに行ってよいホスト（これだけ。Node.js・Python の取得先には足さない）。 */
export const DOCKER_KEY_HOSTS: readonly string[] = ['download.docker.com'];
/** 入れるパッケージ（これだけ。公式の手順と同じ 5 つ）。 */
export const DOCKER_PACKAGES: readonly string[] = ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin'];
export const DOCKER_ARCHS: readonly string[] = ['amd64', 'arm64', 'armhf', 'ppc64el', 's390x'];
export type DockerBase = 'ubuntu' | 'debian';

const MAX_KEY_BYTES = 32 * 1024;
const USER_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;
const CODENAME_RE = /^[a-z0-9]{2,30}$/;

/**
 * sudo で動かす、固定のスクリプト（POSIX sh）。位置引数: $1 = ubuntu|debian、$2 = コードネーム、$3 = CPU（dpkg の名前）、$4 = ユーザー名、$5 = 公式の公開鍵（ASCII）。
 * `set -eu`: 1 つでも失敗したら、そこで止まる。値は、ここでも形を確かめる。
 */
export const SUDO_SCRIPT = String.raw`set -eu
umask 022
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
DEBIAN_FRONTEND=noninteractive
export DEBIAN_FRONTEND
BASE="$1"
CODENAME="$2"
ARCH="$3"
DUSER="$4"
KEY="$5"
case "$BASE" in ubuntu|debian) ;; *) echo "bad base" >&2; exit 2 ;; esac
case "$CODENAME" in ''|*[!a-z0-9]*) echo "bad codename" >&2; exit 2 ;; esac
case "$ARCH" in amd64|arm64|armhf|ppc64el|s390x) ;; *) echo "bad arch" >&2; exit 2 ;; esac
case "$DUSER" in ''|-*|root|*[!A-Za-z0-9._-]*) echo "bad user" >&2; exit 2 ;; esac
id -u "$DUSER" >/dev/null
echo "== [1/6] 前準備（ca-certificates・gnupg）=="
apt-get update
apt-get install -y --no-install-recommends ca-certificates gnupg
echo "== [2/6] Docker 公式の鍵の指紋を確かめて、置きます =="
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
printf '%s\n' "$KEY" > "$TMPD/docker.asc"
mkdir -m 700 "$TMPD/gnupg"
INFO="$(GNUPGHOME="$TMPD/gnupg" gpg --batch --no-tty --with-colons --show-keys --fingerprint "$TMPD/docker.asc")"
PUBS="$(printf '%s\n' "$INFO" | grep -c '^pub:' || true)"
FPR="$(printf '%s\n' "$INFO" | awk -F: '$1=="fpr"{print $10; exit}')"
if [ "$PUBS" != "1" ] || [ "$FPR" != "${DOCKER_KEY_FINGERPRINT}" ]; then
  echo "鍵の指紋が、Docker 公式のものと一致しません。何も足さずに止まります（鍵の数: $PUBS / 指紋: $FPR）" >&2
  exit 3
fi
echo "指紋が一致しました（9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88）。"
install -m 0755 -d /etc/apt/keyrings
install -m 0644 "$TMPD/docker.asc" /etc/apt/keyrings/docker.asc
echo "== [3/6] apt のリポジトリ（download.docker.com）を足します =="
printf '%s\n' "Types: deb" "URIs: https://download.docker.com/linux/$BASE" "Suites: $CODENAME" "Components: stable" "Architectures: $ARCH" "Signed-By: /etc/apt/keyrings/docker.asc" > /etc/apt/sources.list.d/docker.sources
echo "== [4/6] Docker Engine を入れます =="
apt-get update
apt-get install -y ${DOCKER_PACKAGES.join(' ')}
echo "== [5/6] Docker を起動します =="
if [ -d /run/systemd/system ]; then
  systemctl enable --now docker
else
  echo "systemd が無い環境です。dockerd は、自分で起動してください。"
fi
echo "== [6/6] $DUSER を docker グループに入れます =="
usermod -aG docker "$DUSER"
echo "root の作業は、ここまでです。"
`;

export interface DockerPlan { base: DockerBase; codename: string; arch: string; user: string; derived: boolean }

/** /etc/os-release から、Docker 公式のリポジトリの種類（ubuntu / debian）とコードネームを決める。派生（Linux Mint など）は、元のものに読み替える。決められなければ null。 */
export function parseOsRelease(text: string): { base: DockerBase; codename: string; derived: boolean } | null {
  const kv: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) kv[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  const ids = [kv.ID ?? '', ...(kv.ID_LIKE ?? '').split(/\s+/)].filter(Boolean);
  const base = ids.find((i): i is DockerBase => i === 'ubuntu' || i === 'debian');
  if (!base) return null;
  const codename = base === 'ubuntu' ? (kv.UBUNTU_CODENAME || kv.VERSION_CODENAME || '') : (kv.VERSION_CODENAME || '');
  if (!CODENAME_RE.test(codename)) return null;
  return { base, codename, derived: kv.ID !== base };
}

/** 鍵として受け取ってよい形か（公式の ASCII の公開鍵 1 つ。決まった文字だけ・大きさの上限つき）。通れば、改行を LF にそろえた本文を返す。 */
export function validateKeyText(raw: string): string | null {
  if (Buffer.byteLength(raw, 'utf8') > MAX_KEY_BYTES) return null;
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!/^[\x20-\x7e\n]+$/.test(text)) return null;
  if (!text.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----\n') || !text.endsWith('-----END PGP PUBLIC KEY BLOCK-----')) return null;
  if ((text.match(/-----BEGIN PGP/g) ?? []).length !== 1) return null;
  return text;
}

/** sudo に渡す引数。固定のスクリプトと、確かめ済みの 5 つの値だけ（これ以外は、何も足さない）。 */
export function buildSudoArgs(plan: DockerPlan, key: string): string[] {
  return ['--', '/bin/sh', '-c', SUDO_SCRIPT, 'irome-docker-install', plan.base, plan.codename, plan.arch, plan.user, key];
}

export const DOCKER_GUIDE_URL = 'https://docs.docker.com/engine/install/';

export interface DockerInstallEnv {
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  /** 試験用の差し替え（省略は、この PC の実際の値） */
  hooks?: {
    osRelease?: () => string | null;
    sudoPath?: () => string | null;
    dpkgArch?: () => Promise<string | null>;
    dockerVersion?: () => Promise<string | null>;
    dockerCompose?: () => Promise<string | null>;
    dockerInfo?: () => Promise<string | null>;
    userName?: () => string;
    uid?: () => number | undefined;
    /** Mac: CPU（process.arch の値） */
    arch?: () => string;
    /** Mac: すでにある Docker.app の場所（あるものだけ）。Windows: すでにある Docker Desktop.exe の場所（あるものだけ） */
    appPaths?: () => string[];
    /** Mac: Docker.app を置く先のフォルダ（/Applications か ~/Applications） */
    applicationsDir?: () => string;
    /** Mac: hdiutil・codesign・spctl・ditto・open を動かす（絶対パスと、固定の引数だけが渡る）。Windows: PowerShell（絶対パス・固定のスクリプト）を動かす。env は Windows だけで、ファイルの場所を渡す */
    run?: (cmd: string, args: string[], timeoutMs?: number, env?: Record<string, string>) => Promise<RunResult>;
  };
}

const defaultSudo = (): string | null => ['/usr/bin/sudo', '/bin/sudo'].find((p) => existsSync(p)) ?? null;
const defaultOsRelease = (): string | null => {
  for (const p of ['/etc/os-release', '/usr/lib/os-release']) {
    try { return readFileSync(p, 'utf8'); } catch { /* 次へ */ }
  }
  return null;
};

/** `irome install docker` の手順。確認 → 鍵の取得 → sudo（1 回）→ 確認。 */
export function dockerInstallSteps(ws: string, env: DockerInstallEnv = {}): Step[] {
  const plat = env.platform ?? process.platform;
  if (plat === 'darwin') return dockerInstallStepsMac(ws, env);
  if (plat === 'win32') return dockerInstallStepsWin(ws, env);
  const h = env.hooks ?? {};
  const sudo = (h.sudoPath ?? defaultSudo)();
  const state: { plan?: DockerPlan; key?: string; skip?: boolean } = {};

  const check: Step = {
    label: '環境を確かめます（Docker の有無・OS・sudo）', cmd: '', args: [], cwd: ws,
    run: async (out) => {
      if (plat !== 'linux') {
        out(`この OS（${plat}）では、画面から Docker を入れられません。${DOCKER_GUIDE_URL} を見てください。\n`);
        return 1;
      }
      const uid = (h.uid ?? (() => process.getuid?.()))();
      if (uid === 0) { out('root で動いているので、入れません（このエージェントは、一般ユーザーで動かす決まりです）。\n'); return 1; }
      const have = await (h.dockerVersion ?? (() => probeCmd('docker', ['--version'])))();
      if (have) {
        state.skip = true;
        out(`Docker は、もう入っています（${have}）。sudo は使わずに、終わります。\n`);
        return 0;
      }
      const osr = parseOsRelease((h.osRelease ?? defaultOsRelease)() ?? '');
      if (!osr) {
        out(`この画面から入れられるのは、Ubuntu・Debian 系の Linux だけです（コードネームが分からない Debian の testing / unstable なども、入れません）。\n${DOCKER_GUIDE_URL} の、お使いのディストリの手順で入れてから、「更新」を押してください。\n`);
        return 1;
      }
      if (!sudo) { out('sudo（/usr/bin/sudo）が見つかりません。sudo を使える状態にするか、公式の手順で入れてください。\n'); return 1; }
      const arch = await (h.dpkgArch ?? (() => probeCmd('/usr/bin/dpkg', ['--print-architecture'])))();
      if (!arch || !DOCKER_ARCHS.includes(arch.trim())) { out(`この CPU（${arch ?? '不明'}）向けの Docker の apt パッケージを、この画面からは入れられません。\n${DOCKER_GUIDE_URL}\n`); return 1; }
      let user = '';
      try { user = (h.userName ?? (() => userInfo().username))(); } catch { /* 下で断る */ }
      if (!USER_RE.test(user) || user === 'root') { out(`ユーザー名（${user || '不明'}）を、docker グループに入れる対象として確かめられません。\n`); return 1; }
      state.plan = { base: osr.base, codename: osr.codename, arch: arch.trim(), user, derived: osr.derived };
      out(`OS: ${osr.base} ${osr.codename}${osr.derived ? '（派生のディストリを、元の ' + osr.base + ' として扱います。Docker 公式の対応は Ubuntu・Debian です）' : ''} / CPU: ${arch.trim()} / ユーザー: ${user}\n`);
      out('\nこのあと sudo で 1 回だけ、次のことをします（パスワードを 1 回聞かれます）:\n');
      out('  1. apt-get で、ca-certificates と gnupg を入れる（無ければ）\n');
      out(`  2. Docker 公式の鍵を、指紋（${DOCKER_KEY_FINGERPRINT}）と、鍵が 1 つだけであることを確かめてから、/etc/apt/keyrings/docker.asc に置く\n`);
      out('  3. /etc/apt/sources.list.d/docker.sources に、download.docker.com のリポジトリを書く\n');
      out(`  4. apt-get で、${DOCKER_PACKAGES.join('・')} を入れる\n`);
      out('  5. systemctl enable --now docker で、Docker を起動する\n');
      out(`  6. usermod -aG docker ${user} で、docker グループに入れる（そのユーザーは、docker 経由で root と同じことができるようになります）\n`);
      out('これ以外のファイル・パッケージには、触りません。\n');
      return 0;
    },
  };

  const fetchKey: Step = {
    label: 'Docker 公式の鍵を取得します（download.docker.com だけ）', cmd: '', args: [], cwd: ws,
    run: async (out, ctl) => {
      if (state.skip) return 0;
      const plan = state.plan;
      if (!plan) return 1;
      try {
        const url = `https://download.docker.com/linux/${plan.base}/gpg`;
        out(`${url}\n`);
        const data = await download(url, { ws, out, stopped: ctl.stopped, fetchImpl: env.fetch, allowedHosts: DOCKER_KEY_HOSTS }, MAX_KEY_BYTES);
        const key = validateKeyText(data.toString('utf8'));
        if (!key) { out('取得したものが、公開鍵の形ではありません。入れません。\n'); return 1; }
        state.key = key;
        out('鍵を取得しました（指紋は、sudo の中で、公式のものと照らします）。\n');
        return 0;
      } catch (e) {
        out(`鍵を取得できませんでした: ${(e as Error).message}\n`);
        return 1;
      }
    },
  };

  const root: Step = {
    label: '管理者権限（sudo）で、決まった手順を 1 回だけ実行します。パスワードを聞かれたら、下の入力欄に入れて Enter',
    cmd: sudo ?? '/usr/bin/sudo', args: [], cwd: ws, pty: true,
    prepare: async (out) => {
      if (state.skip) return 'skip';
      if (!state.plan || !state.key || !sudo) return null;
      out('（この画面から打ったものではなく、エージェントが決めた手順だけを、sudo で動かします）\n');
      return buildSudoArgs(state.plan, state.key);
    },
  };

  const verify: Step = {
    label: '入ったか確認します', cmd: '', args: [], cwd: ws,
    run: async (out) => {
      if (state.skip) return 0;
      const v = await (h.dockerVersion ?? (() => probeCmd('docker', ['--version'])))();
      if (!v) { out('docker が見つかりません。上の出力を見てください。\n'); return 1; }
      out(`${v}\n`);
      out(`${(await (h.dockerCompose ?? (() => probeCmd('docker', ['compose', 'version'])))()) ?? 'docker compose が見つかりません。'}\n`);
      const info = await (h.dockerInfo ?? (() => probeCmd('docker', ['info'])))();
      out(info === null
        ? '\nこの画面（エージェント）からは、まだ docker のデーモンに繋げません。docker グループへの追加は、ログインし直したあとに効きます。\n一度ログアウトして、ログインし直してから、エージェントを起動し直してください（sudo は、もう使いません）。\n'
        : '\nDocker のデーモンに繋がりました。\n');
      return 0;
    },
  };

  return [check, fetchKey, root, verify];
}


// ======================== Mac（Docker Desktop。sudo は使わない） ========================

/** Docker Desktop（Mac）を取りに行ってよいホスト（これだけ。Node.js・Python・Linux の鍵の取得先には足さない）。 */
export const DOCKER_DESKTOP_HOSTS: readonly string[] = ['desktop.docker.com'];
/** Docker Desktop の開発元（Docker Inc）の Apple の Team ID。署名の確認で、これと一致しなければ置かない。 */
export const DOCKER_DESKTOP_TEAM_ID = '9BNSXJN65R';
/** Docker.app のバンドル識別子。 */
export const DOCKER_DESKTOP_BUNDLE_ID = 'com.docker.docker';
/** ダウンロードの上限（Docker.dmg は 1 GB 前後。倍の余裕を見る）。 */
export const DOCKER_DESKTOP_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const DOCKER_DESKTOP_GUIDE_URL = 'https://docs.docker.com/desktop/setup/install/mac-install/';

/** Mac で動かす外部コマンド（絶対パス。PATH 任せにしない）。 */
export const MAC_BIN = {
  hdiutil: '/usr/bin/hdiutil',
  codesign: '/usr/bin/codesign',
  spctl: '/usr/sbin/spctl',
  ditto: '/usr/bin/ditto',
  open: '/usr/bin/open',
} as const;

/** process.arch から、Docker Desktop の配布のフォルダ名へ。Apple シリコン = arm64、Intel = amd64。それ以外は null。 */
export function dockerDesktopUrl(nodeArch: string): string | null {
  const a = nodeArch === 'arm64' ? 'arm64' : nodeArch === 'x64' ? 'amd64' : null;
  return a ? `https://desktop.docker.com/mac/main/${a}/Docker.dmg` : null;
}

export interface RunResult { code: number | null; text: string }

/** 固定の引数で外部コマンドを動かし、終了コードと出力（標準出力・標準エラー）を返す。シェルは通さない。PATH も固定。 */
export function runFixed(cmd: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((done) => {
    let text = '';
    try {
      const c = spawn(cmd, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir(), LC_ALL: 'C' } });
      const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
      const add = (d: Buffer) => { if (text.length < 65_536) text += d.toString('utf8'); };
      c.stdout?.on('data', add);
      c.stderr?.on('data', add);
      c.on('error', (e) => { clearTimeout(t); done({ code: null, text: e.message }); });
      c.on('close', (code) => { clearTimeout(t); done({ code, text: text.trim() }); });
    } catch (e) { done({ code: null, text: (e as Error).message }); }
  });
}

/** `codesign -dv --verbose=2` の出力から、識別子と Team ID を読む。どちらも、ちょうど 1 つあるときだけ値を返す（複数・無しは null）。 */
export function parseCodesignInfo(text: string): { identifier: string | null; teamId: string | null } {
  const pick = (key: string): string | null => {
    const vals = text.split('\n').map((l) => new RegExp(`^${key}=(.+)$`).exec(l.trim())).filter((m): m is RegExpExecArray => m !== null).map((m) => m[1]);
    return vals.length === 1 ? vals[0] : null;
  };
  return { identifier: pick('Identifier'), teamId: pick('TeamIdentifier') };
}

const defaultAppPaths = (): string[] => ['/Applications/Docker.app', join(homedir(), 'Applications', 'Docker.app')].filter((p) => existsSync(p));

/** Docker.app を置く先: /Applications に書き込めればそこ（Mac の管理者ユーザーは、パスワードなしで書ける）。だめなら ~/Applications（無ければ作る）。 */
const defaultApplicationsDir = (): string => {
  try { accessSync('/Applications', constants.W_OK); return '/Applications'; } catch { /* 次へ */ }
  const d = join(homedir(), 'Applications');
  mkdirSync(d, { recursive: true });
  return d;
};

const tail = (text: string, n = 600): string => (text.length > n ? '…' + text.slice(-n) : text);

/** Docker.app の署名を確かめる。full: 開発元・識別子・Gatekeeper（公証）まで。false は、壊れていないか（コピーの確認）だけ。 */
export async function verifyDockerApp(app: string, out: (t: string) => void, run: NonNullable<DockerInstallEnv['hooks']>['run'], full: boolean): Promise<boolean> {
  const exec = run ?? runFixed;
  const v = await exec(MAC_BIN.codesign, ['--verify', '--deep', '--strict', app], 600_000);
  if (v.code !== 0) { out(`署名の検証に失敗しました（壊れているか、書き換えられています）。入れません。\n${tail(v.text)}\n`); return false; }
  if (!full) return true;
  const d = await exec(MAC_BIN.codesign, ['-dv', '--verbose=2', app], 120_000);
  const info = parseCodesignInfo(d.text);
  if (d.code !== 0 || info.teamId !== DOCKER_DESKTOP_TEAM_ID || info.identifier !== DOCKER_DESKTOP_BUNDLE_ID) {
    out(`開発元が Docker Inc のものと一致しません（Team ID: ${info.teamId ?? '不明'} / 識別子: ${info.identifier ?? '不明'}。期待: ${DOCKER_DESKTOP_TEAM_ID} / ${DOCKER_DESKTOP_BUNDLE_ID}）。何も置かずに止まります。\n`);
    return false;
  }
  const g = await exec(MAC_BIN.spctl, ['--assess', '--type', 'execute', '-vv', app], 300_000);
  if (g.code !== 0) { out(`macOS の Gatekeeper（Apple の公証）の確認に通りませんでした。入れません。\n${tail(g.text)}\n`); return false; }
  out(`署名を確かめました（開発元: Docker Inc・Team ID ${DOCKER_DESKTOP_TEAM_ID}・Apple の公証）。\n`);
  return true;
}

/** Mac の `irome install docker`: 確認 → 取得 → 署名の確認と配置 → 起動 → 確認。sudo は使わない。 */
export function dockerInstallStepsMac(ws: string, env: DockerInstallEnv = {}): Step[] {
  const h = env.hooks ?? {};
  const run = h.run ?? runFixed;
  const state: { url?: string; destDir?: string; tmp?: string; dmg?: string; app?: string; skip?: boolean; launchOnly?: boolean } = {};
  const dockerVersion = (): Promise<string | null> => (h.dockerVersion ?? (() => probeCmd(state.app ? join(state.app, 'Contents', 'Resources', 'bin', 'docker') : 'docker', ['--version'])))();

  const check: Step = {
    label: '環境を確かめます（Docker の有無・CPU・置き場所）', cmd: '', args: [], cwd: ws,
    run: async (out) => {
      const uid = (h.uid ?? (() => process.getuid?.()))();
      if (uid === 0) { out('root で動いているので、入れません（このエージェントは、一般ユーザーで動かす決まりです）。\n'); return 1; }
      const have = await (h.dockerVersion ?? (() => probeCmd('docker', ['--version'])))();
      if (have) {
        state.skip = true;
        out(`Docker は、もう入っています（${have}）。何もせずに、終わります。\nまだ動いていないときは、Docker Desktop を起動してください。\n`);
        return 0;
      }
      const existing = (h.appPaths ?? defaultAppPaths)();
      if (existing.length > 0) {
        state.launchOnly = true;
        state.app = existing[0];
        out(`Docker Desktop は、もう入っています（${existing[0]}）。上書きせずに、起動だけします。\n`);
        return 0;
      }
      const arch = (h.arch ?? (() => process.arch))();
      const url = dockerDesktopUrl(arch);
      if (!url) { out(`この CPU（${arch}）向けの Docker Desktop を、この画面からは入れられません。\n${DOCKER_DESKTOP_GUIDE_URL}\n`); return 1; }
      let destDir = '';
      try { destDir = (h.applicationsDir ?? defaultApplicationsDir)(); } catch (e) { out(`Docker.app を置く場所を用意できませんでした（${(e as Error).message}）。\n`); return 1; }
      state.url = url;
      state.destDir = destDir;
      out(`CPU: ${arch === 'arm64' ? 'Apple シリコン（arm64）' : 'Intel（x86_64）'} / 置き場所: ${destDir}/Docker.app\n`);
      out('\nこのあと、管理者権限（sudo・パスワード）は使わずに、次のことをします:\n');
      out(`  1. ${url} から、Docker Desktop のディスクイメージ（約 1 GB）を、作業場所の tools/ の一時フォルダに取得する（desktop.docker.com だけに繋ぐ）\n`);
      out(`  2. ディスクイメージを読み取り専用で開き、中の Docker.app の署名を確かめる（開発元 Docker Inc・Team ID ${DOCKER_DESKTOP_TEAM_ID}・Apple の公証）。合わなければ、何も置かずに止まる\n`);
      out(`  3. Docker.app を ${destDir} にコピーする（すでにあれば、上書きしない）\n`);
      out('  4. ディスクイメージを閉じて、一時フォルダを消し、Docker Desktop を起動する\n');
      out('これ以外のファイルには、触りません。初回の起動では、Docker 自身が使用許諾と、macOS のパスワードの画面を出します（そこは、ご自身で操作してください）。\n');
      return 0;
    },
  };

  const fetchDmg: Step = {
    label: 'Docker Desktop を取得します（desktop.docker.com だけ。1 GB 前後あるので、時間がかかります）', cmd: '', args: [], cwd: ws,
    run: async (out, ctl) => {
      if (state.skip || state.launchOnly) return 0;
      if (!state.url) return 1;
      sweepTmp(ws);
      mkdirSync(toolsPath(ws), { recursive: true });
      const tmp = mkdtempSync(join(toolsPath(ws), '.docker-tmp-'));
      state.tmp = tmp;
      const dmg = join(tmp, 'Docker.dmg');
      try {
        out(`${state.url}\n`);
        let next = 100 * 1024 * 1024;
        const r = await downloadToFile(state.url, dmg, { ws, out, stopped: ctl.stopped, fetchImpl: env.fetch, allowedHosts: DOCKER_DESKTOP_HOSTS, idleTimeoutMs: 120_000 }, DOCKER_DESKTOP_MAX_BYTES, (n) => {
          if (n >= next) { out(`  ${Math.round(n / 1024 / 1024)} MB…\n`); next = n + 100 * 1024 * 1024; }
        });
        out(`  ${(r.bytes / 1024 / 1024).toFixed(0)} MB を取得しました。\n`);
        state.dmg = dmg;
        return 0;
      } catch (e) {
        out(`取得できませんでした: ${(e as Error).message}\n`);
        rmSync(tmp, { recursive: true, force: true });
        state.tmp = undefined;
        return 1;
      }
    },
  };

  const install: Step = {
    label: 'ディスクイメージを開き、Docker 公式の署名を確かめて、Docker.app を置きます', cmd: '', args: [], cwd: ws,
    run: async (out, ctl) => {
      if (state.skip || state.launchOnly) return 0;
      const { tmp, dmg, destDir } = state;
      if (!tmp || !dmg || !destDir) return 1;
      const mnt = join(tmp, 'mnt');
      mkdirSync(mnt);
      let attached = false;
      let detached = true;
      try {
        if (ctl.stopped()) { out('停止しました。\n'); return 130; }
        const at = await run(MAC_BIN.hdiutil, ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dmg], 600_000);
        if (at.code !== 0) { out(`ディスクイメージを開けませんでした。\n${tail(at.text)}\n`); return 1; }
        attached = true;
        detached = false;
        const src = join(mnt, 'Docker.app');
        if (!existsSync(src)) { out('ディスクイメージの中に、Docker.app がありません。入れません。\n'); return 1; }
        if (!(await verifyDockerApp(src, out, run, true))) return 1;
        const target = join(destDir, 'Docker.app');
        if (existsSync(target)) { state.app = target; out(`${target} が、もうあります。上書きしません。\n`); return 0; }
        if (ctl.stopped()) { out('停止しました。\n'); return 130; }
        // 置く途中で止まっても、Docker.app の名前の壊れたものが残らないように、別の名前にコピーしてから、名前を付け替える
        const part = join(destDir, '.Docker-irome-tmp.app');
        rmSync(part, { recursive: true, force: true });
        out(`コピーします: ${target}\n`);
        const cp = await run(MAC_BIN.ditto, [src, part], 900_000);
        if (cp.code !== 0) { rmSync(part, { recursive: true, force: true }); out(`コピーできませんでした。\n${tail(cp.text)}\n`); return 1; }
        if (!(await verifyDockerApp(part, out, run, false))) { rmSync(part, { recursive: true, force: true }); return 1; }
        renameSync(part, target);
        state.app = target;
        out(`入れました: ${target}\n`);
        return 0;
      } catch (e) {
        out(`入れられませんでした: ${(e as Error).message}\n`);
        return 1;
      } finally {
        if (attached) {
          let d = await run(MAC_BIN.hdiutil, ['detach', mnt], 120_000);
          if (d.code !== 0) d = await run(MAC_BIN.hdiutil, ['detach', '-force', mnt], 120_000);
          detached = d.code === 0;
          if (!detached) out(`ディスクイメージを閉じられませんでした（${mnt}）。Finder で取り出してから、tools/ の ${tmp.split('/').pop()} を消してください。\n`);
        }
        // 閉じられていないときは、読み取り専用で開いたままなので、触らない
        if (detached) rmSync(tmp, { recursive: true, force: true });
      }
    },
  };

  const launch: Step = {
    label: 'Docker Desktop を起動します', cmd: '', args: [], cwd: ws,
    run: async (out) => {
      if (state.skip) return 0;
      const app = state.app;
      if (!app) return 1;
      const r = await run(MAC_BIN.open, [app], 60_000);
      if (r.code !== 0) { out(`起動できませんでした。Launchpad か Finder から、Docker を開いてください。\n${tail(r.text)}\n`); return 1; }
      out('Docker Desktop を起動しました。\n初回は、Docker の使用許諾の画面と、macOS のパスワードの入力（Docker Desktop が必要な設定を行うため）が出ます。画面の指示に従ってください。このエージェントは、パスワードには触れません。\n');
      return 0;
    },
  };

  const verify: Step = {
    label: '入ったか確認します', cmd: '', args: [], cwd: ws,
    run: async (out) => {
      if (state.skip) return 0;
      const v = await dockerVersion();
      if (!v) { out('docker コマンドを、まだ確認できません。Docker Desktop の初回の起動（使用許諾・パスワード）が終わるまで、お待ちください。終わったら「更新」を押してください。\n'); return 0; }
      out(`${v}\n`);
      const info = await (h.dockerInfo ?? (() => probeCmd(state.app ? join(state.app, 'Contents', 'Resources', 'bin', 'docker') : 'docker', ['info'])))();
      out(info === null
        ? '\nDocker のデーモンは、まだ動いていません。Docker Desktop が起動しきる（メニューバーの Docker のアイコンが「running」になる）まで待ってから、「更新」を押してください。\n'
        : '\nDocker のデーモンに繋がりました。\n');
      return 0;
    },
  };

  return [check, fetchDmg, install, launch, verify];
}


// ======================== Windows（Docker Desktop。エージェントは昇格しない。UAC は、ご自身が押す） ========================
//
// 流れ: ① Docker 公式（desktop.docker.com）から `Docker Desktop Installer.exe` を、作業場所の tools/ の一時フォルダに取得する
//       ② Windows の Authenticode 署名を確かめる（署名が有効で、発行元が Docker Inc のときだけ先へ進む）
//       ③ `install --quiet` で起動する。インストーラーは管理者権限を要するので、Windows が、ご自身の画面に確認（UAC）を出す。ご自身が「はい」を押す
//       ④ 一時フォルダを消し、入ったかを確かめる
// このエージェント自身は、昇格しない（昇格して動いていたら、そもそも起動しない）。UAC で「いいえ」なら、何も入らずに終わる。
// PowerShell は、絶対パス（System32）・固定のスクリプト（-EncodedCommand）だけ。ファイルの場所は、環境変数で渡す（スクリプトの文字としては評価しない）。

/** 発行元（署名の証明書の名前）。署名の確認で、これと一致しなければ、実行しない。 */
export const DOCKER_DESKTOP_WIN_SIGNERS: readonly string[] = ['Docker Inc', 'Docker, Inc.'];
/** インストーラーへ渡す引数（これだけ）。 */
export const DOCKER_DESKTOP_WIN_ARGS: readonly string[] = ['install', '--quiet'];
export const DOCKER_DESKTOP_WIN_GUIDE_URL = 'https://docs.docker.com/desktop/setup/install/windows-install/';
/** ダウンロードの上限（Docker Desktop Installer.exe は数百 MB。倍以上の余裕を見る）。 */
export const DOCKER_DESKTOP_WIN_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** UAC で「いいえ」（ERROR_CANCELLED）。 */
const WIN_UAC_CANCELED = 1223;
/** 再起動が必要だが、入った（ERROR_SUCCESS_REBOOT_REQUIRED）。 */
const WIN_REBOOT_REQUIRED = 3010;
/** インストールに待つ上限（WSL 2 の準備を含む）。 */
const WIN_INSTALL_TIMEOUT_MS = 30 * 60_000;

/** process.arch から、Docker Desktop（Windows）の配布のフォルダ名へ。x64 = amd64、arm64 = arm64。それ以外は null。 */
export function dockerDesktopWinUrl(nodeArch: string): string | null {
  const a = nodeArch === 'arm64' ? 'arm64' : nodeArch === 'x64' ? 'amd64' : null;
  return a ? `https://desktop.docker.com/win/main/${a}/Docker%20Desktop%20Installer.exe` : null;
}

/** Windows の PowerShell（5.1）の絶対パス。PATH 任せにしない。 */
export function winPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const PS_HEAD = `$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n`;

/** 署名の確認（読むだけ）。ファイルの場所は、環境変数 IROME_FILE から。 */
export const WIN_VERIFY_SCRIPT = `${PS_HEAD}$s = Get-AuthenticodeSignature -LiteralPath $env:IROME_FILE
$name = ''
$thumb = ''
if ($s.SignerCertificate) {
  $name = $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  $thumb = $s.SignerCertificate.Thumbprint
}
Write-Output ('STATUS=' + [string]$s.Status)
Write-Output ('SIGNER=' + $name)
Write-Output ('THUMBPRINT=' + $thumb)
`;

/** インストーラーを、管理者権限で起動する（Windows が UAC の確認を出す）。引数は固定の 2 つだけ。 */
export const WIN_INSTALL_SCRIPT = `${PS_HEAD}try {
  $p = Start-Process -FilePath $env:IROME_FILE -ArgumentList 'install','--quiet' -Verb RunAs -Wait -PassThru
  if ($null -eq $p.ExitCode) { Write-Output 'IROME_NO_EXIT_CODE'; exit 1 }
  exit $p.ExitCode
} catch [System.ComponentModel.Win32Exception] {
  if ($_.Exception.NativeErrorCode -eq ${WIN_UAC_CANCELED}) { Write-Output 'IROME_UAC_CANCELED'; exit ${WIN_UAC_CANCELED} }
  Write-Output ('IROME_START_FAILED=' + $_.Exception.Message); exit 1
} catch {
  Write-Output ('IROME_START_FAILED=' + $_.Exception.Message); exit 1
}
`;

/** PowerShell の -EncodedCommand 用（UTF-16LE の Base64）。引用符・エスケープの問題を、そもそも起こさない。 */
export function psEncode(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function winPowerShellArgs(script: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', psEncode(script)];
}

/** 署名の確認の出力から、状態・発行元・指紋を読む。どれも、ちょうど 1 つあるときだけ値を返す（複数・無しは null）。 */
export function parseAuthenticodeInfo(text: string): { status: string | null; signer: string | null; thumbprint: string | null } {
  const pick = (key: string): string | null => {
    const vals = text.split('\n').map((l) => new RegExp(`^${key}=(.*)$`).exec(l.replace(/\r$/, ''))).filter((m): m is RegExpExecArray => m !== null).map((m) => m[1].trim());
    return vals.length === 1 && vals[0] !== '' ? vals[0] : null;
  };
  return { status: pick('STATUS'), signer: pick('SIGNER'), thumbprint: pick('THUMBPRINT') };
}

/** Windows 用の、外部コマンドの実行。シェルは通さない。環境変数は、必要なものだけ（PowerShell のモジュールの探し先などは、引き継がない）。 */
export function runFixedWin(cmd: string, args: string[], timeoutMs = 120_000, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((done) => {
    let text = '';
    try {
      const keep = ['SystemRoot', 'windir', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'ComSpec', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'HOMEDRIVE', 'HOMEPATH'];
      const env: Record<string, string> = {};
      for (const k of keep) {
        const found = Object.keys(process.env).find((x) => x.toLowerCase() === k.toLowerCase());
        const v = found ? process.env[found] : undefined;
        if (found && v !== undefined) env[found] = v;
      }
      const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
      env.Path = `${win32.join(root, 'System32')};${root}`;
      const c = spawn(cmd, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ...extraEnv } });
      const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
      const add = (d: Buffer) => { if (text.length < 65_536) text += d.toString('utf8'); };
      c.stdout?.on('data', add);
      c.stderr?.on('data', add);
      c.on('error', (e) => { clearTimeout(t); done({ code: null, text: e.message }); });
      c.on('close', (code) => { clearTimeout(t); done({ code, text: text.trim() }); });
    } catch (e) { done({ code: null, text: (e as Error).message }); }
  });
}

/** ファイルの SHA-256（メモリに溜めず、流しながら）。 */
export function sha256File(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('data', (d) => h.update(d));
    s.on('error', fail);
    s.on('end', () => done(h.digest('hex')));
  });
}

/** すでにある Docker Desktop.exe（全ユーザー用の既定の場所と、ユーザー用の場所。あるものだけ）。 */
const defaultWinAppPaths = (): string[] => {
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const la = process.env.LOCALAPPDATA ?? win32.join(homedir(), 'AppData', 'Local');
  return [win32.join(pf, 'Docker', 'Docker', 'Docker Desktop.exe'), win32.join(la, 'Programs', 'DockerDesktop', 'Docker Desktop.exe')].filter((p) => existsSync(p));
};

/** Docker Desktop.exe の隣の、docker.exe（PATH が、このエージェントの起動後に変わったときのため）。 */
const winDockerExe = (app: string): string => win32.join(win32.dirname(app), 'resources', 'bin', 'docker.exe');

/** Windows の `irome install docker`: 確認 → 取得 → 署名の確認 → UAC（ご自身が「はい」）つきで install --quiet → 確認。エージェントは昇格しない。 */
export function dockerInstallStepsWin(ws: string, env: DockerInstallEnv = {}): Step[] {
  const h = env.hooks ?? {};
  const run = h.run ?? runFixedWin;
  const state: { url?: string; tmp?: string; exe?: string; sha?: string; app?: string; skip?: boolean; launchOnly?: boolean } = {};
  const dockerVersion = (): Promise<string | null> => (h.dockerVersion ?? (() => probeCmd(state.app ? winDockerExe(state.app) : 'docker', ['--version'])))();

  const check: Step = {
    label: '環境を確かめます（Docker の有無・CPU）', cmd: '', args: [], cwd: ws,
    run: async (out) => {
      const have = await (h.dockerVersion ?? (() => probeCmd('docker', ['--version'])))();
      if (have) {
        state.skip = true;
        out(`Docker は、もう入っています（${have}）。何もせずに、終わります。\nまだ動いていないときは、スタートメニューから Docker Desktop を起動してください。\n`);
        return 0;
      }
      const existing = (h.appPaths ?? defaultWinAppPaths)();
      if (existing.length > 0) {
        state.launchOnly = true;
        state.app = existing[0];
        out(`Docker Desktop は、もう入っています（${existing[0]}）。入れ直さずに、終わります。\nスタートメニューから Docker Desktop を起動して、起動しきったら「更新」を押してください（初回は、使用許諾の画面が出ます）。\n`);
        return 0;
      }
      const arch = (h.arch ?? (() => process.arch))();
      const url = dockerDesktopWinUrl(arch);
      if (!url) { out(`この CPU（${arch}）向けの Docker Desktop を、この画面からは入れられません。\n${DOCKER_DESKTOP_WIN_GUIDE_URL}\n`); return 1; }
      state.url = url;
      out(`CPU: ${arch === 'arm64' ? 'ARM64' : 'x64（amd64）'}\n`);
      out('\nこのあと、次のことをします（このエージェント自身は、管理者権限に昇格しません）:\n');
      out(`  1. ${url} から、Docker Desktop のインストーラー（数百 MB）を、作業場所の tools/ の一時フォルダに取得する（desktop.docker.com だけに繋ぐ）\n`);
      out(`  2. Windows の署名（Authenticode）を確かめる（署名が有効で、発行元が ${DOCKER_DESKTOP_WIN_SIGNERS[0]} のときだけ先へ進む）。合わなければ、何も実行せずに止まる\n`);
      out(`  3. インストーラーを「${DOCKER_DESKTOP_WIN_ARGS.join(' ')}」で起動する。管理者権限が要るので、Windows が確認の画面（UAC）を出します。発行元が Docker になっているのを見て、ご自身が「はい」を押してください（「いいえ」なら、何も入らずに終わります）\n`);
      out('  4. 一時フォルダを消して、入ったかを確かめる\n');
      out('これ以外のファイルには、触りません。Docker Desktop が WSL 2 を準備するとき、Windows の再起動を求められることがあります。使用許諾は、初回の起動でご自身が読んで同意します。\n');
      return 0;
    },
  };

  const fetchExe: Step = {
    label: 'Docker Desktop のインストーラーを取得します（desktop.docker.com だけ。数百 MB あるので、時間がかかります）', cmd: '', args: [], cwd: ws,
    run: async (out, ctl) => {
      if (state.skip || state.launchOnly) return 0;
      if (!state.url) return 1;
      sweepTmp(ws);
      mkdirSync(toolsPath(ws), { recursive: true });
      const tmp = mkdtempSync(join(toolsPath(ws), '.docker-tmp-'));
      state.tmp = tmp;
      const exe = join(tmp, 'DockerDesktopInstaller.exe');
      try {
        out(`${state.url}\n`);
        let next = 100 * 1024 * 1024;
        const r = await downloadToFile(state.url, exe, { ws, out, stopped: ctl.stopped, fetchImpl: env.fetch, allowedHosts: DOCKER_DESKTOP_HOSTS, idleTimeoutMs: 120_000 }, DOCKER_DESKTOP_WIN_MAX_BYTES, (n) => {
          if (n >= next) { out(`  ${Math.round(n / 1024 / 1024)} MB…\n`); next = n + 100 * 1024 * 1024; }
        });
        out(`  ${(r.bytes / 1024 / 1024).toFixed(0)} MB を取得しました。\n`);
        state.exe = exe;
        state.sha = r.sha256;
        return 0;
      } catch (e) {
        out(`取得できませんでした: ${(e as Error).message}\n`);
        rmSync(tmp, { recursive: true, force: true });
        state.tmp = undefined;
        return 1;
      }
    },
  };

  const cleanup = (out: (t: string) => void): void => {
    const tmp = state.tmp;
    if (!tmp) return;
    try { rmSync(tmp, { recursive: true, force: true }); state.tmp = undefined; } catch { out(`一時フォルダを消せませんでした（${tmp}）。次にエージェントを起動したときに、消します。\n`); }
  };

  const verifySig: Step = {
    label: 'Docker 公式の署名（Authenticode）を確かめます', cmd: '', args: [], cwd: ws,
    run: async (out, ctl) => {
      if (state.skip || state.launchOnly) return 0;
      const { exe } = state;
      if (!exe) return 1;
      if (ctl.stopped()) { out('停止しました。\n'); cleanup(out); return 130; }
      const r = await run(winPowerShell(), winPowerShellArgs(WIN_VERIFY_SCRIPT), 300_000, { IROME_FILE: exe });
      const info = parseAuthenticodeInfo(r.text);
      if (r.code !== 0 || info.status === null) { out(`署名を確かめられませんでした。入れません。\n${tail(r.text)}\n`); cleanup(out); return 1; }
      if (info.status !== 'Valid') { out(`署名が有効ではありません（状態: ${info.status}）。壊れているか、書き換えられています。入れません。\n`); cleanup(out); return 1; }
      if (info.signer === null || !DOCKER_DESKTOP_WIN_SIGNERS.includes(info.signer)) {
        out(`発行元が Docker Inc のものと一致しません（発行元: ${info.signer ?? '不明'}。期待: ${DOCKER_DESKTOP_WIN_SIGNERS.join(' / ')}）。何も実行せずに止まります。\n`);
        cleanup(out);
        return 1;
      }
      out(`署名を確かめました（署名は有効・発行元: ${info.signer}${info.thumbprint ? '・指紋 ' + info.thumbprint : ''}）。\n`);
      return 0;
    },
  };

  const install: Step = {
    label: 'インストーラーを起動します（Windows の確認画面（UAC）が出たら、ご自身が「はい」を押してください）', cmd: '', args: [], cwd: ws,
    run: async (out, ctl) => {
      if (state.skip || state.launchOnly) return 0;
      const { exe, sha } = state;
      if (!exe || !sha) return 1;
      try {
        if (ctl.stopped()) { out('停止しました。\n'); return 130; }
        // 署名を確かめたあと、管理者権限で動かすまでのあいだに、ファイルが差し替わっていないことを、もう一度確かめる
        let now = '';
        try { now = await sha256File(exe); } catch (e) { out(`インストーラーを読めませんでした: ${(e as Error).message}\n`); return 1; }
        if (now !== sha) { out('署名を確かめたあとで、インストーラーが書き換わりました。実行しません。\n'); return 1; }
        out('Windows の確認画面（UAC）が出ます。見えないときは、タスクバーで点滅しているアイコンを開いてください。\n発行元が Docker になっているのを見て、「はい」を押してください。インストールには、数分〜十数分かかります。\n');
        const r = await run(winPowerShell(), winPowerShellArgs(WIN_INSTALL_SCRIPT), WIN_INSTALL_TIMEOUT_MS, { IROME_FILE: exe });
        if (r.code === WIN_UAC_CANCELED || r.text.includes('IROME_UAC_CANCELED')) { out('確認画面で「はい」が押されなかったので、何も入れていません。入れるときは、もう一度「入れる」を押してください。\n'); return 1; }
        if (r.text.includes('IROME_START_FAILED') || r.text.includes('IROME_NO_EXIT_CODE')) { out(`インストーラーを起動できませんでした。\n${tail(r.text)}\n`); return 1; }
        if (r.code === WIN_REBOOT_REQUIRED) { out('入れました。Windows の再起動が必要です。再起動してから、Docker Desktop を起動してください。\n'); return 0; }
        if (r.code !== 0) { out(`インストーラーが、終了コード ${r.code ?? '不明'} で終わりました。入っていないかもしれません。\n${tail(r.text)}\n`); return 1; }
        state.app = (h.appPaths ?? defaultWinAppPaths)()[0];
        out('インストーラーが終わりました。\n');
        return 0;
      } finally {
        cleanup(out);
      }
    },
  };

  const verify: Step = {
    label: '入ったか確認します', cmd: '', args: [], cwd: ws,
    run: async (out) => {
      if (state.skip || state.launchOnly) return 0;
      const v = await dockerVersion();
      if (!v) {
        out('docker コマンドを、まだ確認できません。スタートメニューから Docker Desktop を起動し（初回は使用許諾の画面が出ます）、Windows の再起動を求められたときは再起動してから、「更新」を押してください。\n');
        return 0;
      }
      out(`${v}\n`);
      const info = await (h.dockerInfo ?? (() => probeCmd(state.app ? winDockerExe(state.app) : 'docker', ['info'])))();
      out(info === null
        ? '\nDocker のデーモンは、まだ動いていません。スタートメニューから Docker Desktop を起動して、起動しきる（トレイの Docker のアイコンが動き終わる）まで待ってから、「更新」を押してください。\n'
        : '\nDocker のデーモンに繋がりました。\n');
      return 0;
    },
  };

  return [check, fetchExe, verifySig, install, verify];
}
