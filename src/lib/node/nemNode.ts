// 「NEM ノード構築」（NEM の NIS1 ノードを、公式の nem-docker で建てる）の、画面に依らない部品。画面は pages/node/NemOneClickCard.tsx。
//
// 決まり:
// - 実行する行は、すべて nodeCommands.ts の許可の判定を通る行だけ（`irome nem …`・`docker ps`）。エージェントも 1 行ごとにもう一度同じ判定をかける。
// - 設定ファイル custom-configs/nis.config-user.properties は、画面が作って、エージェントの「ファイルを書く」で置く（.properties は設定ファイルとして許可済み）。
//   中身は公式ドキュメントの項目だけ: nis.bootName・nis.bootKey・（ハーベストするとき）nis.shouldAutoHarvestOnBoot・（テストネットのとき）nem.network と、フォークの高さ。
// - nis.bootKey は、ノードの「リモートアカウント」の秘密鍵（公式の推奨。委任ハーベスト用）。ウォレットのメインアカウントの鍵は入れない。
//   空にすると、画面が乱数で作って書く（このノード専用。ウォレットのアカウントとは無関係）。画面にも履歴にも出さない。
// - スーパーノード（公式ドキュメント「スーパーノードプログラム」の Docker の手順）: Node Servant の設定 custom-configs/servant.config.properties（nem.host・servant.key）を画面が作り、
//   supervisord.conf（autostart を true にする）は、エージェントの `irome nem supernode` が、サンプルから作る。nis.bootKey と servant.key は、同じリモートアカウントの秘密鍵（メインアカウントの鍵は使わない）。
//   スーパーノードは、メインネットだけ。リモート鍵は自動では作れない（登録したメインアカウントの委任ハーベスト用の鍵でなければならない）。
// - すでに設定ファイルがあるフォルダでは構築しない（動いているノードの設定・鍵を上書きしないため）。

import { validateSubdir, validateWorkspaceFile } from './nodeCommands';

export type NemNetwork = 'mainnet' | 'testnet';

export interface NemOptions {
  /** 作業場所の中の、ノードを作るフォルダ（相対パス） */
  dir: string;
  network: NemNetwork;
  /** ノードの名前（nis.bootName。情報として出るだけ） */
  name: string;
  /** 起動したときに、自動でハーベストを始める（nis.shouldAutoHarvestOnBoot） */
  harvest: boolean;
  /** nis.bootKey（64 桁の 16 進数）。空なら、構築のときに乱数で作る（スーパーノードでは、リモートアカウントの鍵が必須） */
  bootKey: string;
  /** スーパーノードにする（Node Servant を設定して、NIS と一緒に起動する）。メインネットだけ */
  supernode: boolean;
  /** スーパーノードのホスト（nem.host。公開 IP アドレス、またはドメイン名）。ノードの /node/info が返すホストと一致させる */
  host: string;
}

export const NEM_DEFAULT_DIR = 'nem-node';
export const NEM_DEFAULT_NAME = 'my-nem-node';
export const NEM_MAX_NAME = 64;
/** nem-docker の取得先のフォルダ名（エージェントの nemNode.ts と同じ）。設定ファイルは、この中に置く。 */
export const NEM_DOCKER_DIR = 'nem-docker';
export const NEM_CONFIG_PATH = 'custom-configs/nis.config-user.properties';
/** NIS1 の既定のポート。REST は 7890、WebSocket は 7778。 */
export const NEM_PORTS = { rest: 7890, websocket: 7778 } as const;
/** ウォレットが、ローカルのノードの状態を見に行く先。 */
/** Servant が使うポート（スーパーノードプログラムのテストを受ける。受信・送信とも開ける）。 */
export const NEM_SERVANT_PORT = 7880;
export const NEM_SERVANT_CONFIG_PATH = 'custom-configs/servant.config.properties';
export const NEM_LOCAL_URL = `http://127.0.0.1:${NEM_PORTS.rest}`;

export const defaultNemOptions = (): NemOptions => ({ dir: NEM_DEFAULT_DIR, network: 'mainnet', name: NEM_DEFAULT_NAME, harvest: false, bootKey: '', supernode: false, host: '' });

/** 構築の前提: Docker と git が、この PC に入っている。 */
export const nemToolsReady = (tools: Readonly<Record<'docker' | 'git', { found: boolean }>>): boolean => tools.docker.found && tools.git.found;
export const nemMissingTools = (tools: Readonly<Record<'docker' | 'git', { found: boolean }>>): Array<'docker' | 'git'> => (['docker', 'git'] as const).filter((k) => !tools[k].found);

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const HEX64 = /^[0-9a-fA-F]{64}$/;

/** ノードのフォルダとして使える名前か。作業場所の直下（空）・tools/ の中は使わない。 */
export function validateNemDir(raw: string): boolean {
  const dir = validateSubdir(raw);
  return dir.ok && dir.value !== '' && dir.value.split('/')[0].toLowerCase() !== 'tools' && validateWorkspaceFile(`${dir.value}/${NEM_DOCKER_DIR}/${NEM_CONFIG_PATH}`).ok;
}

