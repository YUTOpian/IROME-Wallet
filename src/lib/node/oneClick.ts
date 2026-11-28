// 「ノード構築」（Shoestring のノードを、ボタン 1 回で作る）の、画面に依らない部品。画面は pages/node/OneClickCard.tsx。
//
// 決まり:
// - 実行するコマンドは、すべて nodeCommands.ts の許可の判定を通る行だけ（新しい許可は増やさない）。エージェントも、1 行ごとにもう一度同じ判定をかける。
//   dev-tests/node-oneclick.test.ts が、組み立てた行がすべて通ることを確かめる。
// - Docker・Python・Shoestring の導入はここでは行わない（先に PC に入っていることが、ボタンを押せる条件）。
// - すでに config.ini があるフォルダは使わない（動いているノードの設定・鍵を上書きしないため）。ca.key.pem も、openssl の手順が上書きを断る。
// - 秘密鍵は、画面にも出さない（ca.key.pem は作業フォルダの中に作るだけ。`--show-private` や `openssl pkey` は使わない）。

import { PIP_VERSION, validateSubdir, validateWorkspaceFile } from './nodeCommands';

export type OneClickNetwork = 'mainnet' | 'testnet';

export interface OneClickOptions {
  /** 作業場所の中の、ノードを作るフォルダ（相対パス） */
  dir: string;
  network: OneClickNetwork;
  /** ハーベスティングを有効にする（features に HARVESTER） */
  harvesting: boolean;
  /** 投票ノードにする（features に VOTER） */
  voting: boolean;
  /** ノード一覧に出る名前（overrides.ini の friendlyName） */
  friendlyName: string;
  /** ほかのノードから届く公開 IP かホスト名（空なら overrides.ini に入れない） */
  host: string;
  /** 更新のときに入れる Shoestring のバージョン（`0.2.6` など。空なら最新）。構築・停止では使わない。 */
  shoestringVersion: string;
}

export const DEFAULT_DIR = 'symbol-node';
export const DEFAULT_FRIENDLY_NAME = 'My Symbol Node';
export const MAX_FRIENDLY_NAME = 64;

/** Shoestring の `--package`。メインネットは mainnet、テストネットは sai。 */
export const PACKAGE_OF: Readonly<Record<OneClickNetwork, string>> = { mainnet: 'mainnet', testnet: 'sai' };

export const defaultOptions = (): OneClickOptions => ({ dir: DEFAULT_DIR, network: 'mainnet', harvesting: false, voting: false, friendlyName: DEFAULT_FRIENDLY_NAME, host: '', shoestringVersion: '' });

/** ボタンを押せる条件: Docker・Python・Shoestring が、この PC に入っている。 */
export function toolsReady(tools: Readonly<Record<'docker' | 'python' | 'shoestring', { found: boolean }>>): boolean {
  return tools.docker.found && tools.python.found && tools.shoestring.found;
}
export function missingTools(tools: Readonly<Record<'docker' | 'python' | 'shoestring', { found: boolean }>>): Array<'docker' | 'python' | 'shoestring'> {
  return (['docker', 'python', 'shoestring'] as const).filter((k) => !tools[k].found);
}

/** config.ini の features の値（`PEER | API` に、チェックした分を足す）。 */
export function featuresValue(o: Pick<OneClickOptions, 'harvesting' | 'voting'>): string {
  return ['PEER', 'API', ...(o.harvesting ? ['HARVESTER'] : []), ...(o.voting ? ['VOTER'] : [])].join(' | ');
}

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6_RE = /^[0-9A-Fa-f:]{2,45}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export const isValidHost = (h: string): boolean => h.length <= 253 && (HOST_RE.test(h) || (h.includes(':') && IPV6_RE.test(h)));

/** ノードのフォルダとして使える名前か。作業場所の直下（空）は使わない（tools/ や、ほかのノードと混ざるため）。tools/ の中も使わない。 */
export function validateDir(raw: string): boolean {
  const dir = validateSubdir(raw);
  return dir.ok && dir.value !== '' && dir.value.split('/')[0].toLowerCase() !== 'tools' && validateWorkspaceFile(`${dir.value}/config.ini`).ok;
}

