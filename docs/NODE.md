# ノード構築（サービス > ノード）

Bitcoin Core のように、このウォレットから Symbol ノードの環境構築をコマンドで行う機能。
**symbol-bootstrap**・**Shoestring**・**Nodewatch（symbol-node-watcher）** を、画面のターミナルから動かす。

## しくみ

ブラウザのウォレットは、シェルも Docker も触れない。そこで、**同じ PC で別に起動する小さなエージェント**が、ウォレットから届いた「許可されたコマンド」だけを実行して、出力を返す。

```
ウォレット（ブラウザ） ──HTTP + トークン──▶ ノード構築エージェント（127.0.0.1） ──▶ symbol-bootstrap / shoestring / docker …
```

- ウォレットの秘密鍵・ニーモニックは、画面にもエージェントにも渡らない（渡す仕組みが無い）。ノード用の鍵（CA・ノード鍵・ハーベスト鍵）は、各ツールがワークスペースの中に作る。
- ブラウザ版（`dist/index.html`）には、エージェントのコードは入らない（`src/server/` は、ビルドにも型チェックにも含まれない）。

## 使い方

```bash
npm ci
npm run node-agent
```

起動すると、接続先とトークンが表示される。

```
IROME ノード構築エージェント
  接続先 : http://127.0.0.1:7391
  トークン: 3f9c…（この起動だけ有効）
  作業場所: /home/you/irome-node
```

ウォレットの **サービス > ノード** を開き、接続先とトークンを入れて「接続」。

1. 「この PC の環境」で、Docker・Node.js・Python・symbol-bootstrap・Shoestring・Nodewatch の有無を確認する。
2. 無いツールは「入れる」（または `irome install bootstrap | shoestring | nodewatch`）。作業場所の `tools/` の中に入る（`sudo` は使わない）。
   - symbol-bootstrap・symbol-node-watcher: `npm install --prefix <作業場所>/tools …`
   - Shoestring: `<作業場所>/tools/venv`（Python の仮想環境）に `pip install symbol-shoestring`
3. 「コマンドのひな型」を押すと入力欄に入る。Enter で実行。

### ノードの状態ウォッチ

画面の「ノードの状態（ウォッチ）」で、自分のノードの REST（既定 `http://127.0.0.1:3000`。symbol-bootstrap・Shoestring の既定）を、10 / 30 / 60 秒ごとに見て、**正常 / 注意 / 異常** を出す。ブラウザから REST を直接読むだけなので、**エージェントに繋がっていなくても使える**。エージェントに繋がっているときは、Docker のコンテナの状態（`docker ps -a` の読み取り）も並べて出す。

| 見るもの | 判定 |
|---|---|
| `/node/health` | `apiNode` / `db` が `up` でなければ **異常** |
| REST に繋がらない | **異常**（ノードが止まっている、URL・ポートが違う、CORS が許されていない） |
| `/chain/info` の高さ | 3 分変わらなければ **注意**、10 分で **異常**（高さが戻ったときも「変わった」扱い） |
| ウォレットが使っているノードとの差（任意） | 10 ブロック遅れで **注意**、100 で **異常**。ネットワークが違う（メインネット / テストネット）ときは、比べない |
| ファイナライズ | 最新ブロックとの差が 2160 ブロック（3 エポック）以上で **注意** |
| `/node/peers` | 接続が 0 なら **注意** |

- 読むだけ。ウォレットの鍵にも、ノードの設定にも触れない。履歴（レベルや問題が変わった時刻）は、この画面のメモリにだけ置き、保存しない。
- 接続先は、https のノードか、この PC・同じネットワークの http だけ（ウォレットのノード指定と同じ決まり）。
- この画面を開いている間だけ見る。常時の監視と、止まったときの自動の再起動は、Nodewatch（symbol-node-watcher）を使う。
- ノード側が CORS を許している必要がある（symbol-bootstrap・Shoestring の REST は既定で許している）。公開ページ（GitHub Pages）から `http://127.0.0.1` を見るときは、ブラウザの「ローカルネットワークへのアクセス」の確認が出ることがある。

