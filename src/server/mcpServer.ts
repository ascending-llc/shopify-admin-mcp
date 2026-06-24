import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { PermissionMode } from "../lib/permissionMode.js";
import { getRequestContext } from "../lib/requestContext.js";
import { resolveShopRouting } from "../lib/shopRouting.js";
import type { ToolRegistryEntry } from "../lib/toolUtils.js";

export type TransportMode = "http" | "stdio";

const SHOP_DOMAIN_DESCRIPTION =
  "Target Shopify store, e.g. your-store.myshopify.com. Optional when the " +
  "gateway forwards the shop; required otherwise. Routing input only — never " +
  "the auth boundary.";

/**
 * Resolve routing for an HTTP tool call and stash the per-request client on the
 * active context. Delegates the (pure) resolution/validation to resolveShopRouting.
 */
function applyHttpRouting(rawArgs: Record<string, unknown>): Record<string, unknown> {
  const ctx = getRequestContext();
  if (!ctx) {
    throw new Error("Missing request context for tool execution.");
  }

  const routing = resolveShopRouting(rawArgs, {
    bearer: ctx.bearer,
    shopDomainHeader: ctx.shopDomainHeader,
    apiVersion: ctx.apiVersion,
  });

  ctx.shopDomain = routing.shopDomain;
  ctx.client = routing.client;
  return routing.toolArgs;
}

/**
 * Build an McpServer registering only the active tools. Each handler is wrapped
 * with: a fail-closed write guard (D2/D3), and — under HTTP transport — the
 * shop_domain registration wrapper (advertise on the schema, strip from args,
 * route into per-request context). Tool modules themselves are untouched.
 */
export function createMcpServer(
  activeEntries: ToolRegistryEntry[],
  permissionMode: PermissionMode,
  transportMode: TransportMode,
): McpServer {
  const server = new McpServer({
    name: "shopify",
    version: "1.0.0",
    description:
      `MCP Server for Shopify API (permission mode: ${permissionMode}). ` +
      "Enables interaction with store data through the GraphQL Admin API.",
  });

  for (const { tool, mode } of activeEntries) {
    const shape =
      transportMode === "http"
        ? {
            ...tool.schema.shape,
            shop_domain: z.string().optional().describe(SHOP_DOMAIN_DESCRIPTION),
          }
        : tool.schema.shape;

    server.tool(tool.name, shape, async (args: Record<string, unknown>) => {
      if (mode === "write" && permissionMode !== "full") {
        throw new Error(
          `Tool "${tool.name}" is a write tool and is disabled in read-only mode.`,
        );
      }

      const toolArgs =
        transportMode === "http" ? applyHttpRouting(args) : args;

      const result = await tool.execute(toolArgs);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    });
  }

  return server;
}
