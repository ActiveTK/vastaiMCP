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
| `VAST_RETRY` | `3` | HTTP 429 時のリトライ回数 |

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
| `vast_destroy` | インスタンスの破棄（課金停止） |
| `vast_update_instance` | ラベル変更、スポットインスタンスの入札額変更 |
| `vast_logs` | コンテナ / ホストデーモンのログ（tail、フィルタ） |
| `vast_ssh_keys` | アカウント鍵の list / add / delete、稼働中インスタンスへの attach / detach |
| `vast_run` | SSH 経由でシェルコマンドを実行（stdout、stderr、終了コード、タイムアウト） |
| `vast_copy_file` | SFTP でファイルをアップロード / ダウンロード |
| `vast_api_execute` | vast の API 経由で `ls` / `rm` / `du`（SSH 不要） |
| `vast_templates` | テンプレート検索（PyTorch、vLLM、ComfyUI …）。`template_hash` を `vast_launch` に渡せます |
| `vast_volumes` | 永続ボリュームの list / search / create / delete |

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
