import type { Server } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express } from "express";

import {
  PassthroughResolver,
  type CredentialResolver,
} from "../lib/credentialResolver.js";
import type { PermissionMode } from "../lib/permissionMode.js";
import { runWithContext } from "../lib/requestContext.js";
import { shopifyAuthMiddleware } from "../lib/authMiddleware.js";
import type { ToolRegistryEntry } from "../lib/toolUtils.js";
import { createMcpServer } from "./mcpServer.js";

export interface HttpServerOptions {
  activeEntries: ToolRegistryEntry[];
  permissionMode: PermissionMode;
  apiVersion: string;
  port: number;
  /** Defaults to PassthroughResolver (D15 path a). */
  resolver?: CredentialResolver;
}

export async function createApp(
  options: HttpServerOptions,
): Promise<Express> {
  const { activeEntries, permissionMode, apiVersion } = options;
  const resolver = options.resolver ?? new PassthroughResolver();

  // One stateless MCP server/transport, reused across requests. No user data
  // lives on them; per-request identity/routing is isolated via AsyncLocalStorage.
  const mcpServer = createMcpServer(activeEntries, permissionMode, "http");
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await mcpServer.connect(transport);

  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", mode: permissionMode });
  });

  // Streamable HTTP endpoint. POST carries JSON-RPC; GET opens the SSE stream;
  // DELETE terminates a session. The transport decides per method (in stateless
  // mode GET/DELETE without a session yield 405). All routed through one handler
  // so identity/routing are seeded per request via AsyncLocalStorage.
  const mcpHandler = async (
    req: Parameters<typeof transport.handleRequest>[0],
    res: Parameters<typeof transport.handleRequest>[1],
  ): Promise<void> => {
    const identity = resolver.resolve(req.headers);
    await runWithContext(
      {
        transportMode: "http",
        apiVersion,
        bearer: identity?.bearer,
        userId: identity?.userId,
        username: identity?.username,
        scopes: identity?.scopes,
        shopDomainHeader: identity?.shopDomainHeader,
      },
      // POST passes the parsed body; GET/DELETE have none.
      () =>
        transport.handleRequest(
          req,
          res,
          req.method === "POST" ? (req as { body?: unknown }).body : undefined,
        ),
    );
  };

  app.post("/mcp", shopifyAuthMiddleware, mcpHandler);
  app.get("/mcp", shopifyAuthMiddleware, mcpHandler);
  app.delete("/mcp", shopifyAuthMiddleware, mcpHandler);

  return app;
}

export async function startHttpServer(
  options: HttpServerOptions,
): Promise<Server> {
  const app = await createApp(options);
  return new Promise<Server>((resolve) => {
    const server = app.listen(options.port, () => {
      console.error(
        `[shopify-mcp] HTTP transport listening on :${options.port} ` +
          `(POST /mcp, GET /healthz)`,
      );
      resolve(server);
    });
  });
}
