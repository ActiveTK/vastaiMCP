#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VastApi } from "./api/vast.js";
import { VastClient } from "./client.js";
import { loadConfig } from "./config.js";
import { FleetManager } from "./fleet/manager.js";
import { FleetStore } from "./fleet/state.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

const log = (m: string) => console.error(`[${SERVER_NAME}] ${m}`);

function usage(): never {
  console.error(
    [
      "usage:",
      "  vastai-mcp                 start the MCP server on stdio",
      "  vastai-mcp reap [--watch]  destroy fleets whose deadline has passed (state in ~/.vastai-mcp/fleets); --watch keeps running",
      "  vastai-mcp fleets          print known fleets",
    ].join("\n"),
  );
  process.exit(2);
}

async function serve() {
  const cfg = loadConfig();
  if (!cfg.apiKey) log("warning: no API key found. Set VAST_API_KEY or write it to ~/.vast_api_key (https://console.vast.ai/manage-keys/).");
  let transportClosed = false;
  const { server, fleets } = createServer(cfg, {
    fleetOptions: {
      log,
      onIdle: () => {
        if (transportClosed) {
          log("all fleets terminated; exiting");
          process.exit(0);
        }
      },
    },
  });
  const boot = fleets.start();
  if (boot.loaded) log(`fleets: loaded ${boot.loaded} (active: ${boot.active.join(", ") || "-"}; expired/terminating: ${boot.expired.join(", ") || "-"})`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // When the client goes away, stay alive only while fleets still need to be destroyed on time.
  server.server.onclose = () => {
    transportClosed = true;
    if (fleets.hasActiveFleets()) {
      log("client disconnected; staying alive to enforce fleet deadlines (run `vastai-mcp fleets` to inspect)");
    } else {
      fleets.stop();
      process.exit(0);
    }
  };
  log(`v${SERVER_VERSION} ready on stdio (api: ${cfg.baseUrl}, ssh key: ${cfg.sshPrivateKeyPath ?? "none"})`);
}

async function reap(watch: boolean) {
  const cfg = loadConfig();
  const api = new VastApi(new VastClient(cfg.baseUrl, cfg.apiKey, cfg.retry));
  const store = new FleetStore();
  const fleets = new FleetManager(api, cfg, store, { log });
  const results = await fleets.reapOnce();
  console.log(JSON.stringify({ state_dir: store.dir, reaped: results }, null, 2));
  if (!watch) process.exit(results.every((r) => r.verified) ? 0 : 1);
  fleets.start();
  log("watching fleets; Ctrl-C to stop");
  setInterval(() => {}, 60_000); // keep the event loop alive
}

function printFleets() {
  const cfg = loadConfig();
  const store = new FleetStore();
  const fleets = new FleetManager(new VastApi(new VastClient(cfg.baseUrl, cfg.apiKey, cfg.retry)), cfg, store);
  console.log(JSON.stringify({ state_dir: store.dir, fleets: fleets.list() }, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
const main = async () => {
  if (!cmd) return serve();
  if (cmd === "reap") return reap(rest.includes("--watch"));
  if (cmd === "fleets") return printFleets();
  usage();
};

main().catch((e) => {
  log(`fatal: ${e?.stack ?? e}`);
  process.exit(1);
});
