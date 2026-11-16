# ノード構築（サービス > ノード）

Bitcoin Core のように、このウォレットから Symbol ノードの環境構築をコマンドで行う機能。
**symbol-bootstrap**・**Shoestring**・**Nodewatch（symbol-node-watcher）** を、画面のターミナルから動かす。

## しくみ

ブラウザのウォレットは、シェルも Docker も触れない。そこで、**同じ PC で別に起動する小さなエージェント**が、ウォレットから届いた「許可されたコマンド」だけを実行して、出力を返す。

```
ウォレット（ブラウザ） ──HTTP + トークン──▶ ノード構築エージェント（127.0.0.1） ──▶ symbol-bootstrap / shoestring / docker …
```

- ウォレットの秘密鍵・ニーモニックは、画面にもエージェントにも渡らない（渡す仕組みが無い）。ノード用の鍵（CA・ノード鍵・ハーベスト鍵）は、各ツールがワークスペースの中に作る。
- ノードの鍵をウォレットのアカウントに結びつけるときも、エージェントから画面へ渡るのは**公開鍵だけ**。リンクの署名は、ウォレット（画面）の中で、ウォレット自身が行う（下の「ウォレットへの鍵の連携」）。
- ブラウザ版（`dist/index.html`）には、エージェントのコードは入らない（`src/server/` は、ビルドにも型チェックにも含まれない）。

## 使い方

エージェントは、公開ページ（GitHub Pages）にも `dist/index.html` にも**入っていない**。ノードを動かす PC に、このリポジトリを取得して、その中で起動する。ウォレット（画面）は、公開ページでも、手元の `dist/index.html` でもよい。

### 準備（最初の 1 回）

1. Node.js 22.12 以上を入れる（`node -v` で確認）。
2. リポジトリを取得して、そのフォルダに入る。
   ```bash
   git clone https://github.com/YUTOpian/IROME-Wallet.git
   cd IROME-Wallet
   ```
   GitHub の「Download ZIP」で取得してもよい（展開したフォルダに `cd` する）。ZIP は、取得した時点の版のまま。更新したいときは、取り直す（`git clone` なら `git pull`）。
3. 依存パッケージを入れる。**`npm run node-agent` の前に、必ず 1 回やる**（`node_modules` が無いと、`tsx: command not found` で止まる）。
   ```bash
   npm ci
   ```

### 起動

```bash
npm run node-agent
```

起動すると、接続先とトークンが表示される。**使っているあいだは、このターミナルを閉じない**（閉じるとエージェントが止まる）。トークンは、起動のたびに変わる。

```
IROME ノード構築エージェント
  接続先 : http://127.0.0.1:7391
  トークン: 3f9c…（この起動だけ有効）
  作業場所: /home/you/irome-node
```

ウォレットの **サービス > ノード** を開き、接続先とトークンを入れて「接続」。公開ページ（https）から `http://127.0.0.1` に繋ぐときは、ブラウザの「ローカルネットワークへのアクセス」の確認が出ることがある（許可する）。

1. 「この PC の環境」で、Docker・Node.js・Python・symbol-bootstrap・Shoestring・Nodewatch の有無を確認する。
2. 無いツールは「入れる」（または `irome install bootstrap | shoestring | nodewatch | node | python`）。作業場所の `tools/` の中に入る（`sudo` は使わない）。
   - symbol-bootstrap・symbol-node-watcher: `npm install --prefix <作業場所>/tools …`
   - Shoestring: `<作業場所>/tools/venv`（Python の仮想環境）に `pip install symbol-shoestring`
   - Node.js・Python: 下の「Node.js・Python・Docker」を見る。
3. 「コマンドのひな型」を押すと入力欄に入る。Enter で実行。

### 常駐させる（ログインで自動起動・落ちたら再起動）

`npm run node-agent` は、ターミナルを閉じると止まる。ノードを動かし続ける PC・サーバーでは、**OS の仕組みに登録**して、ログインしたときに自動で起動し、落ちたら起こし直すようにできる。

```bash
npm run node-agent-service -- install      # 登録して、すぐ起動する
npm run node-agent-service -- status       # 登録と、接続できるかを見る
npm run node-agent-service -- token        # ウォレットに入れるトークンを表示する（--rotate で作り直す）
npm run node-agent-service -- restart      # 再起動する
npm run node-agent-service -- uninstall    # 登録を外す（--purge で、設定とトークンも消す）
```

`install` には、`--port 7400`・`--workspace ~/irome-node`・`--origin https://example.com`（何回でも）を付けられる。もう一度 `install` すると、指定しない項目は前の値を引き継ぎ、トークンは変えない。

| OS | 登録の先 | 動かす権限 |
|---|---|---|
| Linux | systemd のユーザーサービス（`~/.config/systemd/user/irome-node-agent.service`）。ログは `journalctl --user -u irome-node-agent` | いまのユーザー（`sudo` 不要） |
| macOS | launchd の LaunchAgent（`~/Library/LaunchAgents/app.irome.node-agent.plist`）。ログは設定フォルダの `agent.log` | いまのユーザー |
| Windows | タスク スケジューラ（タスク名 `IROME Node Agent`。ログオン時に起動、失敗したら 1 分後に起こし直す） | いまのユーザー（昇格しない） |

- **root・管理者では登録しない**（ウォレットからの操作が、そのまま root・管理者の権限になるため。`npm run node-agent` と同じ決まり）。
- **トークンは、設定フォルダのファイルに 1 回だけ作る。** 常駐させると、起動のたびに変わる使い捨てトークンでは、再起動のたびに貼り直しになるため。場所は、Linux `~/.config/irome-node-agent/agent-token`、macOS `~/Library/Application Support/irome-node-agent/agent-token`、Windows `%APPDATA%\irome-node-agent\agent-token`（フォルダは 700、ファイルは 600）。エージェントはここから読み、**ユニットファイル・plist・ログ・環境変数・`status` には出さない**（`token` だけが、標準出力に出す）。Linux / macOS では、自分以外が読める権限（600 でない）のファイルは、使わずに起動を断る。
- トークンが固定になる分、**漏れたときの影響は長く残る**。ファイルを他人に読ませない・バックアップや共有フォルダに入れない。疑わしいときは `token --rotate`（作り直して、起こし直す。ウォレットには、新しいトークンを入れ直す）。
- 設定は、設定フォルダの `agent.json`（`port` `workspace` `origins` `tokenFile`。知らない項目・型違いは断る）。同じものを手で使うなら `npm run node-agent -- --config <agent.json>`。環境変数があれば、そちらが優先。トークンのファイルだけを使うなら `IROME_NODE_AGENT_TOKEN_FILE`。
- **待ち受けは、これまでどおり 127.0.0.1 だけ。** 常駐させても、外には開けない。別のマシンのノードは、そのマシンで `install` したうえで、手元から SSH のポート転送で繋ぐ（下の「別のマシンのノードを操作する」）。
- 登録に入るのは、起動の引数（`node`・`tsx`・`run.ts`・`agent.json` の場所）と、`install` したときの `PATH`（docker・python などが見つかるように）。**`PATH` を変えたとき（Node.js の入れ替えなど）は、もう一度 `install`**。このリポジトリのフォルダを動かしたときも同じ。`node_modules`（`npm ci`）が無いと、`install` は断る。
- 動かし方そのもの（許可するコマンド・安全のための決まり・pty）は、手で起動したときと同じ。ノードの設定・鍵・データ（作業場所）には、登録も解除も触らない。