/**
 * 名前として使えるか。公式: 先頭と末尾の空白は削られ、名前の途中の空白は可。ASCII の外の文字は `\uXXXX` のエスケープが要るので、ここでは ASCII（印字できる文字）だけにする。
 * `\`・`=`・`#`・`!`・`:` は、properties の書き方を壊すので使わない。
 */
export function validateNemName(raw: string): boolean {
  const n = raw.trim();
  return n !== '' && n.length <= NEM_MAX_NAME && !CONTROL_RE.test(n) && /^[\x20-\x7e]+$/.test(n) && !/[\\=#!:]/.test(n);
}

/**
 * スーパーノードのホストとして使えるか。公開 IPv4 アドレス、または（ドットを含む）ドメイン名。
 * 自分の中だけで通じる値（localhost・127.* / 10.* / 192.168.* / 172.16–31.* / 169.254.* / 0.*）は、コントローラーが届かないので使わない。
 */
export function validateNemHost(raw: string): boolean {
  const h = raw.trim();
  if (h === '' || h.length > 253) return false;
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ip) {
    const [a, b, c, d] = ip.slice(1).map((x) => Number(x));
    if (![a, b, c, d].every((x) => x >= 0 && x <= 255) || ip.slice(1).some((x) => x.length > 1 && x.startsWith('0'))) return false;
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return false;
    return true;
  }
  if (/^\d+(\.\d+)*$/.test(h)) return false; // 数字とドットだけで、IPv4 の形でないもの
  const labels = h.split('.');
  return labels.length >= 2 && labels.every((l) => /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l)) && !/^\d+$/.test(labels[labels.length - 1]) && h.toLowerCase() !== 'localhost';
}

export type NemOptionError = 'dir' | 'name' | 'key' | 'key_required' | 'host' | 'supernode_network';
/** 入力の確認。問題があれば、理由（i18n の `service.node_nem_err_<理由>`）を返す。無ければ null。supernodeOnly: 既存のノードをスーパーノードにするとき（名前は使わない）。 */
export function validateNemOptions(o: NemOptions, supernodeOnly = false): NemOptionError | null {
  if (!validateNemDir(o.dir)) return 'dir';
  if (!supernodeOnly && !validateNemName(o.name)) return 'name';
  const k = o.bootKey.trim();
  if (k !== '' && !HEX64.test(k)) return 'key';
  if (o.supernode || supernodeOnly) {
    if (o.network !== 'mainnet') return 'supernode_network';
    if (k === '') return 'key_required';
    if (!validateNemHost(o.host)) return 'host';
  }
  return null;
}

export function normalizeNemOptions(o: NemOptions): NemOptions {
  const dir = validateSubdir(o.dir);
  return { ...o, dir: dir.ok ? dir.value : o.dir.trim(), name: o.name.trim(), bootKey: o.bootKey.trim().toLowerCase(), host: o.host.trim().toLowerCase() };
}