/** 更新で指定する Shoestring のバージョンとして使えるか。空は「最新」で使える。数字とドットだけ（`0.2.6` など。pip の `==` の右側にそのまま付けるため）。 */
export function validateShoestringVersion(raw: string): boolean {
  const v = raw.trim();
  return v === '' || PIP_VERSION.test(v);
}

/** 入力の確認。問題があれば、理由（i18n の `service.node_oc_err_<理由>`）を返す。無ければ null。 */
export function validateOptions(o: OneClickOptions): 'dir' | 'name' | 'host' | null {
  if (!validateDir(o.dir)) return 'dir';
  const name = o.friendlyName.trim();
  if (name === '' || name.length > MAX_FRIENDLY_NAME || CONTROL_RE.test(name)) return 'name';
  const host = o.host.trim();
  if (host !== '' && !isValidHost(host)) return 'host';
  return null;
}

/** 空白を整えた、実際に使う値。 */
export function normalizeOptions(o: OneClickOptions): OneClickOptions {
  const dir = validateSubdir(o.dir);
  return { ...o, dir: dir.ok ? dir.value : o.dir.trim(), friendlyName: o.friendlyName.trim(), host: o.host.trim() };
}

/** overrides.ini の中身（公式の例の形）。host は、入れたときだけ書く。 */
export function overridesContent(o: Pick<OneClickOptions, 'friendlyName' | 'host'>): string {
  return `[node.localnode]\n${o.host.trim() !== '' ? `host = ${o.host.trim()}\n` : ''}friendlyName = ${o.friendlyName.trim()}\n`;
}

/**
 * INI の、指定したセクションの値を書き換える（元の改行コード・ほかのセクション・コメントはそのまま）。
 * キーがあれば、その行の値だけを置き換え（`key = value` の形に整える）、なければセクションの末尾に足す。セクション自体が無ければ、末尾に作る。
 * 値に改行を含めない（呼ぶ側が、validateOptions で確かめた値だけを渡す）。
 */