**OS ごとの注意**
- **Linux**: ユーザーサービスは、**ログアウトすると止まり、再起動後はログインするまで起動しない**。ログインなしで動かし続けるなら、`loginctl enable-linger $USER` を 1 回（管理者の権限が要ることがある）。`install` は、`Linger=no` のときだけ案内を出す。systemd が無い環境（一部のコンテナ・WSL2 など）では、`install` は断る（tmux・screen の中で `npm run node-agent`）。Docker は、そのユーザーを `docker` グループに入れて使う。
- **macOS**: ログインしている画面のセッション（`gui/<uid>`）に登録する。ssh だけで入っていると、`launchctl bootstrap` が失敗することがある。
- **Windows**: ログオンしたときに起動する。起動のコンソール画面が出て、**閉じるとエージェントが止まる**（最小化しておく）。トークンのファイルの権限（600）は効かないので、`%APPDATA%`（自分のフォルダ）に置く。パスに `"` が入っていると登録できない。
- **未確認**: 実物の systemd・launchd・タスク スケジューラでの登録と起動（`dev-tests/node-service.test.ts` は、偽の実行で「どのコマンドを、どの引数で呼ぶか」と、書いたファイルの中身・権限を確かめるだけ。本物の `run.ts` を `--config` とトークンのファイルで起動して、認証・ログにトークンが出ないことは確かめた）。macOS と Windows の `status` の「登録あり」の表示は、コマンドの終了コードと出力の見かけに頼っている。

### Node.js・Python・Docker

| | 画面からの導入 | 入れる先 | 削除 |
|---|---|---|---|
| Node.js | できる（`irome install node`） | `tools/node` | 画面の「削除」（`irome uninstall node`） |
| Python | できる（`irome install python`） | `tools/python` | 画面の「削除」（`irome uninstall python`） |
| Docker | **できない**（案内だけ） | — | **できない**（OS 側で） |

**Node.js・Python は「専用のコピーを tools/ に足す」もの。** この PC に元から入っていても、足せる（元のものは触らない）。足したあとは、ツールの実行で、`tools/` のものを先に使う（子プロセスの `PATH` の先頭に `tools/node/bin`・`tools/python/bin` を足す）。