/** 乱数で作る boot key（32 バイト = 64 桁の 16 進数）。NEM の秘密鍵は、32 バイトの乱数でよい。 */
export function randomBootKey(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return [...random(32)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** テストネットのときに足す設定（公式ドキュメントの「テストネットノードを実行する」。2026 年 9 月の新しいテストネット）。 */
export const TESTNET_PROPERTIES = `nem.network = testnet

nis.treasuryReissuanceForkHeight = 1
nis.treasuryReissuanceForkTransactionHashes =
nis.treasuryReissuanceForkFallbackTransactionHashes =
nis.multisigMOfNForkHeight = 1
nis.mosaicsForkHeight = 1
nis.firstFeeForkHeight = 1
nis.secondFeeForkHeight = 1
nis.remoteAccountForkHeight = 1
nis.mosaicRedefinitionForkHeight = 1
`;

/**
 * 設定ファイルの中身。bootKey は、呼ぶ側が決めて渡す（入力が空なら randomBootKey()）。
 * nem.folder は書かない（Docker では、nem-docker が置き場所を決める）。
 */
export function nemPropertiesContent(o: Pick<NemOptions, 'name' | 'network' | 'harvest'>, bootKey: string): string {
  const lines = [`nis.bootName = ${o.name.trim()}`, `nis.bootKey = ${bootKey}`];
  if (o.harvest) lines.push('nis.shouldAutoHarvestOnBoot = true');
  return `${lines.join('\n')}\n${o.network === 'testnet' ? `\n${TESTNET_PROPERTIES}` : ''}`;
}

/** Servant の設定ファイルの中身（公式: 少なくとも nem.host と servant.key）。servant.key は、リモートアカウントの秘密鍵（nis.bootKey と同じ）。 */
export function servantPropertiesContent(host: string, key: string): string {
  return `nem.host = ${host.trim()}\nservant.key = ${key}\n`;
}

/** properties の 1 項目を、値だけ入れ替える（無ければ末尾に足す）。ほかの行・コメントは、そのまま残す。 */
export function setProperty(content: string, key: string, value: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[=:]`);
  let hit = false;
  const out = lines.map((l) => { if (!hit && re.test(l)) { hit = true; return `${key} = ${value}`; } return l; });
  if (!hit) {
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    out.push(`${key} = ${value}`, '');
  }
  return out.join('\n');
}

export type NemStepId = 'check' | 'install' | 'config' | 'servant' | 'nisKey' | 'supernode' | 'start' | 'ps' | 'status' | 'stop' | 'update';
export interface NemPlanStep {
  id: NemStepId;
  kind: 'run' | 'config';
  line?: string;
  cwd?: string;
}

/** ノードのフォルダ（cwd）。nem-docker は、この中に取得される。 */
const cwdOf = (dir: string): string => { const v = validateSubdir(dir); return v.ok ? v.value : dir.trim(); };

/** 構築の手順: 取得（git clone）→ 設定ファイルを作る → 起動（boot.sh）→ 確認。前が成功したときだけ次へ進む。 */
export function planNemBuild(raw: NemOptions): NemPlanStep[] {
  const o = normalizeNemOptions(raw);
  if (o.supernode) {
    // スーパーノード: 取得 → NIS の設定 → Servant の設定 → supervisord.conf（Servant を自動起動）→ 起動 → 状態
    return [
      { id: 'install', kind: 'run', line: 'irome nem install', cwd: o.dir },
      { id: 'config', kind: 'config' },
      { id: 'servant', kind: 'config' },
      { id: 'supernode', kind: 'run', line: 'irome nem supernode', cwd: o.dir },
      { id: 'start', kind: 'run', line: 'irome nem start', cwd: o.dir },
      { id: 'status', kind: 'run', line: 'irome nem status', cwd: o.dir },
    ];
  }
  return [
    { id: 'install', kind: 'run', line: 'irome nem install', cwd: o.dir },
    { id: 'config', kind: 'config' },
    { id: 'start', kind: 'run', line: 'irome nem start', cwd: o.dir },
    { id: 'ps', kind: 'run', line: 'docker ps', cwd: o.dir },
  ];
}
/** すでにあるノードを、スーパーノードにする: 止める → nis.bootKey をリモート鍵にそろえる → Servant の設定 → supervisord.conf → 起動 → 状態（公式の「Servant を設定する」の順）。 */
export function planNemSupernode(raw: NemOptions): NemPlanStep[] {
  const o = normalizeNemOptions(raw);
  return [
    { id: 'stop', kind: 'run', line: 'irome nem stop', cwd: o.dir },
    { id: 'nisKey', kind: 'config' },
    { id: 'servant', kind: 'config' },
    { id: 'supernode', kind: 'run', line: 'irome nem supernode', cwd: o.dir },
    { id: 'start', kind: 'run', line: 'irome nem start', cwd: o.dir },
    { id: 'status', kind: 'run', line: 'irome nem status', cwd: o.dir },
  ];
}
export const planNemStart = (dir: string): NemPlanStep[] => [{ id: 'start', kind: 'run', line: 'irome nem start', cwd: cwdOf(dir) }, { id: 'ps', kind: 'run', line: 'docker ps', cwd: cwdOf(dir) }];
export const planNemStop = (dir: string): NemPlanStep[] => [{ id: 'stop', kind: 'run', line: 'irome nem stop', cwd: cwdOf(dir) }];
export const planNemUpdate = (dir: string): NemPlanStep[] => [{ id: 'update', kind: 'run', line: 'irome nem update', cwd: cwdOf(dir) }, { id: 'ps', kind: 'run', line: 'docker ps', cwd: cwdOf(dir) }];

/** 設定ファイルの、作業場所からの相対パス。 */
export const nemConfigFile = (dir: string): string => `${cwdOf(dir)}/${NEM_DOCKER_DIR}/${NEM_CONFIG_PATH}`;
/** Servant の設定ファイルの、作業場所からの相対パス。 */
export const nemServantFile = (dir: string): string => `${cwdOf(dir)}/${NEM_DOCKER_DIR}/${NEM_SERVANT_CONFIG_PATH}`;

// ---- ノードの状態（NIS1 の REST を、ブラウザから 1 回見るだけ）----

export interface NemNodeStatus { ok: true; height: number | null; version: string | null; name: string | null; network: string | null }
/** `/node/info` と `/chain/height` の返事（信用しない。形と長さを確かめる）。 */
export function parseNemNodeStatus(info: unknown, height: unknown): NemNodeStatus {
  const rec = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const str = (v: unknown, max = 80): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL_RE.test(v) ? v : null);
  const i = rec(info);
  const meta = rec(i?.metaData);
  const h = rec(height)?.height;
  const net = meta?.networkId;
  return {
    ok: true,
    height: typeof h === 'number' && Number.isSafeInteger(h) && h >= 0 ? h : null,
    version: str(meta?.version, 40),
    name: str(i?.identity && rec(i.identity)?.name),
    network: net === 104 ? 'mainnet' : net === -104 ? 'testnet' : null,
  };
}