### ウォレットの接続先に登録

状態ウォッチで「正常に動いている」ノード（`apiNode` / `db` が `up`）が見えているとき、画面に **「ウォレットの接続先に登録」** が出る。

- **登録だけ**: 見ているノードを、ウォレットの接続先の一覧（設定 > ノード）に入れる。使うノードは変えない。別のネットワーク（メインネット ⇄ テストネット）のノードなら、そのネットワークの一覧に入れる（いまのネットワークは変えない）。
- **登録して使う**: 登録して、このノードにつなぐ。別のネットワークのノードなら、ネットワークも切り替える（設定 > ノードで接続するときと同じ決まり。閲覧用・SSS のプロファイルは、アドレスのネットワークが決まっているので切り替えられない）。mijin のノードは、こちらだけ（ネットワークの設定を読み取るため）。
- 接続先は、https のノードか、この PC・同じネットワークの http だけ。エージェントには繋がっていなくても使える。
- 同期が終わっていないノードを「使う」にすると、残高や履歴が古く見えることがある。ウォッチの「高さの差」が小さくなってから使うとよい。

### アンインストール（削除）

「この PC の環境」で、「入れる」で入れたツールの横に出る **「削除」** で消せる（または `irome uninstall bootstrap | shoestring | nodewatch`）。押すと、注意を読んでチェックを入れるまで実行できない確認が出る（ターミナルに `irome uninstall …` と打った場合も同じ）。

- 消えるのは、作業場所の `tools/` に入れたものだけ。symbol-bootstrap・symbol-node-watcher は `npm uninstall --prefix <作業場所>/tools …`、Shoestring は `tools/venv` をまるごと削除（venv に自分で足したパッケージも消える。`tools/venv` がシンボリックリンクなら消さない）。
- 消えないもの: ノードの設定ファイル、鍵（CA・ノード鍵・ハーベスト鍵）、ブロックチェーンのデータ（`target/` など）、Docker のコンテナ・イメージ、ウォレットの秘密鍵・ニーモニック。
- 先にノードを止めておく。削除すると、そのツールの `stop` `clean` などが打てなくなり、Docker のコンテナだけが動き続けることがある。
- PATH や pip・npm のグローバルに入っているもの（`tools/` の外）は、画面からは消せない（「この PC 全体に入っているため、ここでは削除できません」と出る）。Docker・Node.js・Python も、この画面からは消せない（OS 側のやり方で）。

### 例: symbol-bootstrap でテストネットのノード

```
symbol-bootstrap config -p testnet -a dual --noPassword
symbol-bootstrap compose
symbol-bootstrap run -d
symbol-bootstrap healthCheck
```

`config` のひな型は、テストネット用（`-p testnet`）とメインネット用（`-p mainnet -c custom-preset.yml`）の 2 つ。メインネット用は、設定ファイル `custom-preset.yml` を、画面の「設定ファイル」で作業フォルダに先に作っておく（`-c` のパスは、実行する作業フォルダからの相対）。`--noPassword` を付けると鍵が暗号化されずに `target/` に残るので、メインネットでは、鍵の保管（バックアップとアクセス権）を確認する。作業フォルダ（画面の「作業フォルダ」）を変えると、`target/` の置き場所も変わる（symbol-bootstrap は、実行した場所の `target/` に作る）。

### 例: symbol-bootstrap のアップグレード（1.1.13 など）

```
symbol-bootstrap --version
symbol-bootstrap stop
symbol-bootstrap start -p mainnet -a dual -d --upgrade
```

- 先に、symbol-bootstrap 本体を新しい版にする。公式の手順は、`git clone https://github.com/symbol/symbol-bootstrap.git` → `npm install` → `npm run build` → `npm pack --ignore-scripts` → `npm install -g symbol-bootstrap-1.1.13.tgz`（`EACCES` が出たら `sudo`）。`git` と `npm pack` と `npm install -g` は、この画面のコマンドでは通らないので、ターミナルで行う。
- 入れたら、画面で `symbol-bootstrap --version` を打って、版を確認する。
- ノードのディレクトリ（作業フォルダ）で、`stop` → `start -d --upgrade`。`start` には、最初に使ったオプション（`-p mainnet -a dual` など）を同じように付ける。

