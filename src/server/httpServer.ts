import type { Server } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type Request, type Response } from "express";

import {
  PassthroughResolver,
  type CredentialResolver,
} from "../lib/credentialResolver.js";
import type { PermissionMode } from "../lib/permissionMode.js";
import { runWithContext } from "../lib/requestContext.js";
import { shopifyAuthMiddleware } from "../lib/authMiddleware.js";
import { accessLogger, log, logServerInfo } from "../lib/logger.js";
import type { ToolRegistryEntry } from "../lib/toolUtils.js";
import { createMcpServer } from "./mcpServer.js";

export interface HttpServerOptions {
  activeEntries: ToolRegistryEntry[];
  permissionMode: PermissionMode;
  apiVersion: string;
  port: number;
  /** Defaults to PassthroughResolver (D15 path a). */
  resolver?: CredentialResolver;
  /**
   * Issuer advertised in RFC 9728 protected-resource metadata so spec-compliant
   * direct clients (VS Code, Claude Desktop) can discover where to authenticate.
   * Shopify's authorize host is per-shop, e.g.
   * `https://<shop>.myshopify.com/admin/oauth/authorize`. Optional — under the
   * Jarvis gateway the bearer is forwarded and discovery is short-circuited, so
   * this is only consulted when a client hits the server directly with no token.
   */
  oauthAuthorizationServer?: string;
  /** Scopes surfaced in the discovery document (informational). */
  scopesSupported?: string[];
}

/**
 * Builds the RFC 9728 protected-resource discovery handler.
 */
export function createOAuthDiscoveryHandler(
  options: Pick<
    HttpServerOptions,
    "port" | "oauthAuthorizationServer" | "scopesSupported"
  >,
): (req: express.Request, res: express.Response) => void {
  return (req, res) => {
    const authHeader = req.headers["authorization"];
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      res.status(404).json({
        error: "not_found",
        error_description:
          "OAuth discovery not needed — Bearer token already provided",
      });
      return;
    }

    const forwardedProto = req.headers["x-forwarded-proto"];
    const proto =
      (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
        ?.split(",")[0]
        .trim() ?? req.protocol;
    const host = req.get("host") ?? `localhost:${options.port}`;

    res.json({
      resource: `${proto}://${host}`,
      ...(options.oauthAuthorizationServer
        ? { authorization_servers: [options.oauthAuthorizationServer] }
        : {}),
      scopes_supported: options.scopesSupported ?? [],
      bearer_methods_supported: ["header"],
      resource_documentation:
        "https://github.com/ascending-llc/shopify-admin-mcp",
    });
  };
}

export async function createApp(
  options: HttpServerOptions,
): Promise<Express> {
  const { activeEntries, permissionMode, apiVersion } = options;
  const resolver = options.resolver ?? new PassthroughResolver();

  const app = express();
  app.use(accessLogger);
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", mode: permissionMode });
  });

  // OAuth Protected Resource Metadata (RFC 9728). Registered at the root and
  // under /mcp to cover both direct connections and gateway path-prefixing.
  const oauthDiscoveryHandler = createOAuthDiscoveryHandler(options);
  app.get("/.well-known/oauth-protected-resource", oauthDiscoveryHandler);
  app.get("/mcp/.well-known/oauth-protected-resource", oauthDiscoveryHandler);

  // Streamable HTTP endpoint. POST carries JSON-RPC; GET opens the SSE stream;
  // DELETE terminates a session. The transport decides per method (in stateless
  // mode GET/DELETE without a session yield 405). All routed through one handler
  // so identity/routing are seeded per request via AsyncLocalStorage.
  const mcpHandler = async (req: Request, res: Response): Promise<void> => {
    // Stateless: a fresh McpServer + transport per request (the MCP SDK stateless
    // pattern). With sessionIdGenerator undefined the transport tracks one request
    // lifecycle, so a reused instance 500s after the first call. No user data lives
    // on them; per-request identity/routing is isolated via AsyncLocalStorage.
    const server = createMcpServer(activeEntries, permissionMode, "http");
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      const identity = resolver.resolve(req.headers);
      await server.connect(transport);
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
    } catch (err) {
      log("ERROR", `/mcp handler error: ${err instanceof Error ? err.stack : String(err)}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : String(err),
            },
          }),
        );
      }
    }
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
  log("INFO", `Started server process [${process.pid}]`);
  log("INFO", "Waiting for application startup.");
  logServerInfo("http", options.permissionMode, options.activeEntries);
  return new Promise<Server>((resolve) => {
    const server = app.listen(options.port, () => {
      log("INFO", "Application startup complete.");
      log(
        "INFO",
        `Uvicorn running on http://0.0.0.0:${options.port} (Press CTRL+C to quit)`,
      );
      resolve(server);
    });
  });
}
