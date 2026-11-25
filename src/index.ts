#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { PallinoClient } from "./client.js";
import { loadConfig, type Config } from "./config.js";
import { INSTRUCTIONS, registerTools } from "./tools.js";
import { createHttpApp } from "./http.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export function buildServer(cfg: Config): McpServer {
  const server = new McpServer({ name: "pallino-mcp", title: "Pallino", version }, { instructions: INSTRUCTIONS });
  registerTools(
    server,
    (extra) => {
      // HTTP: the caller's own key. stdio (or ALLOW_ENV_KEY without a header): the configured key.
      const key = typeof extra?.apiKey === "string" ? extra.apiKey : cfg.transport === "stdio" || cfg.allowEnvKey ? cfg.apiKey : undefined;
      return new PallinoClient(key, cfg.baseUrl);
    },
    { timeZone: cfg.timeZone },
  );
  return server;
}

async function main() {
  const cfg = loadConfig();
  if (cfg.transport === "stdio") {
    if (!cfg.apiKey) console.error("pallino-mcp: PALLINO_API_KEY is not set; every tool call will fail with unauthorized.");
    await buildServer(cfg).connect(new StdioServerTransport());
    return;
  }
  const app = createHttpApp(cfg, () => buildServer(cfg));
  app.listen(cfg.port, cfg.host, () => {
    console.error(`pallino-mcp ${version} listening on http://${cfg.host}:${cfg.port}/mcp (OAuth ${cfg.oauthSecret ? "on" : "off"})`);
  });
}

main().catch((e) => {
  console.error("pallino-mcp:", e instanceof Error ? e.message : e);
  process.exit(1);
});