### 例: Shoestring

```
shoestring init config.ini --package sai      # テストネット
shoestring init config.ini --package mainnet  # メインネット
shoestring setup --config config.ini --ca-key-path ca.key.pem
shoestring health --config config.ini
```

`config.ini` の編集（features・caPassword など）は、画面の「設定ファイル」で行える（下の節）。

### 設定ファイルの編集

画面の「設定ファイル」で、作業場所の中のファイルを開いて、編集・保存できる（新しいパスを入れて保存すれば、新規作成）。

- 対象は `.ini` `.yml` `.yaml` `.json` `.properties` `.txt` だけ（256KB まで）。鍵ファイル（`.pem` など）、`tools/` と `node_modules` の中、`.` で始まるファイルは開けない。
- パスは作業場所の中の相対パスだけ。`..`・絶対パス・シンボリックリンク経由で外へ出る指定は、エージェントが断る。保存したファイルの権限は、所有者だけ（600）。
- `caPassword` などの秘密が入るファイルは、画面（ブラウザのメモリ）を通る。共有 PC では使わない。

### Nodewatch

`symbol-node-watcher`（npm のコミュニティ製）を指す。ブロック高が他のノードと離れたら、ノードを止めて起動し直し、Discord に知らせる。設定ファイル（`config.json`）が要る。`symbol-node-watcher start [config.json のパス]` / `stop`。

### 実行中のコマンドに入力する

実行中は、入力欄の記号が `>` になり、入力した内容がコマンドの入力へ送られる（パスワードの確認など）。「パスワードとして入力する」を入れると、画面に出さない。

**本物の端末（pty）で動かす。** `symbol-bootstrap` `shoestring` `symbol-node-watcher` の、画面から打ったコマンドは、エージェントが端末の中で動かす。パスワードを聞くコマンド（鍵を暗号化するための入力など）も動く。パスワードを入力しても、端末が画面に返さない。

- 仕組み: `python3 -c <小さな補助>` が `pty.fork()` で端末を作り、その中でコマンドを動かす。ネイティブの追加パッケージは要らない。シェルは通さず、引数の配列をそのまま渡す（許可リストの判定は、これまでと同じ）。`docker` と `irome install / uninstall` は、これまでどおりパイプ。
- 使える条件: Linux / macOS で、`python3` の `pty` が読み込めること（画面の状態の `pty`）。Windows ネイティブ・`python3` が無い環境では、これまでどおりパイプで動く（パスワードを聞くコマンドは、うまく動かないことがある。`--noPassword` のように、聞かせない書き方にする）。`IROME_NODE_AGENT_PTY=0` で、使わない設定にもできる。
- 出力は、エスケープ列（色・カーソル移動）を消し、改行をそろえて画面に出す。端末の幅は 120 桁、高さは 40 行。`TERM=dumb`。
- **wizard（対話式の設定）は、画面で「有効」にしたときだけ使える**（下の「wizard の設定」）。無効のあいだは、画面もエージェントも `symbol-bootstrap wizard` を断る（`wizard_disabled`）。
- 「停止」は、コマンドのプロセスグループに SIGTERM を送る（終了コードは 143）。コマンドが終わったら、端末を握ったままの別のプロセスがいても、残りの出力を読んで終える。

## wizard の設定（簡易ターミナル）

`symbol-bootstrap wizard` のような選択式の画面は、再描画のたびに「カーソルを上へ戻す・行を消す」エスケープ列を使う。エスケープ列を消して文字だけ出すと、同じ行が何度も重なって出てしまう。そこで、wizard のときだけ、生の出力を受け取り、画面の中の**簡易ターミナル**で描き直す。