export function setIniValues(text: string, section: string, values: Readonly<Record<string, string>>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const pending = new Map(Object.entries(values));
  const sectionRe = /^\s*\[([^\]]*)\]\s*$/;
  let inSection = false;
  let sectionFound = false;
  let lastIdx = -1; // 対象セクションの、最後の中身の行
  const out: string[] = [];
  const flush = () => {
    // 対象セクションの終わりで、まだ書いていないキーを足す（最後の中身の行の直後）
    if (pending.size === 0) return;
    const add = [...pending].map(([k, v]) => `${k} = ${v}`);
    const at = lastIdx >= 0 ? lastIdx + 1 : out.length;
    out.splice(at, 0, ...add);
    pending.clear();
  };
  for (const line of lines) {
    const m = sectionRe.exec(line);
    if (m) {
      if (inSection) flush();
      inSection = m[1].trim() === section;
      if (inSection) { sectionFound = true; lastIdx = out.length; }
      out.push(line);
      continue;
    }
    if (inSection) {
      const kv = /^(\s*)([^=:;#\s][^=:]*?)\s*[=:]/.exec(line);
      if (kv && pending.has(kv[2])) {
        out.push(`${kv[2]} = ${pending.get(kv[2])}`);
        pending.delete(kv[2]);
        lastIdx = out.length - 1;
        continue;
      }
      if (line.trim() !== '' && !/^\s*[;#]/.test(line)) lastIdx = out.length;
    }
    out.push(line);
  }
  if (inSection) flush();
  let result = out.join(eol);
  if (!sectionFound && pending.size > 0) {
    if (result !== '' && !result.endsWith(eol)) result += eol;
    result += `${result === '' ? '' : eol}[${section}]${eol}${[...pending].map(([k, v]) => `${k} = ${v}`).join(eol)}${eol}`;
  }
  return result;
}

/** init が作った config.ini に、この構築で決める値を入れる。caCommonName・nodeCommonName は、空だと証明書の作成に失敗するので、名前から入れる。 */
export function applyConfig(text: string, o: OneClickOptions): string {
  const cn = o.friendlyName.trim();
  return setIniValues(text, 'node', { features: featuresValue(o), caCommonName: `${cn} CA`, nodeCommonName: cn });
}

export type StepKind = 'run' | 'config' | 'overrides';
export interface PlanStep {
  /** 画面の目印と、i18n（`service.node_oc_step_<id>`） */
  id: 'docker_up' | 'openssl' | 'init' | 'config' | 'overrides' | 'key' | 'setup' | 'start' | 'ps' | 'down' | 'pip' | 'upgrade';
  kind: StepKind;
  /** run のとき: 実行する行と、その作業フォルダ（作業場所の中の相対パス。空は直下） */
  line?: string;
  cwd?: string;
}

/** 構築の手順（上から順に、前が成功したときだけ次へ進む）。 */
export function planSteps(raw: OneClickOptions): PlanStep[] {
  const o = normalizeOptions(raw);
  const pkg = PACKAGE_OF[o.network];
  return [
    // 事前の確認: Docker が動いているか・openssl（メインキーを作るのに使う）があるか
    { id: 'docker_up', kind: 'run', line: 'docker info', cwd: '' },
    { id: 'openssl', kind: 'run', line: 'openssl version', cwd: '' },
    { id: 'init', kind: 'run', line: `python3 -m shoestring init --package ${pkg} config.ini`, cwd: o.dir },
    { id: 'config', kind: 'config' },
    { id: 'overrides', kind: 'overrides' },
    { id: 'key', kind: 'run', line: 'openssl genpkey -algorithm ed25519 -out ca.key.pem', cwd: o.dir },
    { id: 'setup', kind: 'run', line: `python3 -m shoestring setup --config ./config.ini --overrides ./overrides.ini --package ${pkg} --directory . --ca-key-path ./ca.key.pem`, cwd: o.dir },
    { id: 'start', kind: 'run', line: 'docker compose up -d', cwd: o.dir },
    { id: 'ps', kind: 'run', line: 'docker compose ps', cwd: o.dir },
  ];
}

/** 停止の手順: 動いているノードを止める（`docker compose down`。止まるまで、最大 5 分かかることがある）。 */
export function planStop(raw: Pick<OneClickOptions, 'dir'>): PlanStep[] {
  const dir = validateSubdir(raw.dir);
  const cwd = dir.ok ? dir.value : raw.dir.trim();
  return [
    { id: 'docker_up', kind: 'run', line: 'docker info', cwd: '' },
    { id: 'down', kind: 'run', line: 'docker compose down', cwd },
  ];
}

/**
 * 更新の手順（公式の「ノードの保守 > ノードソフトウェアのアップデート」の順）: Shoestring を最新（バージョン指定があればその版）にする → ノードを止める → upgrade → 起動し直す → 確認。
 * overrides.ini があるときだけ `--overrides` を付ける（無いノードでも更新できるように）。
 */
export function planUpdate(raw: Pick<OneClickOptions, 'dir'> & { shoestringVersion?: string }, hasOverrides: boolean): PlanStep[] {
  const dir = validateSubdir(raw.dir);
  const cwd = dir.ok ? dir.value : raw.dir.trim();
  // バージョンの指定があれば `symbol-shoestring==<バージョン>`、なければ最新（確かめていない値は、最新として扱う）
  const version = (raw.shoestringVersion ?? '').trim();
  const pkg = version !== '' && PIP_VERSION.test(version) ? `symbol-shoestring==${version}` : 'symbol-shoestring';
  return [
    { id: 'docker_up', kind: 'run', line: 'docker info', cwd: '' },
    { id: 'pip', kind: 'run', line: `python3 -m pip install --upgrade ${pkg}`, cwd: '' },
    { id: 'down', kind: 'run', line: 'docker compose down', cwd },
    { id: 'upgrade', kind: 'run', line: `python3 -m shoestring upgrade --config config.ini --directory .${hasOverrides ? ' --overrides overrides.ini' : ''}`, cwd },
    { id: 'start', kind: 'run', line: 'docker compose up -d', cwd },
    { id: 'ps', kind: 'run', line: 'docker compose ps', cwd },
  ];
}
