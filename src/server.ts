import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VastApi } from "./api/vast.js";
import { VastClient } from "./client.js";
import type { VastConfig } from "./config.js";
import { FleetManager, type FleetManagerOptions } from "./fleet/manager.js";
import { FleetStore } from "./fleet/state.js";
import { registerAccountTools } from "./tools/account.js";
import type { ToolContext } from "./tools/common.js";
import { registerFleetTools } from "./tools/fleet.js";
import { registerInstanceTools } from "./tools/instances.js";
import { registerLaunchTools } from "./tools/launch.js";
import { registerOfferTools } from "./tools/offers.js";
import { registerRemoteTools } from "./tools/remote.js";
import { registerSshKeyTools } from "./tools/ssh.js";
import { registerTemplateTools } from "./tools/templates.js";
import { registerVolumeTools } from "./tools/volumes.js";

export const SERVER_NAME = "vastai-mcp";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `vast.ai GPU cloud abstraction layer.

Typical flow:
  1. vast_account            – verify the API key and check the balance.
  2. vast_launch             – search + create + wait + ssh-ready in one call. Give gpu_name/max_price_per_hour and an image
                               (e.g. "vastai/pytorch:@vastai-automatic-tag"), plus disk_gb, env, ports, onstart_cmd as needed.
  3. vast_run / vast_copy_file – work on the box over SSH (VAST_SSH_KEY must point at the private key).
  4. vast_destroy            – stop billing when done (stopped instances still pay for storage).

Many machines at once: vast_fleet_launch (count, ttl_minutes, filters, strategy e.g. most_cpu) creates a fleet that is
destroyed automatically at the deadline; vast_fleet_status / vast_fleet_run / vast_fleet_destroy manage it. Prefer
dry_run=true first for large fleets.

Use vast_search_offers only when the user wants to compare machines before renting. GPU names must match vast_gpu_names
("RTX 4090", "H100 SXM"); underscores are accepted. Prices are USD per hour for the whole instance.`;

export interface CreateServerOptions {
  fetchImpl?: typeof fetch;
  store?: FleetStore;
  fleetOptions?: FleetManagerOptions;
}

export function createServer(cfg: VastConfig, opts: CreateServerOptions = {}): { server: McpServer; api: VastApi; fleets: FleetManager } {
  const client = new VastClient(cfg.baseUrl, cfg.apiKey, cfg.retry, opts.fetchImpl);
  const api = new VastApi(client);
  const fleets = new FleetManager(api, cfg, opts.store ?? new FleetStore(), opts.fleetOptions);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const ctx: ToolContext = { server, api, cfg, fleets };

  registerAccountTools(ctx);
  registerOfferTools(ctx);
  registerLaunchTools(ctx);
  registerInstanceTools(ctx);
  registerSshKeyTools(ctx);
  registerRemoteTools(ctx);
  registerTemplateTools(ctx);
  registerVolumeTools(ctx);
  registerFleetTools(ctx);

  return { server, api, fleets };
}
