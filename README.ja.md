# vastai-mcp

[English README](README.md)

[vast.ai](https://vast.ai) の GPU マーケットプレイスを、AI エージェント向けに **ワークフロー単位** で抽象化した
[MCP](https://modelcontextprotocol.io) サーバーです。

`vastai` CLI をラップ **しません**。CLI の内部実装（[vast-ai/vast-python](https://github.com/vast-ai/vast-python) の
`vast.py`）を読んで REST エンドポイントを抽出し、直接叩いています。Python もサブプロセスも不要です。
また CLI コマンドを 1 対 1 で写すのではなく、エージェントが実際にやりたいこと、すなわち
「このイメージで動くマシンを用意して SSH の接続先を教えて」「そこでこのコマンドを実行して」「終わったら消して」
を単位にツールを設計しています。

```text
vast_launch ─┬─ アカウントに SSH 公開鍵を登録（未登録なら）
             ├─ POST /bundles/          GPU / 価格 / 地域 … でオファー検索
             ├─ PUT  /asks/{offer}/     インスタンス作成
             ├─ GET  /instances/{id}/   actual_status == running までポーリング
             │        └─ exited / offline / タイムアウト時は DELETE して次のオファーで再試行
             └─ ssh probe               鍵で SSH 接続できるまで待機
```

## 必要なもの

- Node.js 20 以上
- vast.ai の API キー（[console.vast.ai/manage-keys](https://console.vast.ai/manage-keys/)）
- `vast_run` / `vast_copy_file` を使うなら SSH 鍵ペア（公開鍵は `vast_launch` が自動でアカウントに登録します）

## インストール

```bash
git clone https://github.com/ActiveTK/vastaiMCP.git
cd vastaiMCP
npm install      # prepare スクリプトで dist/ がビルドされます
```

### Claude Code

```bash
claude mcp add vastai -e VAST_API_KEY=your_key -- node /path/to/vastaiMCP/dist/index.js
```

### Claude Desktop などの MCP クライアント

```json
{
  "mcpServers": {
    "vastai": {
      "command": "node",
      "args": ["/path/to/vastaiMCP/dist/index.js"],
      "env": {
        "VAST_API_KEY": "your_key",
        "VAST_SSH_KEY": "C:/Users/you/.ssh/id_ed25519"
      }
    }
  }
}
```

[examples/mcp-config.json](examples/mcp-config.json) も参照してください。

## 設定（環境変数）

| 変数 | 既定値 | 用途 |
| --- | --- | --- |
| `VAST_API_KEY` | `~/.vast_api_key` の内容 | API キー（CLI と同じフォールバック） |
| `VAST_URL` | `https://console.vast.ai` | API のベース URL |
| `VAST_SSH_KEY` | `~/.ssh/id_ed25519`, `id_rsa`, `id_ecdsa` の最初に見つかったもの | `vast_run` / `vast_copy_file` / SSH 疎通確認に使う秘密鍵 |
| `VAST_SSH_PUBLIC_KEY` | `<VAST_SSH_KEY>.pub` | 起動前にアカウントへ登録する公開鍵（パスまたは文字列） |
| `VAST_SSH_PASSPHRASE` | – | 秘密鍵のパスフレーズ |
| `VAST_RETRY` | `6` | HTTP 429 時のリトライ回数（指数バックオフ。200 台規模の fleet で効く） |
| `VAST_MCP_STATE_DIR` | `~/.vastai-mcp/fleets` | fleet の状態（期限、インスタンス id）の保存先 |

## ツール一覧

| ツール | 内容 |
| --- | --- |
| `vast_account` | API キーの検証、残高、使用中の SSH / API 設定の表示 |
| `vast_gpu_names` | フィルタに使える正確な GPU モデル名 |
| `vast_search_offers` | 構造化フィルタ（GPU、VRAM、価格上限、地域、信頼度、帯域 …）による検索。CLI 構文の `raw_query` も併用可 |
| **`vast_launch`** | **検索 → 作成 → running 待機 → SSH 疎通待機。失敗時は次のオファーへ自動フォールバック。** イメージ / テンプレート、ディスク、環境変数、ポート、onstart スクリプト、jupyter/ssh/args、入札価格、ボリュームに対応 |
| `vast_list_instances` | 全インスタンスの状態・価格・SSH 接続先と、稼働中の時間単価合計 |
| `vast_instance` | 単一インスタンスの詳細（状態メッセージ、SSH コマンド、公開ポート、Jupyter URL、環境変数） |
| `vast_wait_instance` | `running` / `stopped` になるまで待機。終端状態の検知とタイムアウト付き |
| `vast_instance_control` | start / stop / reboot（結果の状態になるまで待機可） |
| `vast_destroy` | id 指定、または `all=true` + 状態 / ラベルのフィルタ（例: running 以外を全部）で破棄。一括 DELETE と一覧での検証付き |
| `vast_update_instance` | ラベル変更、スポットインスタンスの入札額変更 |
| `vast_logs` | コンテナ / ホストデーモンのログ（tail、フィルタ） |
| `vast_ssh_keys` | アカウント鍵の list / add / delete、稼働中インスタンスへの attach / detach |
| `vast_run` | SSH 経由でシェルコマンドを実行（stdout、stderr、終了コード、タイムアウト） |
| `vast_copy_file` | SFTP でファイルをアップロード / ダウンロード |
| `vast_api_execute` | vast の API 経由で `ls` / `rm` / `du`（SSH 不要） |
| `vast_templates` | テンプレート検索（PyTorch、vLLM、ComfyUI …）。`template_hash` を `vast_launch` に渡せます |
| `vast_volumes` | 永続ボリュームの list / search / create / delete |
| **`vast_fleet_launch`** | **N 台を一括で借りて寿命（TTL）を固定**: 検索・順位付け（`strategy: most_cpu` など）・1 マシン 1 台・並列作成・バックグラウンド監視・死んだ台の補充・期限での確実な破棄 |
| `vast_fleet_status` | 状態別台数、稼働数、残り秒数、ここまでのコスト、破棄の進捗、各メンバーの SSH 接続先 |
| `vast_fleet_list` | ディスクに永続化された全 fleet |
| `vast_fleet_control` | fleet 全体の `stop` / `start` / `wait`: 準備済みの台を停止しておき、後で全台を同時に起動（Running 連続 N 回で準備完了判定、間に合わない台は破棄） |
| `vast_fleet_run` | fleet の稼働中インスタンス全部に SSH でコマンドを並列実行 |
| `vast_fleet_extend` | fleet の期限を延長 |
| `vast_fleet_destroy` | fleet（または全 fleet）を即時破棄。インスタンス一覧で消えたことを検証 |

## Fleet: 多数のインスタンスを決まった時間だけ

`vast_launch` は 1 台用です。「特定テンプレートで、vCPU 数が多いマシンから順に 200 台を 15 分だけ起動し、15 分後に確実に消す」
のような用途には fleet を使います。

```text
› vast_fleet_launch {"count": 200, "ttl_minutes": 15, "template_hash": "661d064b…",
                     "strategy": "most_cpu", "min_cpu_cores": 16, "max_price_per_hour": 0.5,
                     "name": "crawl-1", "dry_run": true}          ← 候補 200 台と概算コストだけ表示
› vast_fleet_launch {… 同じ …, "dry_run": false, "max_total_cost_usd": 40}
{ "fleet": { "name": "crawl-1", "state": "active", "alive": 196, "deadline_at": "…", "seconds_remaining": 887,
             "counts": {"created": 120, "loading": 60, "running": 16}, "create_failures": 4 } }
› vast_fleet_run    {"name": "crawl-1", "command": "nohup ./job.sh > job.log 2>&1 &"}
› vast_fleet_status {"name": "crawl-1"}
› vast_fleet_destroy {"name": "crawl-1"}                         ← 任意。呼ばなくても期限で破棄されます
```

fleet ワークフローの中身:

1. **検索と順位付け** – フィルタ付きで `POST /bundles/`。`limit = count × overprovision + 10`、並び順は strategy
   （`most_cpu` = `cpu_cores_effective` 降順、価格昇順）。既定で物理マシンごとに 1 オファー（`unique_machines`）。
   `bid_price` 指定時は `min_bid` がそれを超えるオファーを除外。
2. **コストガード** – 上位 `count` 件の価格 × TTL で概算し、`max_total_cost_usd` を超えるなら何も作らずに中止。
   `dry_run` なら候補だけ返します。
3. **並列作成** – `PUT /asks/{id}/` を `create_concurrency` 本のワーカーで実行。必要数を超える同時作成はしません。
   失敗したオファーは次の候補に流れます。成功は即座にディスクへ永続化。
4. **監視** – ポーリング 1 回につき `GET /api/v1/instances/` を 1 回（台数分の個別 GET はしない）。状態更新、
   プロセスが知らない「fleet ラベル付き」インスタンスの取り込み、`exited`/`offline` になった台の補充
   （`replace_failed`、`max_replacements` 上限、残り 3 分超のときのみ）。
5. **期限で破棄** – `DELETE /instances/` を 64 件ずつ（失敗時は個別 DELETE にフォールバック）。その後インスタンス一覧を
   読み直し、残っているもの（ラベル一致も含む）をバックオフ付きで再削除。一覧で消えたことを確認してはじめて `terminated` になります。

破棄は多層で保証されるので、MCP クライアントが接続し続けている必要はありません:

| 層 | 仕組み |
| --- | --- |
| プロセス内 | 期限タイマー + 30 秒ごとの watchdog |
| ディスク | `~/.vastai-mcp/fleets/*.json`（`VAST_MCP_STATE_DIR`）に状態を保存。サーバー起動時に期限切れ fleet を回収 |
| クライアント切断後 | アクティブな fleet がある間はサーバープロセスが生き残り、全部破棄してから終了 |
| プロセス外 | `vastai-mcp reap`（残っていれば終了コード 1）。cron / タスクスケジューラに登録可。`--watch` で常駐 |
| コンテナ内 | `self_destruct`（既定 on）。vast が注入する `CONTAINER_API_KEY` を使い `sleep <ttl>; curl -X DELETE …/instances/$CONTAINER_ID/` を onstart に前置（ベストエフォート。延長する予定なら `self_destruct=false`） |

```bash
node dist/index.js reap          # 期限切れ fleet を破棄して結果を表示
node dist/index.js fleets        # 保存されている fleet を表示
```

注意: TTL は fleet 作成時刻から数えます（各台が `running` になった時刻からではありません）。ストレージは作成時から、
GPU は `running` から課金されます。`vast_fleet_status.estimated_cost_usd` は価格 × 稼働時間の合計です。

### ウォームプール: 準備 → 停止 → 全台同時起動

vast は onstart スクリプトを**起動のたびに**実行するので、fleet を準備（イメージ取得、パッケージ導入、`screen`
セッション定義）してから `stop` で寝かせておき、後で `start` すると全ジョブが数秒以内に一斉に始まります。
いわゆる「ローダー」スクリプトのパターンです。

```text
› vast_fleet_launch  {"name": "load", "count": 100, "ttl_minutes": 240, "image": "vastai/base-image:@vastai-automatic-tag",
                      "disk_gb": 8, "strategy": "most_cpu", "min_cpu_cores": 8,
                      "screens": [{"name": "loader", "command": "python3 /work/run.py"}], "dry_run": true}
                      → 候補一覧 + totals { vcpus, ram_gb, hourly_usd } + 概算コスト
› vast_fleet_launch  {… "dry_run": false}
› vast_fleet_control {"name": "load", "action": "wait",  "running_streak": 2, "timeout_s": 1800}   ← 準備完了。間に合わない台は破棄
› vast_fleet_control {"name": "load", "action": "stop"}                                            ← 停止。ストレージ課金のみ
   … 後で …
› vast_fleet_control {"name": "load", "action": "start", "running_streak": 2}                      ← 全台同時起動。screen も再起動
› vast_fleet_status  {"name": "load"}   /  vast_fleet_run {"name": "load", "command": "tail -n 3 /work/loader.log"}
› vast_fleet_destroy {"name": "load"}   （または期限を待つ）
```

`screens` は従来のローダースクリプトと同じシェル（`dpkg --configure -a`、`apt-get install -y screen curl`、`mkdir -p /work`、
`screen -S <name> -dm bash -lc '<cmd> >>/work/<name>.log 2>&1'`）に展開されます。`apt_packages` で追加パッケージ、
`onstart_cmd` は screen の前に挿入されます。アカウント全体に対する `--status` / `--destroy` / `--cleanup` 相当は
`vast_list_instances`（`totals` 付き）、`vast_destroy {"all": true}`、`vast_destroy {"all": true, "exclude_status": ["running"]}` です。

### 利用例

```text
› vast_launch {"gpu_name": "RTX 4090", "max_price_per_hour": 0.6, "region": "JP,SG,KR",
               "image": "vastai/pytorch:@vastai-automatic-tag", "disk_gb": 40,
               "env": {"HF_TOKEN": "hf_..."}, "ports": [8080],
               "onstart_cmd": "pip install -q datasets", "label": "finetune-1"}
{
  "success": true,
  "instance": { "id": 1234567, "status": "running", "gpu": "1x RTX 4090",
                "ssh": { "command": "ssh -p 40022 root@1.2.3.4", "direct": true },
                "ports": { "8080/tcp": "1.2.3.4:40080" }, "price_per_hour": 0.52 },
  "ssh_ready": true,
  "attempts": [ { "offer_id": 987654, "outcome": "running", "history": ["loading", "running"] } ]
}

› vast_run {"instance_id": 1234567, "command": "nvidia-smi --query-gpu=name,memory.total --format=csv"}
› vast_copy_file {"instance_id": 1234567, "direction": "upload", "local_path": "train.py", "remote_path": "/workspace/train.py"}
› vast_run {"instance_id": 1234567, "command": "nohup python /workspace/train.py > /workspace/train.log 2>&1 &"}
› vast_destroy {"instance_ids": [1234567]}
```

## エンドポイント対応表

すべてのツールは `vast.py` が発行するのと同じリクエストで構成されています。

| REST | `vast.py` の関数 | 使用ツール |
| --- | --- | --- |
| `GET /api/v0/users/current` | `show__user` | `vast_account` |
| `GET /api/v0/gpu_names/unique/` | `_get_gpu_names` | `vast_gpu_names` |
| `POST /api/v0/bundles/` | `search__offers` | `vast_search_offers`, `vast_launch` |
| `PUT /api/v0/asks/{offer}/` | `create__instance` | `vast_launch` |
| `GET /api/v1/instances/`（ページング） | `_fetch_all_instances_v1` | `vast_list_instances` |
| `GET /api/v0/instances/{id}/?owner=me` | `show__instance` | `vast_instance`、各種待機 |
| `PUT /api/v0/instances/{id}/` `{state}` / `{label}` | `start_instance`, `stop_instance`, `label__instance` | `vast_instance_control`, `vast_update_instance` |
| `PUT /api/v0/instances/reboot/{id}/` | `reboot__instance` | `vast_instance_control` |
| `DELETE /api/v0/instances/{id}/` | `destroy_instance` | `vast_destroy`, `vast_launch`（後始末） |
| `PUT /api/v0/instances/bid_price/{id}/` | `change__bid` | `vast_update_instance` |
| `PUT /api/v0/instances/request_logs/{id}/` → `result_url` | `logs` | `vast_logs` |
| `PUT /api/v0/instances/command/{id}/` → `result_url` | `execute` | `vast_api_execute` |
| `GET/POST /api/v0/ssh/`, `DELETE /api/v0/ssh/{id}/` | `show__ssh_keys`, `create__ssh_key`, `delete__ssh_key` | `vast_ssh_keys`, `vast_launch` |
| `POST /api/v0/instances/{id}/ssh/`, `DELETE …/ssh/{key}/` | `attach__ssh`, `detach__ssh` | `vast_ssh_keys` |
| `GET /api/v0/template/?select_cols&select_filters` | `search__templates` | `vast_templates` |
| `GET /api/v0/volumes?owner=me`, `POST /api/v0/volumes/search/`, `PUT/DELETE /api/v0/volumes/` | `show__volumes`, `search__volumes`, `create__volume`, `delete__volume` | `vast_volumes` |
| `DELETE /api/v0/instances/` `{instance_ids}`（64 件ずつ） | `vastai.api.instances.destroy_instance`（リスト形式） | `vast_destroy`, fleet |

検索クエリ DSL（`parse_query`）、`env` のエンコード（`parse_env`）、runtype 文字列（`get_runtype`）、
SSH 接続先の解決（`_ssh_url`）はそのまま移植し、ユニットテストで検証しています。

## 挙動に関する注意

- **課金。** ストレージは作成時から、GPU は `running` になってから課金されます。stopped でもディスク代はかかります。
  `vast_launch` は起動に失敗したインスタンスを既定で破棄（`destroy_on_failure`）するので、放置課金が発生しません。
- **待機の早期打ち切り。** `exited` と `offline` は `running` に戻りません。`unknown`（ホストからの heartbeat 途絶）は
  30 秒程度続いたら失敗扱いにします。すべて `timeout_s` で上限を設けています。
- **直結ポート。** コンテナポートの公開（`ports`）には直結ポートを持つホストが必要なので、`vast_launch` は
  ports 指定時に自動で `direct_port_count >= 1` を検索条件に加えます。
- **スポット。** `bid_price` を渡すと `type=bid` で検索し、`min_bid` が入札額を超えるオファーを除外してから、その価格で作成します。
- **進捗通知。** クライアントが `progressToken` を渡した場合、長時間ツールは `notifications/progress` を送ります。

## 開発

```bash
npm run typecheck
npm test              # vitest: クエリ DSL、env エンコード、HTTP クライアント、launch ワークフロー（モック API）
npm run build
node scripts/smoke.mjs   # stdio でサーバーを起動し、実 API に対して 2 ツールを呼ぶ
```

## ライセンス

MIT
