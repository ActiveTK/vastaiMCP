#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main() {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    console.error(`[${SERVER_NAME}] warning: no API key found. Set VAST_API_KEY or write it to ~/.vast_api_key (https://console.vast.ai/manage-keys/).`);
  }
  const { server } = createServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] v${SERVER_VERSION} ready on stdio (api: ${cfg.baseUrl}, ssh key: ${cfg.sshPrivateKeyPath ?? "none"})`);
}

main().catch((e) => {
  console.error(`[${SERVER_NAME}] fatal:`, e);
  process.exit(1);
});
