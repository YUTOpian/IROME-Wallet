// 「Shoestring でノードを建てる手順」の中身（画面は pages/node/ShoestringGuide.tsx）。
// Shoestring 公式ドキュメント（インストール / ノードの作成と実行 / ノードの保守）の順番に沿って、
// 各手順に「説明（i18n）」と「コマンドのひな型」を持たせる。
//
// 決まり:
// - `lines` は、画面から実行できるひな型。必ず nodeCommands.ts の COMMAND_PRESETS にもあること（説明文はそちらの noteKey を使う。
//   許可の判定を通ることは、dev-tests/node-shoestring-guide.test.ts で確かめる）。
// - `terminalOnly` は、この画面では実行できない（許可していない）ので、説明として見せるだけの行。押しても入力欄には入らない。
//   今は、すべての行が画面から実行できる（用途を絞って許可した: openssl は version と ed25519 の鍵づくりだけ、`-f` は復旧用の
//   docker-compose-recovery.yaml だけ、`irome upgrade shoestring`、`shoestring wizard`（wizard を有効にしたときだけ）。nodeCommands.ts 冒頭）。
//   この画面で通さないものを説明するときのために、`terminalOnly` の仕組みは残してある。

export interface GuideStep {
  /** i18n のキーの後ろ（service.node_ss_<id>_title / _body）と、画面の目印 */
  id: string;
  /** 必要なときだけ行う手順（ハーベスト・投票） */
  optional?: boolean;
  /** 画面から実行できるひな型（COMMAND_PRESETS にある行） */
  lines?: readonly string[];
  /** 説明として見せるだけの行（この画面では実行しない） */
  terminalOnly?: readonly string[];
  /** 設定ファイルの例（見せるだけ） */
  snippet?: string;
  /** 「設定ファイル」の欄に、この内容を入れるボタン（保存は、使う人が押す） */
  fileTemplate?: { name: string; content: string };
  /** 「設定ファイル」の欄で、作業フォルダの config.ini を開くボタン */
  openConfig?: boolean;
}

/** config.ini の [node] セクションで、自分のノード用に変える値（公式の例）。 */
export const CONFIG_NODE_SNIPPET = `[node]
features = PEER | API
caCommonName = My Symbol Node CA
nodeCommonName = My Symbol Node
apiHttps = false
`;

/** overrides.ini のひな型（公式の例）。host は、ほかのノードから届く公開 IP かホスト名に変える。 */
export const OVERRIDES_TEMPLATE = `[node.localnode]
host = my-symbol-node.com
friendlyName = My Symbol Node
`;

export const SHOESTRING_STEPS: readonly GuideStep[] = [
  { id: 'req', lines: ['docker --version', 'docker compose version', 'node --version', 'openssl version'] },
  { id: 'install', lines: ['irome install python', 'python3 -m pip install symbol-shoestring', 'irome install shoestring', 'python3 -m shoestring --help', 'python3 -m shoestring init --help'] },
  { id: 'workdir' },
  { id: 'init', lines: ['python3 -m shoestring init --package mainnet config.ini', 'python3 -m shoestring init --package sai config.ini', 'shoestring wizard'] },
  { id: 'config', snippet: CONFIG_NODE_SNIPPET, openConfig: true },
  { id: 'overrides', snippet: OVERRIDES_TEMPLATE, fileTemplate: { name: 'overrides.ini', content: OVERRIDES_TEMPLATE } },
  {
    id: 'identity',
    lines: ['openssl genpkey -algorithm ed25519 -out ca.key.pem', 'python3 -m shoestring pemtool --output ca.key.pem', 'python3 -m shoestring pemview --input ca.key.pem --network mainnet', 'python3 -m shoestring import-bootstrap --config config.ini --bootstrap ../bootstrap-node/target --include-node-key'],
  },
  {
    id: 'setup',
    lines: [
      'python3 -m shoestring setup --config ./config.ini --overrides ./overrides.ini --package mainnet --directory . --ca-key-path ./ca.key.pem',
      'python3 -m shoestring setup --config ./config.ini --overrides ./overrides.ini --package sai --directory . --ca-key-path ./ca.key.pem',
      'python3 -m shoestring setup --config ./config.ini --overrides ./overrides.ini --package mainnet --directory . --ca-key-path ./ca.key.pem --output-transaction-only',
    ],
  },
  {
    id: 'harvest',
    optional: true,
    lines: [
      'python3 -m shoestring signer --config config.ini --ca-key-path ca.key.pem --save linking_transaction.dat',
      'python3 -m shoestring announce-transaction --config config.ini --transaction linking_transaction.dat',
    ],
  },
  { id: 'voting', optional: true },
  { id: 'start', lines: ['docker compose up -d'] },
  { id: 'verify', lines: ['python3 -m shoestring health --config config.ini --directory .', 'docker compose ps', 'docker compose ps -a', 'docker compose logs --tail=50', 'docker compose logs -f'] },
  {
    id: 'recovery',
    lines: ['docker compose down', 'docker compose -f docker-compose-recovery.yaml up --abort-on-container-exit', 'python3 -m shoestring reset-data --config ./config.ini --directory .'],
  },
  {
    // ノードのアップデート（公式ドキュメント「ノードの保守 > ノードソフトウェアのアップデート」の順）: Shoestring を上げる → ノードを止める → upgrade → 起動し直す → 確認
    id: 'upgrade',
    lines: ['python3 -m pip install --upgrade symbol-shoestring', 'python3 -m pip show symbol-shoestring', 'docker compose down', 'python3 -m shoestring upgrade --config config.ini --directory . --overrides overrides.ini', 'docker compose up -d', 'docker compose ps -a', 'irome upgrade shoestring'],
  },
  {
    id: 'maintain',
    lines: [
      'python3 -m shoestring renew-certificates --config config.ini --directory . --ca-key-path ca.key.pem',
      'python3 -m shoestring renew-certificates --config config.ini --directory . --ca-key-path ca.key.pem --retain-node-key',
      'python3 -m shoestring renew-voting-keys --config config.ini --directory .',
    ],
  },
];
