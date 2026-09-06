# vastai-mcp

MCP server (TypeScript, Node ≥ 20, ESM) exposing vast.ai as workflow-level tools. No `vastai` CLI dependency:
endpoints are called directly, derived from `vast.py` in vast-ai/vast-python.

## Layout

- `src/client.ts` – HTTP layer mirroring `apiurl()` / `http_request()` (auth header, `/api/v0` prefix, JSON query args, 429 backoff)
- `src/api/vast.ts` – one typed method per endpoint; each is annotated with the `vast.py` function it mirrors
- `src/query.ts`, `src/env.ts` – ports of `parse_query` / `parse_env` plus structured builders
- `src/workflows/` – `launch.ts` (search → create → wait → ssh) and `wait.ts` (fail-fast polling)
- `src/tools/` – MCP tool registrations; `common.ts` holds shared zod shapes and result helpers
- `src/ssh.ts` – ssh2 exec / sftp used by `vast_run` and `vast_copy_file`
- `tests/` – vitest; the launch workflow is tested against a fake fetch that emulates the API

## Conventions

- When adding an endpoint, read the corresponding function in `vast.py` first and note it in a doc comment.
- Tools return compact summaries (`src/format.ts`); expose raw API objects only behind `include_raw`.
- Anything that spends money or deletes data must be a separate tool with an accurate `destructiveHint`.
- Long-running tools must be bounded by a timeout and report `notifications/progress`.
- `npm run typecheck && npm test` before committing. `node scripts/smoke.mjs` hits the live API (public endpoints work without a key).