- 設定: 画面の「ターミナル」の上の「wizard（対話式の設定）を有効にする」。**初期値は無効**。このブラウザにだけ保存する（`localStorage` の `irome-node-settings`）。コマンドの実行中は切り替えられない。
- 無効のとき: wizard は実行できない（画面でも、エージェントでも断る）。簡易ターミナルも使わない。ほかのコマンドは、これまでどおり。
- 有効のとき: `symbol-bootstrap wizard` を実行できる。出力はエスケープ列つきの生のまま届き（`TERM=xterm-256color`）、簡易ターミナルが、カーソル移動・行の消去を反映した「いまの画面」の文字列にして出す。実行中は、**入力欄が空なら、矢印キー・Space・Enter がそのままキーとして送られる**（ターミナルの下の ↑ ↓ ← → Enter Space Tab のボタンでも送れる）。文字を入れる質問には、入力欄に打って Enter。
- 簡易ターミナルが描く範囲: 文字・改行・全角文字、カーソル移動（`CSI A B C D E F G H d`、`ESC 7 8`、`CSI s u`、`ESC M`）、消去（`CSI J K X`）、行・文字の挿入と削除（`CSI L M @ P`）。色や太字は出さない（読み捨てる）。代替画面・マウス・端末への問い合わせの返事は、扱わない。実装は `src/lib/node/termEmu.ts`。
- エージェント側: `POST /v1/jobs` の本文に、`wizard: true`（wizard を通す）と `emulate: true`（生の出力で返す）を足せる。`wizard: true` でなければ `symbol-bootstrap wizard` は `command_rejected`（`wizard_disabled`）で断る。`emulate: true` が効くのは、`wizard` を有効にした `symbol-bootstrap wizard` の実行だけ（ほかのコマンドは、これまでどおり整形済み）。返事の `raw` が `true` のとき、出力は生。古いエージェント・端末（pty）が使えない環境では `raw` が付かず、整形済みの出力になる。
- 端末（pty）が使えない環境（Windows ネイティブ、`python3` が無い、`IROME_NODE_AGENT_PTY=0`）では、wizard は正しく動かない（画面に注意を出す）。

## 実行できるコマンド

`src/lib/node/nodeCommands.ts` が決まり。画面でも事前に判定し、**エージェントは画面を信用せず、必ず同じ判定をもう一度かける**。

| ツール | 許すもの |
|---|---|
| `symbol-bootstrap` | `config` `compose` `run` `start` `stop` `clean` `healthCheck` `resetData` `report` `verify` `updateVotingKeys` `link` `pack` `encrypt` `decrypt`、`--help` `--version`。`wizard` は、画面で有効にしたときだけ |
| `shoestring` | `init` `setup` `upgrade` `health` `import-bootstrap` `import-harvesters` `renew-certificates` `renew-voting-keys` `reset-data` `pemtool` `signer` `announce-transaction` `min-cosignatures-count`、`--help` |
| `symbol-node-watcher` | `start [config]` `stop` |
| `docker` | `--version` `version` `info` `ps` `logs` `stats --no-stream` `compose version/ps/logs` だけ（`run` `exec` `rm` `compose up` などは通さない） |
| `node` | `--version` だけ |
| `irome install` / `irome uninstall` | `bootstrap` / `shoestring` / `nodewatch`（エージェントが固定の手順で実行。uninstall は `tools/` の中だけ） |

通さないもの: 秘密鍵を画面に出す `--show-private`、シェルの記号（`| ; & > < $ \``）、任意のコマンド。
シェルは使わず、引数の配列をそのまま実行ファイルに渡す。

> `docker run -v /:/host …` のような 1 行は、ホスト全体を触れるので、docker は「見る系」だけにしてある。ノードの起動・停止は、symbol-bootstrap と Shoestring が内部で docker compose を呼ぶ。

## 安全のための決まり（エージェント）

