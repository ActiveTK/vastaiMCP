# vastai-mcp

[日本語版はこちら](README.ja.md)

An [MCP](https://modelcontextprotocol.io) server that gives AI agents a **workflow-level** abstraction over the
[vast.ai](https://vast.ai) GPU marketplace.

It does **not** wrap the `vastai` CLI. The REST endpoints were extracted by reading the CLI's own
implementation (`vast.py` in [vast-ai/vast-python](https://github.com/vast-ai/vast-python)) and are called
directly, so there is no Python dependency and no subprocess. Instead of mirroring CLI commands 1:1, the
tools are shaped around what an agent actually wants to do: *"get me a running box with this image, tell me
how to SSH in"*, *"run this command on it"*, *"tear it down"*.

```text
vast_launch ─┬─ register SSH key on the account (if missing)
             ├─ POST /bundles/          search offers by GPU / price / region …
             ├─ PUT  /asks/{offer}/     create the instance
             ├─ GET  /instances/{id}/   poll until actual_status == running
             │        └─ on exited/offline/timeout: DELETE and try the next offer
             └─ ssh probe               wait until the box accepts your key
```

## Requirements

- Node.js ≥ 20
- A vast.ai API key ([console.vast.ai/manage-keys](https://console.vast.ai/manage-keys/))
- An SSH key pair if you want `vast_run` / `vast_copy_file` (the public half is registered on the account
  automatically by `vast_launch`)

## Install

```bash
git clone https://github.com/ActiveTK/vastaiMCP.git
cd vastaiMCP
npm install      # builds dist/ via the prepare script
```

### Claude Code

```bash
claude mcp add vastai -e VAST_API_KEY=your_key -- node /path/to/vastaiMCP/dist/index.js
```

### Claude Desktop / other MCP clients

```json
{
  "mcpServers": {
    "vastai": {
      "command": "node",
      "args": ["/path/to/vastaiMCP/dist/index.js"],
      "env": {
        "VAST_API_KEY": "your_key",
        "VAST_SSH_KEY": "/home/you/.ssh/id_ed25519"
      }
    }
  }
}
```

See [examples/mcp-config.json](examples/mcp-config.json).

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAST_API_KEY` | contents of `~/.vast_api_key` | API key (same fallback file the CLI uses) |
| `VAST_URL` | `https://console.vast.ai` | API base URL |
| `VAST_SSH_KEY` | first of `~/.ssh/id_ed25519`, `id_rsa`, `id_ecdsa` | private key for `vast_run` / `vast_copy_file` / SSH readiness checks |
| `VAST_SSH_PUBLIC_KEY` | `<VAST_SSH_KEY>.pub` | public key (path or literal) registered on the account before launch |
| `VAST_SSH_PASSPHRASE` | – | passphrase for the private key |
| `VAST_RETRY` | `6` | retries on HTTP 429 (exponential backoff; matters for 200-instance fleets) |
| `VAST_MCP_STATE_DIR` | `~/.vastai-mcp/fleets` | where fleet state (deadlines, instance ids) is persisted |

## Tools

| Tool | What it does |
| --- | --- |
| `vast_account` | Verify the API key; show balance and the SSH/API configuration in use |
| `vast_gpu_names` | Exact GPU model names accepted by filters |
| `vast_search_offers` | Structured marketplace search (GPU, VRAM, price cap, region, reliability, bandwidth, …) plus a `raw_query` escape hatch in CLI syntax |
| **`vast_launch`** | **Search → create → wait for running → wait for SSH, with automatic fallback to the next offer.** Accepts image or template, disk, env vars, ports, onstart script, jupyter/ssh/args runtypes, bid price, volumes |
| `vast_list_instances` | All instances with status, price and SSH endpoint; running cost per hour |
| `vast_instance` | One instance: status message, SSH command, published ports, Jupyter URL, env |
| `vast_wait_instance` | Block until `running` / `stopped` with terminal-state detection and timeout |
| `vast_instance_control` | start / stop / reboot (optionally waits for the resulting state) |
| `vast_destroy` | Destroy instances by id, or `all=true` with status / label filters (e.g. everything not running); bulk DELETE, verified against the instance list |
| `vast_update_instance` | Change label or raise the bid of an interruptible instance |
| `vast_logs` | Container or host-daemon logs, with tail / filter |
| `vast_ssh_keys` | list / add / delete account keys; attach / detach keys on a running instance |
| `vast_run` | Run a shell command on the instance over SSH (stdout, stderr, exit code, timeout) |
| `vast_copy_file` | Upload / download a file over SFTP |
| `vast_api_execute` | `ls` / `rm` / `du` through vast's own API (no SSH needed) |
| `vast_templates` | Search templates (PyTorch, vLLM, ComfyUI, …) and get a `template_hash` for `vast_launch` |
| `vast_volumes` | list / search / create / delete persistent volumes |
| **`vast_fleet_launch`** | **Rent N machines at once with a hard TTL**: search, rank (`strategy: most_cpu` …), one per machine, parallel create, background monitor, replacement of dead instances, guaranteed destruction at the deadline |
| `vast_fleet_status` | Per-status counts, alive/running, seconds remaining, cost so far, termination progress, members with SSH endpoints |
| `vast_fleet_list` | All fleets persisted on disk |
| `vast_fleet_control` | `stop` / `start` / `wait` for the whole fleet: park prepared instances, then start them all at the same moment (running-streak readiness, stragglers destroyed) |
| `vast_fleet_run` | Run a command over SSH on every running instance of a fleet in parallel |
| `vast_fleet_extend` | Push a fleet's deadline back |
| `vast_fleet_destroy` | Destroy a fleet (or all fleets) now, verified against the instance list |

## Fleets: many instances, fixed lifetime

`vast_launch` is for one box. For "start 200 instances from template X on the machines with the most vCPUs,
keep them for 15 minutes, then make absolutely sure they are gone" use a fleet:

```text
› vast_fleet_launch {"count": 200, "ttl_minutes": 15, "template_hash": "661d064b…",
                     "strategy": "most_cpu", "min_cpu_cores": 16, "max_price_per_hour": 0.5,
                     "name": "crawl-1", "dry_run": true}          ← shows the 200 candidate machines + estimated cost
› vast_fleet_launch {… same …, "dry_run": false, "max_total_cost_usd": 40}
{ "fleet": { "name": "crawl-1", "state": "active", "alive": 196, "deadline_at": "…", "seconds_remaining": 887,
             "counts": {"created": 120, "loading": 60, "running": 16}, "create_failures": 4 } }
› vast_fleet_run    {"name": "crawl-1", "command": "nohup ./job.sh > job.log 2>&1 &"}
› vast_fleet_status {"name": "crawl-1"}
› vast_fleet_destroy {"name": "crawl-1"}                         ← optional; otherwise it happens at the deadline
```

What the fleet workflow does:

1. **Search & rank** – `POST /bundles/` with your filters, `limit = count × overprovision + 10`, ordered by the
   strategy (`most_cpu` = `cpu_cores_effective` descending, price ascending). One offer per physical machine by
   default (`unique_machines`). If `bid_price` is set, offers whose `min_bid` is higher are dropped.
2. **Cost guard** – estimated cost = top `count` prices × TTL; `max_total_cost_usd` aborts before anything is
   created. `dry_run` returns the candidates without creating.
3. **Create in parallel** – `PUT /asks/{id}/` with `create_concurrency` workers, never more in flight than still
   needed. A failed offer falls through to the next candidate. Every success is persisted immediately.
4. **Monitor** – one `GET /api/v1/instances/` per poll (not one call per instance) updates statuses, adopts any
   instance carrying the fleet label that the process does not know about, and replaces instances that reach
   `exited`/`offline` (`replace_failed`, capped by `max_replacements`, only while > 3 min remain).
5. **Terminate at the deadline** – `DELETE /instances/` in chunks of 64 (falls back to per-id deletes), then the
   instance list is re-read; anything still present, including label matches, is deleted again with backoff
   until nothing remains. The fleet is `terminated` only after verification.

Termination is enforced in layers, so it does not depend on the MCP client staying connected:

| Layer | Mechanism |
| --- | --- |
| In-process | deadline timer plus a 30 s watchdog tick |
| On disk | fleet state in `~/.vastai-mcp/fleets/*.json` (`VAST_MCP_STATE_DIR`); expired fleets are reaped when the server starts |
| After the client disconnects | the server process stays alive until active fleets are terminated, then exits |
| Out of process | `vastai-mcp reap` (exit code 1 if anything remains) — put it in cron / Task Scheduler; `vastai-mcp reap --watch` keeps running |
| In the container | `self_destruct` (default on) prepends `sleep <ttl>; curl -X DELETE …/instances/$CONTAINER_ID/` using vast's `CONTAINER_API_KEY` to the onstart script (best effort; skip with `self_destruct=false` if you plan to extend) |

```bash
node dist/index.js reap          # destroy fleets whose deadline has passed, print what happened
node dist/index.js fleets        # show persisted fleets
```

Notes: the TTL is measured from fleet creation, not from when each instance reaches `running`. Storage is billed
from creation, GPU time from `running`; `vast_fleet_status.estimated_cost_usd` sums price × running time.

### Warm pool: prepare, stop, start everything at once

Because vast runs the onstart script on *every* start, a fleet can be prepared (image pulled, packages installed,
`screen` sessions defined), parked with `stop`, and later resumed so that all jobs begin within the same few
seconds — the pattern of a typical "loader" script:

```text
› vast_fleet_launch  {"name": "load", "count": 100, "ttl_minutes": 240, "image": "vastai/base-image:@vastai-automatic-tag",
                      "disk_gb": 8, "strategy": "most_cpu", "min_cpu_cores": 8,
                      "screens": [{"name": "loader", "command": "python3 /work/run.py"}], "dry_run": true}
                      → candidates + totals { vcpus, ram_gb, hourly_usd } + estimated cost
› vast_fleet_launch  {… "dry_run": false}
› vast_fleet_control {"name": "load", "action": "wait",  "running_streak": 2, "timeout_s": 1800}   ← prepared; stragglers destroyed
› vast_fleet_control {"name": "load", "action": "stop"}                                            ← parked, storage-only billing
   … later …
› vast_fleet_control {"name": "load", "action": "start", "running_streak": 2}                      ← everyone starts now; screens relaunch
› vast_fleet_status  {"name": "load"}   /  vast_fleet_run {"name": "load", "command": "tail -n 3 /work/loader.log"}
› vast_fleet_destroy {"name": "load"}   (or wait for the deadline)
```

`screens` expands to the same shell as the classic loader script (`dpkg --configure -a`, `apt-get install -y screen curl`,
`mkdir -p /work`, `screen -S <name> -dm bash -lc '<cmd> >>/work/<name>.log 2>&1'`); `apt_packages` adds more packages and
`onstart_cmd` is inserted before the screens. Account-wide equivalents of `--status`, `--destroy` and `--cleanup` are
`vast_list_instances` (with `totals`), `vast_destroy {"all": true}` and `vast_destroy {"all": true, "exclude_status": ["running"]}`.

### Example session

```text
› vast_launch {"gpu_name": "RTX 4090", "max_price_per_hour": 0.6, "region": "Europe",
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

## Endpoint map

Every tool is built on the same requests `vast.py` makes. Function names refer to `vast.py`.

| REST call | `vast.py` | Used by |
| --- | --- | --- |
| `GET /api/v0/users/current` | `show__user` | `vast_account` |
| `GET /api/v0/gpu_names/unique/` | `_get_gpu_names` | `vast_gpu_names` |
| `POST /api/v0/bundles/` | `search__offers` | `vast_search_offers`, `vast_launch` |
| `PUT /api/v0/asks/{offer}/` | `create__instance` | `vast_launch` |
| `GET /api/v1/instances/` (paginated) | `_fetch_all_instances_v1` | `vast_list_instances` |
| `GET /api/v0/instances/{id}/?owner=me` | `show__instance` | `vast_instance`, waits |
| `PUT /api/v0/instances/{id}/` `{state}` / `{label}` | `start_instance`, `stop_instance`, `label__instance` | `vast_instance_control`, `vast_update_instance` |
| `PUT /api/v0/instances/reboot/{id}/` | `reboot__instance` | `vast_instance_control` |
| `DELETE /api/v0/instances/{id}/` | `destroy_instance` | `vast_destroy`, `vast_launch` (cleanup) |
| `PUT /api/v0/instances/bid_price/{id}/` | `change__bid` | `vast_update_instance` |
| `PUT /api/v0/instances/request_logs/{id}/` → `result_url` | `logs` | `vast_logs` |
| `PUT /api/v0/instances/command/{id}/` → `result_url` | `execute` | `vast_api_execute` |
| `GET/POST /api/v0/ssh/`, `DELETE /api/v0/ssh/{id}/` | `show__ssh_keys`, `create__ssh_key`, `delete__ssh_key` | `vast_ssh_keys`, `vast_launch` |
| `POST /api/v0/instances/{id}/ssh/`, `DELETE …/ssh/{key}/` | `attach__ssh`, `detach__ssh` | `vast_ssh_keys` |
| `GET /api/v0/template/?select_cols&select_filters` | `search__templates` | `vast_templates` |
| `GET /api/v0/volumes?owner=me`, `POST /api/v0/volumes/search/`, `PUT/DELETE /api/v0/volumes/` | `show__volumes`, `search__volumes`, `create__volume`, `delete__volume` | `vast_volumes` |
| `DELETE /api/v0/instances/` `{instance_ids}` (64 per call) | `vastai.api.instances.destroy_instance` (list form) | `vast_destroy`, fleets |

The query DSL (`parse_query`), the `env` encoding (`parse_env`), the runtype strings (`get_runtype`) and the
SSH endpoint resolution (`_ssh_url`) are ported verbatim and covered by unit tests.

## Behaviour notes

- **Billing.** Storage is charged from creation; GPU time from `running`. Stopped instances still pay for
  disk. `vast_launch` destroys instances that fail to start (`destroy_on_failure`, default true) so nothing is
  left accruing charges silently.
- **Fail-fast waiting.** `exited` and `offline` never recover into `running`; `unknown` (no host heartbeat)
  is failed after ~30 s. Everything is bounded by `timeout_s`.
- **Direct ports.** Publishing container ports (`ports`) requires a host with direct port mappings, so
  `vast_launch` automatically adds `direct_port_count >= 1` to the search when ports are requested.
- **Interruptible.** Passing `bid_price` searches `type=bid`, drops offers whose `min_bid` exceeds your bid
  and creates the instance with that price.
- **Progress.** Long-running tools emit `notifications/progress` when the client supplies a
  `progressToken`.

## Development

```bash
npm run typecheck
npm test              # vitest: query DSL, env encoding, client, launch workflow (mock API)
npm run build
node scripts/smoke.mjs   # spawns the server over stdio and calls two tools against the live API
```

## License

MIT