- 取得先は、決まったホストの **https だけ**: `nodejs.org`（Node.js）、`api.github.com` と `github.com`・`objects.githubusercontent.com`・`release-assets.githubusercontent.com`（Python）。リダイレクト先も毎回確かめ、それ以外のホスト・http・ポート指定・ユーザー情報つきの URL は断る。リダイレクトは 5 回まで、ダウンロードは 300MB まで。
- **Node.js**: 22.x の最新版を `https://nodejs.org/dist/latest-v22.x/` から取り、同じ場所の `SHASUMS256.txt` の SHA-256 と合ってから展開する。Linux / macOS の x64・arm64 だけ。
- **Python**: [python-build-standalone](https://github.com/astral-sh/python-build-standalone) の最新リリースから、3.12 の最新パッチ（`install_only`）を取り、リリースの `SHA256SUMS` と合ってから展開する。`SHA256SUMS` が無い・ハッシュが無いときは入れない。入れたあと、`--version` と、`venv` `ssl` `pty` が使えることを確かめる。
- ハッシュの確認で防げるのは、転送の破損と、ファイル単体のすり替え。**配布元そのものが侵害された場合は防げない**（GPG 署名までは確かめない）。
- 展開は、固定の引数の `tar`（シェルなし）。一時フォルダ（`tools/.node-tmp-*`）で展開して、確認が済んでから `tools/node`・`tools/python` に入れ替える。失敗したときは、すでに入っているものを壊さない。
- 入れた Python は、Shoestring の venv（`tools/venv`）を作るときと、本物の端末（pty）の補助に先に使う。**先に Python を入れてから Shoestring を入れる**と、venv はその Python で作られる。すでに作った venv は、そのまま（作り直さない）。
- 削除は `tools/node`・`tools/python` だけ。シンボリックリンクなら消さない。作業場所の外を指していても消さない。**`tools/venv`（Shoestring）があるあいだは、Python を消せない**（venv がその Python を使っているため。先に `irome uninstall shoestring`）。
- Windows ネイティブでも入れられる（x64・arm64）。Node.js は `node-vX-win-x64.zip`、Python は python-build-standalone の `…-pc-windows-msvc-install_only.tar.gz`。展開は、標準の `C:\Windows\System32\tar.exe`（zip も読める。Git for Windows の GNU tar は、zip を読めず、`C:` をホスト名と取り違えるので使わない）。Windows 10（1803）以降が要る。入れ先は `tools\node`（直下の `node.exe`・`npm`）と `tools\python`（直下の `python.exe`・`Scripts\`）。Python の確認は `venv` と `ssl` だけ（Windows には `pty`・`termios` が無い）。`tar` が無い環境では、導入できない。

**Docker は、画面から入れない。** Docker の導入は、管理者権限（`sudo` や、Docker Desktop のインストーラー）が要る。このエージェントは、root で起動せず、`sudo` も使わない決まりなので、入れる・消す操作は持たない。「この PC の環境」で Docker が「なし」のとき、公式の手順（Linux: `docs.docker.com/engine/install/`、Mac・Windows: Docker Desktop）を画面に出す。入れたあとに「更新」を押すと、「あり」になる。

### Windows ネイティブ

WSL2 なしの Windows（PowerShell・コマンドプロンプト）で、エージェントを動かせる。使い方は、Linux / macOS と同じ（`npm ci` → `npm run node-agent`）。違いは、次のとおり。

**何を変えたか（Windows のときだけ）**
- **`.cmd` を使わない。** npm が入れる実行ファイルは `symbol-bootstrap.cmd` のような `.cmd` だが、Node.js はシェルなしで `.cmd` を起動できない（CVE-2024-27980 の修正以降、`EINVAL`）。`cmd.exe /c` を通すと `%` や `^` が解釈されてしまうので、通さない。かわりに、パッケージの `package.json` の `bin` が指す JavaScript を、`node.exe` で直接動かす（`node <tools\node_modules\symbol-bootstrap\bin\run> config …`）。`bin` がパッケージの外を指しているものは使わない。PATH に `npm install -g` で入っているものも、同じやり方で見つけて動かす。
- **npm も同じ。** `npm install --prefix …` は、`node.exe npm-cli.js install …` で動かす。`npm-cli.js` は、`tools\node` の npm を先に、なければエージェント自身の node の隣の npm。見つからなければ、`npm.cmd` には逃げず、「先に `irome install node` で…」と案内して止まる。
- **PATH。** 子プロセスの PATH の先頭に、`tools\node_modules\.bin`・`tools\node`・`tools\python`・`tools\python\Scripts` を足す。Windows の環境変数名は大文字・小文字を区別しない（`Path`）ので、`PATH` を別に足さず、元の名前に足す。
- **停止。** 画面の「停止」は、`taskkill /pid <番号> /T /F`（子プロセスごと）。Windows には、`SIGTERM` で「お願いして止める」手段が無いため、強制終了になる。終了コードは 1。
- **管理者で起動しない。** Linux の root と同じ理由で、管理者権限（昇格）で動いていると起動しない（`fltmc` で判定）。通常のターミナルで起動する。どうしても必要なら `IROME_NODE_AGENT_ALLOW_ROOT=1`（非推奨）。
- **ファイル名の決まり。** Windows で別の意味になる名前を、どの OS でも断る（同じ作業場所を両方で使っても、判定が同じになるように）: `:`（ドライブ名・代替データストリーム）・`* ? " < > |`・末尾の `.` と空白・`CON` `PRN` `AUX` `NUL` `COM1〜9` `LPT1〜9`（拡張子つきも）・`PROGRA~1` のような短い名前。あわせて、`tools` `node_modules` `.git` の判定を、大文字・小文字を区別しないようにした（`Tools\` も `tools\` と同じ場所のため。macOS の標準の設定でも同じ）。作業場所の外へ出ない確認も、大文字・小文字と `\` を区別しない比べ方にした。
- **`~`。** 作業場所の `IROME_NODE_AGENT_WORKSPACE` の先頭の `~` は、`\` の前でも、ホームに置き換える。

**Windows で使えない・違うこと**
- **パスワードを聞くコマンドと wizard。** 本物の端末（pty）が使えない（Python の `pty` は Linux / macOS だけ）。画面に注意が出る。`symbol-bootstrap` は `--noPassword`、`encrypt`・`decrypt`・`wizard` は、PowerShell など別のターミナルで直接動かす。ConPTY を使う方法は、まだ入れていない。
- **Docker。** Docker Desktop を入れて、起動しておく（画面からは入れられない）。Docker Desktop の WSL2・Hyper-V の設定は、Docker 側のこと。
- **Shoestring。** 公式がサーバー（Linux）での利用を想定している。Windows ネイティブでの動作は、確かめていない。
- **CPU の負荷の平均**（`loadavg`）は、Windows には無いので出ない。
- ファイルの権限（`0600`）は、Windows では効かない。作業場所は、自分だけが読めるフォルダに置く。

**環境変数の書き方（PowerShell）**
```powershell
$env:IROME_NODE_AGENT_PORT = "7400"
npm run node-agent
```
（コマンドプロンプトは `set IROME_NODE_AGENT_PORT=7400`。Linux / macOS の `VAR=値 npm run …` は、Windows では動かない。）

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
| ディスクの空き（エージェント） | 作業場所のあるドライブの空きが 15% 未満で **注意**、5% 未満で **異常** |
| CPU の使用率（エージェント） | 90% 以上で **注意**、98% 以上で **異常**（直近の測定。Windows では負荷の平均は出ない） |
| 使えるメモリ（エージェント） | 空き（Linux は `MemAvailable`）が 10% 未満で **注意**、5% 未満で **異常** |
| 証明書の期限（エージェント） | 残り 30 日未満で **注意**、7 日未満・期限切れで **異常**（いちばん近いもの。一覧は画面に全部出る） |

- **ディスク・CPU・メモリ・証明書の期限は、エージェントに繋がっているときだけ**見られる（ノードの REST では分からない）。エージェントの `GET /v1/host` が、この PC の数字と、作業場所の中の `*.crt.pem` / `*.cert.pem` の**期限と件名だけ**を返す。鍵（`*.key.pem`）は開かず、証明書のブロックだけを読む。`tools/`・`node_modules`・`.` で始まるフォルダ・シンボリックリンクは見ない。画面は受け取ったものの形と範囲をもう一度確かめる。繋がっていないときは、REST の項目だけ。
- 読むだけ。ウォレットの鍵にも、ノードの設定にも触れない。履歴（レベルや問題が変わった時刻）は、この画面のメモリにだけ置き、保存しない。
- 接続先は、https のノードか、この PC・同じネットワークの http だけ（ウォレットのノード指定と同じ決まり）。
- この画面の表示とグラフは、画面を開いている間だけ。画面を閉じても続く再起動は、下の「常駐の見張り」を使う（Nodewatch の併用も可）。

#### 常駐の見張り（画面を閉じても動く）

エージェントが、画面を閉じていても、ノードの REST を見て、同じ決まり（下の自動再起動と同じ対象・間隔・上限）で `docker compose restart` を流す。画面の「常駐の見張りを始める」で、見る URL・作業フォルダ・間隔（30 秒〜5 分）を保存する。

- **設定は、作業場所の `.irome-watchdog.json`（権限 600）に保存**し、エージェントを再起動しても続く。読み込むときも、毎回、形と範囲を確かめる（壊れている・書き換えられて範囲外なら、オフの既定に戻る）。
- **流すコマンドは固定**（`docker compose restart`）で、設定では変えられない（`PUT /v1/watchdog` は、`enabled` `url` `dir` `intervalSec` 以外を断る）。実行は、画面からのコマンドと同じ許可リストを通る。見る先は、https のノードか、この PC・同じネットワークの http だけ。
- 画面側の自動再起動とは**二重に動かない**（見張りがオンの間は、画面側は止まる）。
- 記録（始めた・再起動した・失敗・見送り・あきらめた・正常に戻った）は、エージェントのメモリに最新 50 件。エージェントを再起動すると消える。
- **エージェント自体が落ちたら、見張りも止まる。** エージェントは `npm run node-agent-service -- install` で常駐させ、落ちたら起こし直す設定にしておく。
- **通知（任意）**: Webhook（Slack・Discord など）を設定すると、**再起動した・失敗した・あきらめた・正常に戻った**ときに、短い文（`text` と `content` の両方を入れた JSON）を POST する。文には、見ているノードのホスト名だけを入れ、URL の本体・作業場所のパス・鍵は入れない。
  - 送り先は **https のみ**。IP アドレス・`localhost`・「.」の無い名前・`.local` / `.internal`・ユーザー名つきは断る（エージェントが、この PC や社内の機器へ送らないように）。リダイレクトは辿らない。8 秒で諦める。
  - Webhook の URL は秘密なので、`.irome-watchdog.json`（600）にだけ保存し、**`GET /v1/watchdog` には返さない**（設定済みかと送り先のホスト名だけ）。保存のときに省略すると、いまの設定を残す。空で消す。
  - 送れなかったときは、記録に「通知を送れませんでした」を 1 行残すだけで、見張りは続く。
- **作業フォルダの自動検出**: 画面の「探す」で、作業場所の中から、compose ファイル（`docker-compose.yml/.yaml`・`compose.yml/.yaml`）のあるフォルダを探して候補に出す（`GET /v1/compose-dirs`）。名前だけを見て、中身は開かない。`tools/`・`node_modules`・「.」で始まるフォルダ・シンボリックリンク・深さ 4 より下は見ない（復旧用の `docker-compose-recovery.yaml` も候補にしない）。

#### 止まったときの自動再起動

「止まったとき、自動で再起動する」をオンにすると、エージェントに繋がっている間、決まりに沿って `docker compose restart`（指定した作業フォルダ。空欄は作業場所の直下）を流す。流せるのは、これまでと同じ許可リストの形だけ。

- **対象**: ブロックの高さが 10 分動かない（止まり・異常）・API / DB が落ちている・REST に繋がらない。「注意」だけの問題（遅れ・ピア 0・ディスク・CPU・メモリ・証明書）では動かさない（再起動では直らないため）。
- **止まり**はすぐ、**落ちている・繋がらない**は 2 回続けて見えたときに動かす。
- **1 回動かしたら 10 分は空ける。** 直らないまま 3 回動かしたら、やめて画面に知らせる。正常に戻ると回数は 0 に戻る。
- 別のコマンドが動いていて流せないときは、回数に数えず、次の巡回でもう一度。
- 記録は画面のメモリにだけ置く（保存しない）。コマンドの内容は、画面から変えられない。
- ノード側が CORS を許している必要がある（symbol-bootstrap・Shoestring の REST は既定で許している）。公開ページ（GitHub Pages）から `http://127.0.0.1` を見るときは、ブラウザの「ローカルネットワークへのアクセス」の確認が出ることがある。

### ウォレットの接続先に登録

状態ウォッチで「正常に動いている」ノード（`apiNode` / `db` が `up`）が見えているとき、画面に **「ウォレットの接続先に登録」** が出る。

- **登録だけ**: 見ているノードを、ウォレットの接続先の一覧（設定 > ノード）に入れる。使うノードは変えない。別のネットワーク（メインネット ⇄ テストネット）のノードなら、そのネットワークの一覧に入れる（いまのネットワークは変えない）。
- **登録して使う**: 登録して、このノードにつなぐ。別のネットワークのノードなら、ネットワークも切り替える（設定 > ノードで接続するときと同じ決まり。閲覧用・SSS のプロファイルは、アドレスのネットワークが決まっているので切り替えられない）。mijin のノードは、こちらだけ（ネットワークの設定を読み取るため）。
- 接続先は、https のノードか、この PC・同じネットワークの http だけ。エージェントには繋がっていなくても使える。
- 同期が終わっていないノードを「使う」にすると、残高や履歴が古く見えることがある。ウォッチの「高さの差」が小さくなってから使うとよい。

### ウォレットへの鍵の連携（ノード鍵・ハーベスト鍵・投票鍵）

`symbol-bootstrap link` や `updateVotingKeys` は、**ノードの main アカウント**の鍵でリンクを送る。ウォレットのアカウントにノードの鍵を結びつけるには、ウォレット側の画面で、ウォレットの鍵で署名する。そのための導線が、画面の **「ウォレットに連携」** カード。

1. `symbol-bootstrap config` などで、作業場所に `target/addresses.yml` ができている状態にする。
2. 「ウォレットに連携」の **「ノードの鍵を読み込む」** を押す。エージェントが、作業場所の `target/addresses.yml`（作業場所の直下か、その下のフォルダの `target/`）を読み、**公開鍵だけ**を返す。
3. 次の 3 つの公開鍵が出る。
   | 画面の名前 | addresses.yml | リンクの種類 |
   |---|---|---|
   | ノード鍵 | `transport` の `publicKey` | NodeKeyLink |
   | ハーベスト鍵 | `remote` の `publicKey` | AccountKeyLink（リモート） |
   | VRF 鍵 | `vrf` の `publicKey` | VrfKeyLink |
4. 投票鍵（32 バイト＝64 文字の公開鍵。symbol-sdk の `VotingPublicKey`）は、次の順に探して自動で入る。見つからなければ、貼り付ける。**空のままでも進める**（投票鍵はリンクしない）。
   - 投票鍵の木のファイル（`private_key_tree*.dat`。symbol-bootstrap でも Shoestring でも同じ形式）の**先頭 80 バイトのヘッダ**。ルートの投票公開鍵と、有効な**エポックの範囲**が入っている。公開鍵と一緒に範囲も、ウォレットの「投票鍵」の欄に入る（範囲を変えると、ノードが投票できなくなることがある）。更新で足した別の木があれば、期間が新しい順に並べて、選べる。
   - `addresses.yml` の `voting` の `publicKey`（あれば。この場合、期間は入らない）。
5. **「ウォレットのキーリンクへ進む」** で、ウォレットの「ハーベスト > キーリンク」が開き、入力欄に公開鍵が入る（投票鍵は、同じ画面の下の「投票鍵」の欄）。ここから先は、これまでのキーリンクの画面と同じ。内容の確認 → パスワード → 送信。ノードから渡されたものも、確認なしには送られない。

- 渡すのは**メモリの中だけ**（`src/store/nodeKeysStore.ts`。保存しない）。リンクされたら、渡された分は消える。「取り込みをやめる」でも消せる。
- エージェントが返すもの: `GET /v1/node-keys` → `{ nodes: [{ name, source, main, node, remote, vrf, voting, votings: [{ key, start, end }] }] }`。**どの項目にも秘密鍵は入らない**（`publicKey:` の行だけを読み、`privateKey:` の行の値は取り込まない。返す形にも入れ場所が無い）。画面は受け取ったものの形と長さをもう一度確かめ、定義に無い項目は捨てる。
- 通常の「ノードの鍵を読み込む」で読む場所は、作業場所の中の `target/addresses.yml`（256KB まで）と、証明書（`node.crt.pem` など。64KB まで）だけ。`tools/`・`node_modules`・`.` で始まるフォルダ・シンボリックリンクは見ない。Shoestring の鍵ファイルは、下の「鍵ファイルから読む」を押したときだけ読む。
- 注意:
  - ノードがハーベストするには、そのノードが**リモート鍵・VRF 鍵の秘密鍵を持っている**必要がある。symbol-bootstrap が作ったノードは、すでに持っている。
  - 同じ種類のリンクがすでにあるときは、「付け替え」（いまのリンクを外して、新しいものをリンク）になる。1 つの種類に、リンクは 1 つだけ。
  - Shoestring の作業場所には、通常 `addresses.yml` が無い。その場合、エージェントは**証明書**（作業場所の中の `node.crt.pem`（なければ `node.full.crt.pem`）と、同じフォルダの `ca.crt.pem` / `ca.cert.pem`）から、**ノード鍵**（証明書の Ed25519 公開鍵）と、表示用の main の公開鍵だけを返す。鍵ファイル（`*.key.pem`）は開かない。**ハーベスト鍵（remote）・VRF 鍵・投票鍵の公開鍵は証明書に入っていない**ので、この経路では出ない（ハーベスト > キーリンクに直接入れる。投票鍵は、ターミナルの出力からの候補か、貼り付けで渡せる）。同じノード鍵が `addresses.yml` にもあるときは、`addresses.yml` のほうだけを出す。
  - **Shoestring の「鍵ファイルから読む」**: 証明書にはノード鍵しか入っていないので、ハーベスト鍵（remote）と VRF 鍵の公開鍵は、**秘密鍵のファイルを開いて**取り出す。確認のダイアログで「読む」を押したときだけ動く（エージェントは、`POST /v1/node-keys/shoestring` に `confirm: true` が付いていないと読まない。通常の読み込み `GET /v1/node-keys` は、鍵ファイルを開かない）。
    - 読むファイル: `remote.key.pem` `vrf.key.pem` `node.key.pem`（`.key` の無い名前も可）と、`config-harvesting.properties` の `harvesterSigningPrivateKey`（リモート）・`harvesterVrfPrivateKey`（VRF）。作業場所の中を探し、`cert/` `keys/` `userconfig/resources/` は、1 つ上のフォルダと同じノードとして、証明書から読んだノードに重ねる。CA の鍵（`ca.key.pem`）は読まない。
    - 秘密鍵は、公開鍵を作った時点で捨てる。HTTP の返事にも、画面にも、ログにも出ない（返事の本文に秘密鍵が無いことを、テストで確かめている）。暗号化された PEM と、Ed25519 でない PEM は開かず、その旨を画面に出す（パスワードは聞かない）。`tools/`・`node_modules`・`.` で始まるフォルダ・シンボリックリンクは見ない。
    - **投票鍵（bootstrap・Shoestring 共通）**: 木のファイルの先頭 80 バイトだけを読む（`src/server/node-agent/votingTrees.ts`）。その先に続く、エポックごとの子の秘密鍵は読まないので、確認のダイアログは要らず、通常の「ノードの鍵を読み込む」で読む。ファイルは名前（`private_key_tree*.dat`）で、作業場所の中を探す（深さ 8 まで。`tools/`・`node_modules`・`.` で始まるフォルダ・シンボリックリンクは見ない）。どのノードのものかは、`target/nodes/<名前>/…` なら同じ名前の `addresses.yml` のノード、Shoestring なら証明書のあるフォルダ（`cert/` の 1 つ上）の同じノードに重ねる。どれにも合わなければ、投票鍵だけのノードとして出る。
    - **未確認**: 木のファイルの並び（0..8 開始エポック・8..16 終了エポック・32..64 ルートの投票公開鍵）は、symbol-sdk の `VotingKeysGenerator` が作るファイルに基づく。実物の symbol-bootstrap・Shoestring が作るファイルの置き場所は、名前で探すので、見つからなければ貼り付ける。
  - **投票鍵の長さ**: Symbol の投票公開鍵は 32 バイト（64 文字）。以前の画面は 96 文字（BLS の大きさ）を求めていて、symbol-sdk が書き込めないため、投票鍵のリンクは署名で必ず失敗していた。64 文字に直した（`votingKeys.ts` `tx.ts`）。あわせて、署名で `models.VotingPublicKey` のオブジェクトを渡すと SDK 3.3.3 が失敗していたのを、16 進文字列で渡すようにした。手数料の見積り（`votingLinkSize`）も、1 件 96 バイトに直した。
    - **未確認**: 実物の Shoestring が作る鍵ファイルの名前・置き場所は、想定（上の名前）に基づく。見つからないときは「鍵ファイルが見つかりませんでした」と出る。
  - `addresses.yml` には、ノードの秘密鍵が入っている（`--noPassword` のとき）。このため、「設定ファイル」の欄では `target/addresses.yml` と `target/addresses/` を**開けない・書けない**（大文字小文字違い・サブフォルダ・シンボリックリンク経由でも断る）。作業場所の直下など、`target/` の外の同名ファイルは、これまでどおり開ける。`config-harvesting.properties` にも秘密鍵が入っているが、こちらは設定ファイルとして開ける（共有 PC では開かない）。

### アンインストール（削除）

「この PC の環境」で、「入れる」で入れたツールの横に出る **「削除」** で消せる（または `irome uninstall bootstrap | shoestring | nodewatch | node | python`）。押すと、注意を読んでチェックを入れるまで実行できない確認が出る（ターミナルに `irome uninstall …` と打った場合も同じ）。

- 消えるのは、作業場所の `tools/` に入れたものだけ。symbol-bootstrap・symbol-node-watcher は `npm uninstall --prefix <作業場所>/tools …`、Shoestring は `tools/venv` をまるごと削除（venv に自分で足したパッケージも消える。`tools/venv` がシンボリックリンクなら消さない）。
- 消えないもの: ノードの設定ファイル、鍵（CA・ノード鍵・ハーベスト鍵）、ブロックチェーンのデータ（`target/` など）、Docker のコンテナ・イメージ、ウォレットの秘密鍵・ニーモニック。
- 先にノードを止めておく。削除すると、そのツールの `stop` `clean` などが打てなくなり、Docker のコンテナだけが動き続けることがある。
- PATH や pip・npm のグローバルに入っているもの（`tools/` の外）は、画面からは消せない（「この PC 全体に入っているため、ここでは削除できません」と出る）。Docker は、この画面からは消せない（OS 側のやり方で）。この PC に元からある Node.js・Python も、ここでは消せない（消せるのは、ここで `tools/` に足したものだけ）。

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

- 先に、symbol-bootstrap 本体を新しい版にする。公式の手順は、`git clone https://github.com/symbol/symbol-bootstrap.git` → `npm install` → `npm run build` → `npm pack --ignore-scripts` → `npm install -g symbol-bootstrap-1.1.13.tgz`（`EACCES` が出たら `sudo`）。
  - **画面からは `irome upgrade bootstrap`**: この手順を、`-g` も `sudo` も使わず、作業場所の `tools/` の中だけで行う（取得先は公式リポジトリに固定。画面から別の取得先・版は指定できない）。npm の公開版は、公式の版に追いついていないことがあるため、公式の手順どおり、ソースからビルドする。PC に **`git` が要る**（無ければ、何もせず、そう案内して止まる）。`tools/` に symbol-bootstrap が入っていなければ、先に `irome install bootstrap`。できた `.tgz` は `tools/packages/symbol-bootstrap.tgz` に残す（`tools/package.json` が指すため。あとで `irome install nodewatch` などをしても、元の版に戻らない）。取得用の作業フォルダ（`tools/.upgrade`）は、終わったら消す。
  - PC に `npm install -g` で入れている symbol-bootstrap（`tools/` の外）は、この画面からは更新しない。そちらは、上の公式の手順を、ターミナルで行う。
- 入れたら、画面で `symbol-bootstrap --version` を打って、版を確認する。
- ノードのディレクトリ（作業フォルダ）で、`stop` → `start -d --upgrade`。`start` には、最初に使ったオプション（`-p mainnet -a dual` など）を同じように付ける。

### Shoestring でノードを建てる手順

画面の **「Shoestring でノードを建てる手順」** に、Shoestring 公式ドキュメント（インストール / ノードの作成と実行 / ノードの保守）の順番で、説明とひな型を並べている（`src/lib/node/shoestringGuide.ts`・`src/pages/node/ShoestringGuide.tsx`）。ひな型は、押すと入力欄に入るだけ（実行は Enter）。説明は、エージェントに繋がっていなくても読める。先頭に、番号なしの「Shoestring とは（概要）」（何をするツールか・symbol-bootstrap との違い・基本の流れ・Docker が前提であること）がある。

| 手順 | やること | 主なひな型 |
|---|---|---|
| 1. 必要なもの | Python 3.10 以降・Docker（Compose v2）・OpenSSL。ノードの種類ごとの CPU・RAM・ディスク | `docker --version` `docker compose version` |
| 2. インストール | 公式: `python3 -m pip install symbol-shoestring` → `python3 -m shoestring --help`。この画面の「入れる」（`irome install shoestring`）は、`tools/venv` に入れる別の方法 | `irome install python` `python3 -m pip install symbol-shoestring` `irome install shoestring` `python3 -m shoestring --help` `python3 -m shoestring init --help`（更新は 14 の「ノードをアップデートする」） |
| 3. 作業フォルダ | ノード専用のフォルダ（公式の例は `symbol-node`）を、画面の「作業フォルダ」に入れる | — |
| 4. init | ネットワークの標準設定から `config.ini` を作る | `shoestring init --package mainnet config.ini`（テストネットは `sai`）。ウィザードを使うなら `shoestring wizard`（wizard を有効にしたとき） |
| 5. config.ini | `[node]` の `features`（PEER / API / HARVESTER / VOTER）・`caCommonName`・`nodeCommonName`・`apiHttps` | 「config.ini を開く」ボタン |
| 6. overrides.ini | `host`（ほかのノードから届く公開 IP かホスト名）・`friendlyName` | 「ひな形を入れる」ボタン（保存は自分で） |
| 7. ノードの ID | `ca.key.pem`（メインキー）。新しく作る（`openssl genpkey`）／`pemtool` で取り込む。`pemview` でアドレスを見る。Bootstrap の鍵は `import-bootstrap` | `openssl genpkey -algorithm ed25519 -out ca.key.pem` ほか |
| 8. setup | ディレクトリ構造・証明書・Docker の設定・（ハーベスティングなら）`linking_transaction.dat` を作る | `shoestring setup --config ./config.ini --overrides ./overrides.ini --package mainnet --directory . --ca-key-path ./ca.key.pem` |
| 9. ハーベスティング（任意） | 資金（通常 1 XYM）→ `signer` → `announce-transaction` → ブラウザで `{ノードの URL}/transactionStatus/{ハッシュ}` を確認 | `shoestring signer …` `shoestring announce-transaction …` |
| 10. 投票（任意） | VOTER・3,000,000 XYM 以上。投票キーは最大 180 日 | — |
| 11. 起動 | `ca.key.pem` をオフラインへ移し、ノードの PC からは消す。`docker compose up -d` | `docker compose up -d` |
| 12. 確認 | `health`・`docker compose ps` / `ps -a`・ログ（`docker compose logs --tail=50` / `logs -f`）。初回の同期は 24〜48 時間 | `python3 -m shoestring health --config config.ini --directory .` |
| 13. 復旧 | `.lock` の復旧（`docker compose -f docker-compose-recovery.yaml up --abort-on-container-exit`）。最終手段は `reset-data` | 同左・`shoestring reset-data …` |
| 14. ノードをアップデートする | 公式の「ノードの保守 > ノードソフトウェアのアップデート」の順: ① `python3 -m pip install --upgrade symbol-shoestring`（最新版。`python3 -m pip show symbol-shoestring` で確認）→ ② `docker compose down` → ③ `python3 -m shoestring upgrade --config config.ini --directory . --overrides overrides.ini` → ④ `docker compose up -d` → `docker compose ps -a` で確認。`irome upgrade shoestring` は、`tools/venv` の Shoestring を ① と同じに最新にする別の方法 | 同左 |
| 15. 保守 | `renew-certificates`（375 日）・`renew-voting-keys`（180 日）・バックアップ（`config.ini` `ca.key.pem` `overrides.ini`） | `python3 -m shoestring renew-certificates …` ほか（公式のコマンドと、`--retain-node-key` つきの 2 つ） |

- **用途を絞って通すもの**（以前は「別のターミナルで」としていた）: `openssl version` と `openssl genpkey -algorithm ed25519 -out <名前>.pem`（作業フォルダの中の `.pem` だけ。パス・先頭の `-`・別のアルゴリズム・ほかのオプションは通さない。**同じ名前のファイルがあれば上書きせず止まる**（`ca.key.pem` を消さないため）。できたら権限を 600 にする）、`docker compose -f docker-compose-recovery.yaml up [--abort-on-container-exit]`（`-f` で通すのは、この**ファイル名 1 つだけ**。ほかのファイル・`down` などの別の操作は通さない）、`irome upgrade shoestring`（`tools/venv` の `pip install --upgrade symbol-shoestring`。`tools/venv` が無ければ何もせず、先に `irome install shoestring` を案内）、`irome upgrade bootstrap`（公式の手順で `tools/` の symbol-bootstrap を新しい版にする）、`irome upgrade nodewatch`（`tools/` の symbol-node-watcher を `npm install --prefix tools symbol-node-watcher@latest` で最新にする。入っていなければ、先に `irome install nodewatch` を案内。ほかの対象は通さない）、`shoestring wizard`（Shoestring の `python -m shoestring.wizard` に置き換えて動かす。**画面で wizard を有効にしたときだけ**。引数は付けられない）。
- **この画面で通さないままのもの**: `python3 -m shoestring` と下の pip の 3 つの形以外の `python3 -m …`（任意のモジュールを動かせるため）、上の形以外の `openssl`（`x509` `enc` `s_client` など。`pkey` も、下の 1 つの形以外は通さない）、上の 1 つ以外の `docker compose -f`。
- 公式の `python3 -m shoestring <コマンド>`（`python` でも同じ）は、そのまま入力しても通る。`shoestring <コマンド>`（`tools/venv` の Shoestring）に読み替えて、同じ許可の判定にかける（`--show-private` は確認のポップアップを通したときだけ、`wizard` は有効にしたときだけ、なども同じ）。`-m` の相手が `shoestring` のときだけで、`python3 -m shoestring.wizard`・`python3` 単体は通さない。
- 公式の **`python3 -m pip install symbol-shoestring` / `python3 -m pip install --upgrade symbol-shoestring` / `python3 -m pip show symbol-shoestring`** の 3 つの形は、そのまま通る（`python` でも同じ）。パッケージ名は `symbol-shoestring` に固定で、ほかのパッケージ・版の指定（`==`）・オプション（`--user` `-r` `--index-url` など）・`uninstall` `download` は通さない（`pip_usage` で断る）。エージェントは、`tools/venv` があればその Python の pip、なければ PC の `python3`（Windows は `python`）の pip で動かす。
- 公式の `docker compose logs --tail=50`（`--tail=<秒数・数>` の `=` つきの形）・`docker compose logs -f`・`docker compose ps` も、そのまま通る。
- 「設定ファイル」の欄のパスは、作業場所（`~/irome-node` など）からの相対。作業フォルダが `symbol-node` なら `symbol-node/config.ini`。手順のボタンは、作業フォルダに合わせて入れる。
- `shoestring pemview` は、ふだんは鍵のアドレスと公開鍵を出すだけ。秘密鍵を出す `--show-private` は、**確認のポップアップで同意したときだけ**通す（`pemview` でも、ほかのツールでも同じ。下の「秘密鍵が画面に出るコマンドの確認」）。

#### 秘密鍵が画面に出るコマンドの確認

- 対象は 2 つ: **`--show-private`**（`shoestring pemview … --show-private` など。`--show-private=1` の形も同じ）と、**`openssl pkey -in <名前>.pem -text`**（`-noout` を付けてもよい）。実行すると、秘密鍵が画面（ターミナル）に出る。
- どちらも、**実行しようとすると確認のポップアップが出る**（入力欄に打っても、ひな型から入れても同じ）。実行するコマンドが表示され、画面共有・録画・コピーの注意を読んで、チェックを入れたときだけ「秘密鍵を表示して実行する」が押せる。「やめる」なら、何も実行しない。
- エージェントも画面を信用しない。ジョブの要求に同意の印（`secret: true`）が無ければ、`secret_confirm_required` で断る。形そのものが許されないもの（`openssl pkey -in ../x.pem -text`、`-out` や `-passin` つきなど）は、同意があっても通さない。
- `openssl pkey` が読むのは、作業フォルダの中の `.pem` の**普通のファイルだけ**。シンボリックリンクは辿らない（作業場所の外の鍵を、リンク越しに読ませないため）。`-out`（ファイルへの書き出し）は通さない。
- 秘密鍵が出たジョブは、終わったあとに画面へ「画面を消してください」と知らせる。エージェントのメモリに残る出力も、終了の 30 秒後に消える（画面が読み終える時間を置くため）。履歴に残るのはコマンドの行だけで、鍵は残らない。
- 画面の「ひな型」にも、確認が出る旨の説明つきで入っている（Shoestring の欄: `… pemview … --show-private`、`openssl pkey -in ca.key.pem -text`）。

#### `mkdir` と `cd`（作業フォルダ）

- **`mkdir [-p] <名前>`**: 作業フォルダの中にフォルダを作る（シェルは使わず、エージェントが作る）。`-p` が無いときは、本物の `mkdir` と同じに、親が無い・すでにあるときは断る。`-p` なら、途中も作り、すでにあれば何もしない。権限は 700。名前は作業フォルダからの相対パスだけ（`..`・絶対パス・ドライブ名・Windows で別の意味になる名前は通さない）。途中がシンボリックリンクなら辿らず、`tools/`・`node_modules`・`.git` の中には作らない。
- **`cd [<フォルダ>]`**: 画面の「作業フォルダ」を変えるだけ（エージェントには送らない）。`cd` と `cd ~` は作業場所の直下、`cd ..` は 1 つ上、`cd 名前` は今のフォルダの中。作業場所より上・絶対パスは通さない。フォルダが実際にあるかは見ない（作業フォルダは、次に実行するときに無ければ自動で作られる）。
- 使えるのは、この 2 つの形だけ。`pwd` `ls` `rm` などは通さない。
- ハーベスティング・投票の手順のあとで、ノードの鍵をウォレットのアカウントに結びつけるには、上の「ウォレットへの鍵の連携」を使う。

### 例: Shoestring（コマンドだけ）

```
shoestring init --package sai config.ini      # テストネット
shoestring init --package mainnet config.ini  # メインネット
shoestring setup --config ./config.ini --overrides ./overrides.ini --package mainnet --directory . --ca-key-path ./ca.key.pem
shoestring health --config config.ini --directory .
```

`config.ini` の編集（features・caCommonName など）と `overrides.ini` の作成は、画面の「設定ファイル」で行える（下の節）。

### 設定ファイルの編集

画面の「設定ファイル」で、作業場所の中のファイルを開いて、編集・保存できる（新しいパスを入れて保存すれば、新規作成）。

- 対象は `.ini` `.yml` `.yaml` `.json` `.properties` `.txt` だけ（256KB まで）。鍵ファイル（`.pem` など）、`target/addresses.yml` と `target/addresses/` の中、`tools/` と `node_modules` の中、`.` で始まるファイルは開けない。
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
- **wizard（対話式の設定）は、画面で「有効」にしたときだけ使える**（下の「wizard の設定」）。無効のあいだは、画面もエージェントも `symbol-bootstrap wizard` と `shoestring wizard` を断る（`wizard_disabled`）。
- 「停止」は、コマンドのプロセスグループに SIGTERM を送る（終了コードは 143）。コマンドが終わったら、端末を握ったままの別のプロセスがいても、残りの出力を読んで終える。

## wizard の設定（簡易ターミナル）

`symbol-bootstrap wizard` のような選択式の画面は、再描画のたびに「カーソルを上へ戻す・行を消す」エスケープ列を使う。エスケープ列を消して文字だけ出すと、同じ行が何度も重なって出てしまう。そこで、wizard のときだけ、生の出力を受け取り、画面の中の**簡易ターミナル**で描き直す。

- 設定: 画面の「ターミナル」の上の「wizard（対話式の設定）を有効にする」。**初期値は無効**。このブラウザにだけ保存する（`localStorage` の `irome-node-settings`）。コマンドの実行中は切り替えられない。
- 無効のとき: wizard は実行できない（画面でも、エージェントでも断る）。簡易ターミナルも使わない。ほかのコマンドは、これまでどおり。
- 有効のとき: `symbol-bootstrap wizard` と `shoestring wizard` を実行できる。出力はエスケープ列つきの生のまま届き（`TERM=xterm-256color`）、簡易ターミナルが、カーソル移動・行の消去を反映した「いまの画面」の文字列にして出す。実行中は、**入力欄が空なら、矢印キー・Space・Enter がそのままキーとして送られる**（ターミナルの下の ↑ ↓ ← → Enter Space Tab のボタンでも送れる）。文字を入れる質問には、入力欄に打って Enter。
- 簡易ターミナルが描く範囲: 文字・改行・全角文字、カーソル移動（`CSI A B C D E F G H d`、`ESC 7 8`、`CSI s u`、`ESC M`）、消去（`CSI J K X`）、行・文字の挿入と削除（`CSI L M @ P`）。色や太字は出さない（読み捨てる）。代替画面・マウス・端末への問い合わせの返事は、扱わない。実装は `src/lib/node/termEmu.ts`。
- エージェント側: `POST /v1/jobs` の本文に、`wizard: true`（wizard を通す）と `emulate: true`（生の出力で返す）を足せる。`wizard: true` でなければ `symbol-bootstrap wizard` は `command_rejected`（`wizard_disabled`）で断る。`emulate: true` が効くのは、`wizard` を有効にした `symbol-bootstrap wizard` の実行だけ（ほかのコマンドは、これまでどおり整形済み）。返事の `raw` が `true` のとき、出力は生。古いエージェント・端末（pty）が使えない環境では `raw` が付かず、整形済みの出力になる。
- 端末（pty）が使えない環境（Windows ネイティブ、`python3` が無い、`IROME_NODE_AGENT_PTY=0`）では、wizard は正しく動かない（画面に注意を出す）。

## 実行できるコマンド

`src/lib/node/nodeCommands.ts` が決まり。画面でも事前に判定し、**エージェントは画面を信用せず、必ず同じ判定をもう一度かける**。

| ツール | 許すもの |
|---|---|
| `symbol-bootstrap` | `config` `compose` `run` `start` `stop` `clean` `healthCheck` `resetData` `report` `verify` `updateVotingKeys` `link` `pack` `encrypt` `decrypt`、`--help` `--version`。`wizard` は、画面で有効にしたときだけ |
| `shoestring` | `init` `setup` `upgrade` `health` `import-bootstrap` `import-harvesters` `renew-certificates` `renew-voting-keys` `reset-data` `pemtool` `pemview` `signer` `announce-transaction` `min-cosignatures-count`、`--help`。`python3 -m shoestring …` でも同じ |
| `python3 -m pip` | `install symbol-shoestring` / `install --upgrade symbol-shoestring` / `show symbol-shoestring` の 3 つだけ |
| `symbol-node-watcher` | `start [config]` `stop` |
| `docker` | 見る系: `--version` `version` `info` `ps` `logs` `stats --no-stream` `compose version/ps/logs`。運用: `start` `stop` `restart`（`-t 秒`）・`rm`・`pull`（対象の指定が必須）、`compose up` `down` `start` `stop` `restart` `pull`（サービス名は任意）。`run` `exec` `cp` `build` `compose run/exec/config` は通さない |
| `node` | `--version` だけ |
| `irome install` / `irome uninstall` | `bootstrap` / `shoestring` / `nodewatch` / `node` / `python`（エージェントが固定の手順で実行。uninstall は `tools/` の中だけ）。`irome upgrade shoestring`（`tools/venv` の Shoestring を `pip install --upgrade symbol-shoestring` で最新にする）・`irome upgrade bootstrap`（公式の手順 `git clone` → `npm install` → `npm run build` → `npm pack --ignore-scripts` → `npm install` を、`tools/` の中だけで行う。`git` が要る。取得先は公式リポジトリに固定）・`irome upgrade nodewatch`（`tools/` の symbol-node-watcher を `@latest` で入れ直す）。ほかの対象・版の指定は通さない |

通さないもの: シェルの記号（`| ; & > < $ \``）、任意のコマンド。確認のポップアップを通したときだけ通すもの: 秘密鍵を画面に出す `--show-private` と `openssl pkey -in <名前>.pem -text`。用途を絞って通すもの（`openssl` の 3 つの形・`mkdir` / `cd`・復旧用の `docker compose -f`・`shoestring wizard`）は、下の「Shoestring でノードを建てる手順」と、このあとの注記を参照。
シェルは使わず、引数の配列をそのまま実行ファイルに渡す。

> `docker run -v /:/host …` のような 1 行は、ホスト全体を触れるので通さない。docker で通すのは、見る系と、既にあるコンテナ・compose の起動/停止/再起動/削除/イメージの更新だけ。
>
> - 通さないフラグ: `compose -f`（**復旧用の `-f docker-compose-recovery.yaml up …` の 1 つだけは通す**）・`--project-directory`（別の compose ファイルを指す）、`down -v` / `--rmi`（ボリューム・イメージの削除）、`rm -f` / `-v`、`--privileged` など。`docker compose` は、**実行する作業フォルダ**（画面の「作業フォルダ」。symbol-bootstrap なら `target/docker`）の compose ファイルだけを使う。
> - compose ファイル（`docker-compose.yml`・`compose.yaml` など）は、「設定ファイル」の画面から書き換えられない（任意のマウントや特権を書いて `compose up` する経路をふさぐため）。symbol-bootstrap が作ったものを動かす。
> - 起動・停止は、これまでどおり `symbol-bootstrap run/stop`・Shoestring でもできる。画面の「Docker」のひな型から、`docker compose up -d` / `down` / `restart` / `pull` も使える。
> - **実物の Docker では確認していない**（判定の単体テストだけ）。

## 安全のための決まり（エージェント）

- 待ち受けは **127.0.0.1 だけ**。`Host` が `127.0.0.1` / `localhost` 以外なら断る（DNS リバインディング対策）。
- 起動のたびに作る **ランダムなトークン**（`Authorization: Bearer`）が無い要求は断る。トークンは保存しない（常駐させたときだけ、設定フォルダの自分だけが読めるファイルに保存する。上の「常駐させる」）。ウォレット側も、画面を閉じる・再読み込みすると消える。
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
| `IROME_NODE_AGENT_TOKEN_FILE` | なし | トークンをファイルから読む（Linux / macOS は 600 のとき。32 文字以上。`IROME_NODE_AGENT_TOKEN` があればそちらが優先）。常駐化が使う |
| `IROME_NODE_AGENT_ALLOW_ROOT` | なし | `1` で root 起動を許す（非推奨） |
| `IROME_NODE_AGENT_PTY` | 自動 | `0` で、本物の端末（pty）を使わない（パイプだけにする） |

### 別のマシンのノードを操作する

エージェントは 127.0.0.1 だけで待ち受け、ウォレットも `localhost` 系の接続先しか受け付けない。サーバーのノードを操作するときは、サーバーで `npm run node-agent` を起動し、手元からポート転送する。

```bash
ssh -L 7391:127.0.0.1:7391 you@your-server
```

そのうえで、ウォレットには `http://127.0.0.1:7391` を入れる。

サーバーで動かし続けるなら、サーバーで `npm run node-agent-service -- install` を 1 回実行する（上の「常駐させる」）。ポート転送は、手元から繋ぐたびに必要なまま（エージェントは外に開かない）。

## 動作環境

- Node.js 22.12 以上（エージェント）。Docker（symbol-bootstrap・Shoestring のノードの実行）。Shoestring には Python 3 と `venv` が要る。
- **Linux / macOS / Windows（ネイティブ）**。Windows は「Windows ネイティブ」の節を見る（pty なし・`.cmd` を使わない動かし方）。WSL2 の中で起動してもよい（その場合は Linux として動く）。
- Shoestring は、公式がサーバー（Linux）での利用を想定している。macOS・Windows の手元の PC では、symbol-bootstrap（Docker Desktop）のほうが扱いやすい。

## テスト

- `npx tsx dev-tests/node-host.test.ts` … ディスク・CPU・メモリ・証明書の期限（しきい値・受け取りの検証・本物の証明書の読み取り・鍵を読まない・エージェントの HTTP。32 項目）
- `npx tsx dev-tests/node-watch.test.ts` … ノードの状態ウォッチ（判定・しきい値・URL の決まり・REST の読み取りを偽の fetch で・タイムアウト。42 項目）
- `npx tsx dev-tests/node-commands.test.ts` … 許可・拒否の判定（234 項目）
- `npx tsx dev-tests/node-narrow-allow.test.ts` … 用途を絞って通すもの（openssl の 3 つの形（pkey は確認つき）・`--show-private` の確認・`mkdir` / `cd`・復旧用の `docker compose -f`・`irome upgrade shoestring` / `bootstrap` / `nodewatch`・`shoestring wizard`）の許可と拒否、上書きしない・権限 600・`tools/venv` が無いときは何もしない・bootstrap の更新の手順（git clone → install → build → pack → `tools/` に入れる。`-g` と `sudo` を使わない・`.tgz` は 1 つのときだけ・シンボリックリンクは辿らない）（131 項目）
- `npx tsx dev-tests/node-shoestring-guide.test.ts` … 「Shoestring でノードを建てる手順」（手順のひな型がすべて許可の判定を通る・通さないものは通らない・`pemview` と `--show-private`・説明文が ja / en に揃っている・手順の順番。206 項目）
- `npx tsx dev-tests/node-windows.test.ts` … Windows ネイティブ対応（OS の種類を引数で渡して、Linux 上で Windows の分岐を確かめる。パスの内外・環境変数の二重・`package.json` の `bin` の探し方と外へ出る指定の拒否・`.cmd` を使わない手順・Windows 向けの配布物の入れ方・予約名やドライブ名の拒否・`Tools\` の大文字小文字。141 項目）。**本物の Windows での起動・停止・展開は、ここでは確かめられない**
- `npx tsx dev-tests/node-provision.test.ts` … Node.js・Python の導入と削除（取得先の決まり・リダイレクト・サイズ上限・SHA-256 の一致/不一致・壊れた tar・既存の `tools/` を壊さない・一時フォルダの片づけ・シンボリックリンクを辿らない・venv があるあいだは Python を消さない。75 項目）。外部には繋がず、偽の fetch と本物の `tar` で確認する。
- `npx tsx dev-tests/node-service.test.ts` … エージェントの常駐化（systemd・launchd・タスク スケジューラの登録ファイルの中身と、呼ぶコマンド・設定ファイルとトークンのファイルの権限・root と制御文字と `tsx` 無しの拒否・再登録でトークンを変えない・トークンの作り直し・解除と `--purge`・本物の `run.ts` を `--config` で起動して、トークンのファイルの認証と、ログにトークンが出ないこと。98 項目）
- `npx tsx dev-tests/node-shoestring-keys.test.ts` … Shoestring の鍵ファイルからの公開鍵の取り出し（確認なしでは読まない・秘密鍵が返事の本文に出ない・暗号化された PEM・`tools/` とシンボリックリンクを見ない・証明書のノードに重ねる。28 項目）
- `npx tsx dev-tests/node-keys.test.ts` … ノードの鍵の連携（`addresses.yml` から公開鍵だけを読む・秘密鍵が結果にもエージェントの返事にも出ない・長さ違いを捨てる・`tools/` とシンボリックリンクと `target/` の外を読まない・認証・画面側の再検証・渡し先のストア。38 項目）
- `npx tsx dev-tests/node-voting-trees.test.ts` … 投票鍵の木のファイルの先頭ヘッダから公開鍵と期間を読む（本物の `VotingKeysGenerator` のファイルで確認・子の秘密鍵が返事に出ない・bootstrap と Shoestring の置き場所・新しい期間が先・`tools/` とシンボリックリンクと小さなファイルを見ない・64 文字の鍵が投票鍵リンクの署名まで通り、手数料のサイズが実物と一致する。30 項目）
- `npx tsx dev-tests/node-agent.test.ts` … 本物の HTTP で、認証・Origin・Host・ジョブの実行/入力/停止/上限/出力の上限と、設定ファイルの読み書き（シンボリックリンクで外へ出ない確認を含む）、アンインストール（`tools/venv` の削除・設定と鍵が残る・シンボリックリンクは消さない）、画面側クライアント（`agentClient.ts`）、本物の端末（pty: パスワード入力・エコーなし・終了コード・停止・エスケープ列の除去・pty を切った動き・キー送信）を確認（130 項目）。外部ツールは使わない（`docker` などは、テスト用の node スクリプトに差し替える）。

コード: `src/lib/node/nodeKeys.ts`（公開鍵の取り出し・投票鍵のヘッダの解析）、`src/server/node-agent/votingTrees.ts`（投票鍵の木のファイルのヘッダの読み取り）、`src/store/nodeKeysStore.ts`（渡し先）、`src/pages/harvest/KeyLinkPanel.tsx` `VotingKeyPanel.tsx`（受け取って入力欄に入れる）、`src/lib/node/nodeWatch.ts`（状態ウォッチの判定）、`src/pages/node/NodeWatchCard.tsx`（その画面）、`src/lib/node/nodeCommands.ts`（許可の決まり）、`src/lib/node/agentClient.ts`（画面側の接続）、`src/server/node-agent/agent.ts`・`run.ts`（エージェント）、`src/server/node-agent/provision.ts`（Node.js・Python の導入と削除）、`src/server/node-agent/platform.ts`（OS ごとの違い）、`src/pages/node/NodePage.tsx`（画面）、`src/lib/node/shoestringGuide.ts`・`src/pages/node/ShoestringGuide.tsx`（Shoestring の手順）。
