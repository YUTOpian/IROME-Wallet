// `irome nem install | start | stop | update | supernode | status` の手順: NEM（NIS1）ノードを、公式ドキュメントの「Docker を使用する」の方法（nem-docker）で建てる。
// エージェントが固定で組む（画面から取得先・引数・シェルの文字は入らない）。動かす場所は、画面の「作業フォルダ」（作業場所の中の、ノード用のフォルダ）。
//
// 公式の手順（docs.nemtest.net「ノードのインストール > Docker を使用する」）:
//   git clone https://github.com/NemProject/nem-docker.git → cd nem-docker → ./boot.sh（初回は名前と boot key を聞く）→ 停止は ./stop.sh
//   設定を手で作るなら、起動の前に custom-configs/nis.config-user.properties を作る（聞かれなくなる）。更新は ./stop.sh → git pull → ./boot.sh。
//
// 決まり:
// - Linux（WSL を含む）だけ。公式が「Docker の手順は Linux だけ」としているため。それ以外の OS は、何もせず案内して止まる。
// - 取得先は公式リポジトリに固定（NEM_DOCKER_REPO）。`git clone --depth 1` だけ。すでに nem-docker のフォルダがあれば、上書きせず止まる。
// - start / update は、設定ファイル（custom-configs/nis.config-user.properties）が先にあるときだけ。無いと boot.sh が名前や鍵を聞いて止まってしまうので、動かさない。
// - boot.sh / stop.sh に `sudo` が含まれているときは、動かさない（このエージェントはパスワードを渡さない。許可リストにも `sudo` は無い）。
//   そのときは、同じ手順を、ご自身のターミナルで行う（案内を出す）。
// - nem-docker のフォルダ・スクリプトがシンボリックリンクなら、辿らずに止まる。
// - 動かすのは `/bin/sh ./boot.sh`・`/bin/sh ./stop.sh`・`/bin/sh ./service.sh status`・`git pull --ff-only` だけ。引数は固定。
// - スーパーノード（公式ドキュメント「スーパーノードプログラム > Docker を使用する」）: `irome nem supernode` は、custom-configs/supervisord.conf.sample を
//   supervisord.conf にコピーして、[program:nis] と [program:servant] の autostart を true にするだけ（supervisord.conf は、プロセスを起動する設定なので、画面からは書かせない）。
//   Servant の設定 servant.config.properties（nem.host・servant.key）は、画面が先に置く（.properties）。無いときは、動かさない。既に supervisord.conf があるときは、上書きしない。

import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Step } from './agent';
import { probeCmd } from './provision';
import type { NemAction } from '../../lib/node/nodeCommands';

export const NEM_DOCKER_REPO = 'https://github.com/NemProject/nem-docker.git';
export const NEM_DOCKER_DIR = 'nem-docker';
/** nem-docker が、起動のときに読む設定ファイル（公式の docs の名前。古い版の名前も受け付ける）。 */
export const NEM_CONFIG_FILES: readonly string[] = ['custom-configs/nis.config-user.properties', 'custom-configs/config-user.properties'];

/** Servant の設定（公式の名前。画面が nem.host と servant.key を書く）。 */
export const NEM_SERVANT_CONFIG = 'custom-configs/servant.config.properties';
export const NEM_SUPERVISOR_SAMPLE = 'custom-configs/supervisord.conf.sample';
export const NEM_SUPERVISOR_CONF = 'custom-configs/supervisord.conf';
/** supervisord.conf で、起動を true にする対象（公式: [program:nis] と [program:servant] の両方）。 */
export const NEM_SUPERVISOR_PROGRAMS: readonly string[] = ['nis', 'servant'];

/**
 * supervisord.conf.sample の、指定したプログラムの `autostart` を true にする（行が無ければ、見出しの次に足す）。
 * 戻り値: 直した本文と、見つかったプログラム。サンプルに無いプログラムがあれば、missing に入る。
 */
export function enableAutostart(sample: string, programs: readonly string[] = NEM_SUPERVISOR_PROGRAMS): { text: string; missing: string[] } {
  const lines = sample.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = null; // いま見ている対象のプログラム
  let done = false; // その対象に autostart=true を入れたか
  for (const line of lines) {
    const head = /^\s*\[\s*([^\]]+?)\s*\]\s*$/.exec(line);
    if (head) {
      const m = /^program:(.+)$/.exec(head[1]);
      cur = m && programs.includes(m[1]) ? m[1] : null;
      done = false;
      out.push(line);
      if (cur) { seen.add(cur); out.push('autostart=true'); done = true; } // 先に入れて、同じ節の古い autostart 行は捨てる
      continue;
    }
    if (cur && done && /^\s*;?\s*autostart\s*=/.test(line)) continue;
    out.push(line);
  }
  return { text: out.join('\n'), missing: programs.filter((p) => !seen.has(p)) };
}

