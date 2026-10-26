import type { Server } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type Request, type Response } from "express";

import {
  PassthroughResolver,
  type CredentialResolver,
} from "../lib/credentialResolver.js";
import type { PermissionMode } from "../lib/permissionMode.js";
import { runWithContext } from "../lib/requestContext.js";
import { isValidShopDomain, normalizeShopDomain } from "../lib/shopRouting.js";
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

/**
 * Builds the token-exchange normalizing proxy (RFC 6749 §5.1 compatibility).
 *
 * Shopify's `/admin/oauth/access_token` returns a genuine token but omits the
 * spec-REQUIRED `token_type` field, because admin tokens are presented via the
 * proprietary `X-Shopify-Access-Token` header rather than as RFC 6750 Bearer
 * credentials. Strict OAuth clients (e.g. the MCP SDK's `OAuthTokensSchema`)
 * reject the response. Instead of patching each client, the client points its
 * `token_url` at this route: we relay the exchange to Shopify verbatim and, on a
 * 200 that carries an `access_token` but no `token_type`, inject `"Bearer"` (its
 * only correct value). The request body — which carries the `client_secret` — is
 * forwarded as opaque bytes and is never parsed or logged. Nothing is persisted;
 * this stays a stateless relay. The upstream shop comes from a `?shop=` query
 * param and is validated (SSRF guard) before interpolation.
 *
 * `fetchImpl` is injectable for tests; defaults to the global `fetch`.
 */
export function createTokenProxyHandler(
  fetchImpl: typeof fetch = fetch,
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    const shop = normalizeShopDomain(String(req.query.shop ?? ""));
    if (!isValidShopDomain(shop)) {
      res.status(400).json({ error: "invalid_shop" });
      return;
    }
    try {
      const upstream = await fetchImpl(
        `https://${shop}/admin/oauth/access_token`,
        {
          method: "POST",
          headers: {
            "content-type":
              req.get("content-type") ?? "application/x-www-form-urlencoded",
            accept: "application/json",
            ...(req.get("authorization")
              ? { authorization: req.get("authorization") as string }
              : {}),
          },
          // Raw bytes, forwarded as-is. Never parsed (would expose client_secret).
          // express.raw() yields a Buffer; cast for fetch's BodyInit typing.
          body: req.body as unknown as BodyInit,
        },
      );

      const text = await upstream.text();
      let out = text;
      if (upstream.ok) {
        try {
          const json = JSON.parse(text) as Record<string, unknown>;
          if (json && json.access_token && json.token_type == null) {
            out = JSON.stringify({ ...json, token_type: "Bearer" });
          }
        } catch {
          /* non-JSON 200 — pass through untouched */
        }
      }
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.setHeader("content-type", contentType);
      res.status(upstream.status).send(out);
    } catch (err) {
      log(
        "ERROR",
        `/oauth/token proxy error: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(502).json({ error: "token_proxy_error" });
    }
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

  // Token-exchange normalizing proxy. No auth middleware: this route mints the
  // bearer, so it cannot require one. A route-scoped raw body parser captures the
  // urlencoded exchange verbatim (the global express.json() above skips it on a
  // content-type mismatch without consuming the stream).
  app.post(
    "/oauth/token",
    express.raw({ type: "*/*", limit: "64kb" }),
    createTokenProxyHandler(),
  );

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