- 待ち受けは **127.0.0.1 だけ**。`Host` が `127.0.0.1` / `localhost` 以外なら断る（DNS リバインディング対策）。
- 起動のたびに作る **ランダムなトークン**（`Authorization: Bearer`）が無い要求は断る。トークンは保存しない。ウォレット側も、画面を閉じる・再読み込みすると消える。
- `Origin` が許可リストに無い要求は断る。既定は `file://`（`"null"`）・`https://yutopian.github.io`・`localhost` / `127.0.0.1` の http。足すときは `IROME_NODE_AGENT_ORIGINS=https://example.com,…`。
- **root では起動しない**（ウォレットからの操作が root の権限になってしまうため）。Docker は、一般ユーザーを `docker` グループに入れて使う。
- 同時に動かせるコマンドは 3 つまで。出力は 1 MB まで（古い側から捨てる）。リクエストの本文は 64 KB まで。
- 作業フォルダは、作業場所の中の相対パスだけ（`..`・絶対パスは断る）。

### 環境変数

（改名前の `KASANE_NODE_AGENT_*` / `KASANE_DAO_BOT_*` も、当面は同じ意味で読む。同じ名前の `IROME_` があれば、そちらが優先。作業場所は、改名前の `~/kasane-node` がすでにあって `~/irome-node` がないときだけ、そちらを使い続ける。）

| 変数 | 既定 | 内容 |
|---|---|---|
| `IROME_NODE_AGENT_PORT` | `7391` | 待ち受けるポート（1024〜65535） |
| `IROME_NODE_AGENT_WORKSPACE` | `~/irome-node` | 作業場所（`tools/` と、コマンドの実行場所） |
| `IROME_NODE_AGENT_ORIGINS` | なし | 許可する Origin を足す |
| `IROME_NODE_AGENT_TOKEN` | ランダム | 固定する（32 文字以上）。貼り直しは減るが、漏れたときの影響が長く残る |
| `IROME_NODE_AGENT_ALLOW_ROOT` | なし | `1` で root 起動を許す（非推奨） |
| `IROME_NODE_AGENT_PTY` | 自動 | `0` で、本物の端末（pty）を使わない（パイプだけにする） |

### 別のマシンのノードを操作する

エージェントは 127.0.0.1 だけで待ち受け、ウォレットも `localhost` 系の接続先しか受け付けない。サーバーのノードを操作するときは、サーバーで `npm run node-agent` を起動し、手元からポート転送する。

```bash
ssh -L 7391:127.0.0.1:7391 you@your-server
```

そのうえで、ウォレットには `http://127.0.0.1:7391` を入れる。

## 動作環境

- Node.js 22.12 以上（エージェント）。Docker（symbol-bootstrap・Shoestring のノードの実行）。Shoestring には Python 3 と `venv` が要る。
- **Linux / macOS**。Windows は、**WSL2 の中**で `npm run node-agent` を起動する（npm の `.cmd` を、シェルなしでは実行できないため）。
- Shoestring は、公式がサーバー（Linux）での利用を想定している。macOS・Windows の手元の PC では、symbol-bootstrap（Docker Desktop）のほうが扱いやすい。

## テスト

- `npx tsx dev-tests/node-watch.test.ts` … ノードの状態ウォッチ（判定・しきい値・URL の決まり・REST の読み取りを偽の fetch で・タイムアウト。42 項目）
- `npx tsx dev-tests/node-commands.test.ts` … 許可・拒否の判定（157 項目）
- `npx tsx dev-tests/node-agent.test.ts` … 本物の HTTP で、認証・Origin・Host・ジョブの実行/入力/停止/上限/出力の上限と、設定ファイルの読み書き（シンボリックリンクで外へ出ない確認を含む）、アンインストール（`tools/venv` の削除・設定と鍵が残る・シンボリックリンクは消さない）、画面側クライアント（`agentClient.ts`）、本物の端末（pty: パスワード入力・エコーなし・終了コード・停止・エスケープ列の除去・pty を切った動き・キー送信）を確認（130 項目）。外部ツールは使わない（`docker` などは、テスト用の node スクリプトに差し替える）。

コード: `src/lib/node/nodeWatch.ts`（状態ウォッチの判定）、`src/pages/node/NodeWatchCard.tsx`（その画面）、`src/lib/node/nodeCommands.ts`（許可の決まり）、`src/lib/node/agentClient.ts`（画面側の接続）、`src/server/node-agent/agent.ts`・`run.ts`（エージェント）、`src/pages/node/NodePage.tsx`（画面）。
