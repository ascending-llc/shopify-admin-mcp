#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import { GraphQLClient } from "graphql-request";
import minimist from "minimist";

import { ShopifyAuth } from "./lib/shopifyAuth.js";
import {
  filterRegistryByMode,
  parsePermissionMode,
} from "./lib/permissionMode.js";
import { setDefaultClient, shopifyClientProxy } from "./lib/shopifyClientProxy.js";
import { toolRegistry } from "./tools/registry.js";
import { createMcpServer } from "./server/mcpServer.js";
import { startHttpServer } from "./server/httpServer.js";

const argv = minimist(process.argv.slice(2));
dotenv.config();

// ── Shared config (transport-independent) ─────────────────────────────
const permissionMode = parsePermissionMode(
  argv.mode ?? process.env.SHOPIFY_MCP_MODE,
  argv.readonly ?? process.env.SHOPIFY_MCP_READONLY,
);
const transportMode =
  String(argv.transport ?? process.env.SHOPIFY_MCP_TRANSPORT ?? "stdio")
    .toLowerCase() === "http"
    ? "http"
    : "stdio";
const API_VERSION =
  argv.apiVersion || process.env.SHOPIFY_API_VERSION || "2026-01";

const activeEntries = filterRegistryByMode(toolRegistry, permissionMode);

// Inject the context-aware proxy into every active tool. The proxy dispatches
// to the per-request client (HTTP) or the startup client (stdio).
for (const { tool } of activeEntries) {
  tool.initialize(shopifyClientProxy);
}

const writeCount = activeEntries.filter((e) => e.mode === "write").length;
console.error(
  `[shopify-mcp] transport: ${transportMode}, permission mode: ${permissionMode} — ` +
    `${activeEntries.length}/${toolRegistry.length} tools active ` +
    `(${activeEntries.length - writeCount} read, ${writeCount} write)`,
);

if (transportMode === "http") {
  const PORT = Number(argv.port ?? process.env.PORT ?? 8080);
  await startHttpServer({
    activeEntries,
    permissionMode,
    apiVersion: API_VERSION,
    port: PORT,
  });
} else {
  await startStdio();
}

// ── stdio transport (local / back-compat: single store at startup) ─────
async function startStdio(): Promise<void> {
  const SHOPIFY_ACCESS_TOKEN = argv.accessToken || process.env.SHOPIFY_ACCESS_TOKEN;
  const SHOPIFY_CLIENT_ID = argv.clientId || process.env.SHOPIFY_CLIENT_ID;
  const SHOPIFY_CLIENT_SECRET =
    argv.clientSecret || process.env.SHOPIFY_CLIENT_SECRET;
  const MYSHOPIFY_DOMAIN = argv.domain || process.env.MYSHOPIFY_DOMAIN;

  const useClientCredentials = !!(SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET);

  if (!SHOPIFY_ACCESS_TOKEN && !useClientCredentials) {
    console.error("Error: Authentication credentials are required for stdio mode.");
    console.error("");
    console.error("Option 1 — Static access token (legacy apps):");
    console.error("  --accessToken=shpat_xxxxx");
    console.error("");
    console.error("Option 2 — Client credentials (Dev Dashboard apps, Jan 2026+):");
    console.error("  --clientId=your_client_id --clientSecret=your_client_secret");
    process.exit(1);
  }

  if (!MYSHOPIFY_DOMAIN) {
    console.error("Error: MYSHOPIFY_DOMAIN is required for stdio mode.");
    console.error("  Command line: --domain=your-store.myshopify.com");
    process.exit(1);
  }

  process.env.MYSHOPIFY_DOMAIN = MYSHOPIFY_DOMAIN;

  let accessToken: string;
  let auth: ShopifyAuth | null = null;
  if (useClientCredentials) {
    auth = new ShopifyAuth({
      clientId: SHOPIFY_CLIENT_ID!,
      clientSecret: SHOPIFY_CLIENT_SECRET!,
      shopDomain: MYSHOPIFY_DOMAIN,
    });
    accessToken = await auth.initialize();
  } else {
    accessToken = SHOPIFY_ACCESS_TOKEN!;
  }
  process.env.SHOPIFY_ACCESS_TOKEN = accessToken;

  const startupClient = new GraphQLClient(
    `https://${MYSHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    },
  );

  // Let the auth manager hot-swap the token header on refresh.
  if (auth) {
    auth.setGraphQLClient(startupClient);
  }
  // The proxy falls back to this client when there is no per-request context.
  setDefaultClient(startupClient);

  const server = createMcpServer(activeEntries, permissionMode, "stdio");
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