/** 本文で、指定したプログラムの autostart が true か（すでにある supervisord.conf の確認用）。 */
export function autostartEnabled(text: string, programs: readonly string[] = NEM_SUPERVISOR_PROGRAMS): boolean {
  let cur: string | null = null;
  const ok = new Set<string>();
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const head = /^\s*\[\s*([^\]]+?)\s*\]\s*$/.exec(line);
    if (head) { const m = /^program:(.+)$/.exec(head[1]); cur = m ? m[1] : null; continue; }
    if (cur && programs.includes(cur) && /^\s*autostart\s*=\s*true\s*(;.*)?$/i.test(line)) ok.add(cur);
  }
  return programs.every((p) => ok.has(p));
}

export interface NemEnv { platform?: NodeJS.Platform; /** 試験用: PATH の探索を使わず、この関数で「その名前のコマンドが動くか」を答える */ probe?: (cmd: string, args: string[]) => Promise<string | null> }

type Out = (t: string) => void;
const kind = (p: string): 'file' | 'dir' | 'link' | 'none' | 'other' => {
  try {
    const st = lstatSync(p);
    return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
  } catch { return 'none'; }
};

/** boot.sh / stop.sh の中に `sudo` があるか（読めなければ true 扱い＝動かさない）。コメント行は見ない。 */
export function scriptUsesSudo(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').split('\n').some((l) => !/^\s*#/.test(l) && /(^|[^A-Za-z0-9_])sudo([^A-Za-z0-9_]|$)/.test(l));
  } catch { return true; }
}

export function nemSteps(action: NemAction, cwd: string, env: NemEnv = {}): Step[] {
  const pl = env.platform ?? process.platform;
  const probe = env.probe ?? probeCmd;
  const repo = join(cwd, NEM_DOCKER_DIR);
  const own = (label: string, run: NonNullable<Step['run']>): Step => ({ label, cmd: '', args: [], cwd, run });
  const sh = (label: string, script: 'boot.sh' | 'stop.sh' | 'service.sh', ...extra: string[]): Step => ({ label, cmd: '/bin/sh', args: [`./${script}`, ...extra], cwd: repo });

  /** 共通の確認: Linux・docker（と、必要なら git）。 */
  const base = (needGit: boolean): Step => own('準備を確かめます（Linux・Docker' + (needGit ? '・git' : '') + '）', async (out: Out) => {
    if (pl !== 'linux') {
      out('NEM（NIS1）ノードのワンクリック構築は、Linux（WSL を含む）だけです。公式ドキュメントの Docker の手順が、Linux だけを対象にしているためです。\n');
      out('Mac・Windows では、Linux のサーバーでこのエージェントを動かして繋ぐか（docs/NODE.md の「別のマシンのノードを操作する」）、公式の「手動インストール」（Java 11 と公式のバイナリ）を使ってください。\n');
      return 1;
    }
    if ((await probe('docker', ['--version'])) === null) { out('docker が見つかりません。先に「この PC の環境」で Docker を入れてください。\n'); return 1; }
    if (needGit && (await probe('git', ['--version'])) === null) { out('git が見つかりません。公式の手順は git clone から始まるので、先に git を入れてください（例: sudo apt install git）。\n'); return 1; }
    return 0;
  });

  /** nem-docker が取得済みで、スクリプトが普通のファイルか。 */
  const ready = (scripts: Array<'boot.sh' | 'stop.sh' | 'service.sh'>, needConfig: boolean): Step => own('nem-docker と設定ファイルを確かめます', (out: Out) => {
    const k = kind(repo);
    if (k === 'none') { out(`${NEM_DOCKER_DIR} フォルダがありません。先に「irome nem install」で取得してください。\n`); return 1; }
    if (k !== 'dir') { out(`${NEM_DOCKER_DIR} が、フォルダではない・シンボリックリンクのため、使いません。\n`); return 1; }
    for (const s of scripts) {
      const p = join(repo, s);
      if (kind(p) !== 'file') { out(`${NEM_DOCKER_DIR}/${s} が、普通のファイルとして見つかりません。\n`); return 1; }
      if (scriptUsesSudo(p)) {
        out(`${NEM_DOCKER_DIR}/${s} の中に sudo があります。このエージェントは sudo のパスワードを渡さないので、動かしません。\n`);
        out(`ご自身のターミナルで、${NEM_DOCKER_DIR} フォルダに入って ./${s} を動かしてください（公式の手順と同じです）。\n`);
        return 1;
      }
    }
    if (needConfig && !NEM_CONFIG_FILES.some((f) => kind(join(repo, f)) === 'file')) {
      out(`設定ファイル（${NEM_CONFIG_FILES[0]}）がありません。無いまま起動すると、boot.sh がノードの名前と鍵を聞いて止まります。\n`);
      out('画面の「NEM ノード構築」で設定ファイルを作ってから、起動してください。\n');
      return 1;
    }
    return 0;
  });

  switch (action) {
    case 'install': return [
      base(true),
      own('取得先のフォルダを確かめます', (out: Out) => {
        if (kind(repo) !== 'none') { out(`${NEM_DOCKER_DIR} は、すでにあります。上書きしません（更新するときは「irome nem update」）。\n`); return 1; }
        return 0;
      }),
      { label: '公式の nem-docker を取得します（git clone）', cmd: 'git', args: ['clone', '--depth', '1', NEM_DOCKER_REPO, NEM_DOCKER_DIR], cwd },
      ready(['boot.sh', 'stop.sh'], false),
    ];
    case 'start': return [base(false), ready(['boot.sh'], true), sh('ノードを起動します（./boot.sh。初回は Docker のイメージを作るので、時間がかかります）', 'boot.sh')];
    case 'supernode': return [
      base(false),
      ready(['boot.sh'], true),
      own('スーパーノードの設定を作ります（supervisord.conf。Servant を自動で起動する）', (out: Out) => {
        const servant = join(repo, NEM_SERVANT_CONFIG);
        if (kind(servant) !== 'file') {
          out(`Servant の設定ファイル（${NEM_SERVANT_CONFIG}）がありません。先に画面の「NEM ノード構築」で、スーパーノードの設定（ノードのホストとリモート鍵）を入れてください。\n`);
          return 1;
        }
        const conf = join(repo, NEM_SUPERVISOR_CONF);
        const ck = kind(conf);
        if (ck === 'link' || ck === 'dir' || ck === 'other') { out(`${NEM_SUPERVISOR_CONF} が、普通のファイルではないため、使いません。\n`); return 1; }
        if (ck === 'file') {
          // すでにあるものは、上書きしない（手で直したものを守る）。nis と servant の autostart が true なら、そのまま使う
          let text = '';
          try { text = readFileSync(conf, 'utf8'); } catch { out(`${NEM_SUPERVISOR_CONF} を読めません。\n`); return 1; }
          if (autostartEnabled(text)) { out(`${NEM_SUPERVISOR_CONF} は、すでに設定済みです（[program:nis] と [program:servant] の autostart が true）。そのまま使います。\n`); return 0; }
          out(`${NEM_SUPERVISOR_CONF} がすでにありますが、[program:nis] と [program:servant] の両方で autostart=true になっていません。上書きはしません。\n`);
          out(`ご自身で、${NEM_SUPERVISOR_CONF} の両方に autostart=true を入れるか、このファイルを消してから、もう一度実行してください。\n`);
          return 1;
        }
        const sk = kind(join(repo, NEM_SUPERVISOR_SAMPLE));
        if (sk !== 'file') { out(`${NEM_SUPERVISOR_SAMPLE} が、普通のファイルとして見つかりません（nem-docker の版が古い、または違う可能性があります）。\n`); return 1; }
        let sample = '';
        try { sample = readFileSync(join(repo, NEM_SUPERVISOR_SAMPLE), 'utf8'); } catch { out(`${NEM_SUPERVISOR_SAMPLE} を読めません。\n`); return 1; }
        const r = enableAutostart(sample);
        if (r.missing.length > 0) { out(`${NEM_SUPERVISOR_SAMPLE} に、[program:${r.missing.join('] / [program:')}] が見つかりません。公式の手順と違うので、作りません。\n`); return 1; }
        try {
          writeFileSync(conf, r.text, { flag: 'wx', mode: 0o644 });
          out(`${NEM_SUPERVISOR_CONF} を作りました（[program:nis] と [program:servant] の autostart=true）。\n`);
          return 0;
        } catch { out(`${NEM_SUPERVISOR_CONF} を作れませんでした。\n`); return 1; }
      }),
    ];
    case 'status': return [base(false), ready(['service.sh'], false), sh('ノードと Servant の状態を見ます（./service.sh status）', 'service.sh', 'status')];
    case 'stop': return [base(false), ready(['stop.sh'], false), sh('ノードを止めます（./stop.sh）', 'stop.sh')];
    case 'update': return [
      base(true),
      ready(['boot.sh', 'stop.sh'], true),
      sh('ノードを止めます（./stop.sh）', 'stop.sh'),
      { label: '公式の更新を取り込みます（git pull）', cmd: 'git', args: ['pull', '--ff-only'], cwd: repo },
      ready(['boot.sh'], true), // 更新で boot.sh が変わったので、もう一度確かめる（sudo が入っていないか）
      sh('ノードを起動し直します（./boot.sh）', 'boot.sh'),
    ];
  }
}
