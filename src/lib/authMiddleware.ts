import type { NextFunction, Request, Response } from "express";

import { extractBearer } from "./credentialResolver.js";

/**
 * MCP methods exempt from auth so the registry can discover/enumerate tools
 * unauthenticated (D9). Mirrors the Salesforce DX MCP server's middleware.
 */
const SKIP_AUTH_METHODS = new Set(["initialize", "ping", "tools/list"]);

function isExemptMethod(method: string): boolean {
  if (!method) return true; // OAuth detection probes (empty/invalid body)
  if (SKIP_AUTH_METHODS.has(method)) return true;
  return (
    method.startsWith("resources/") ||
    method.startsWith("prompts/") ||
    method.startsWith("notifications/")
  );
}

/**
 * Requires `Authorization: Bearer <token>` on tool execution while exempting
 * protocol discovery/lifecycle. Never logs token contents (presence only).
 * Returns a 401 with `WWW-Authenticate` so the registry can drive re-auth.
 */
export function shopifyAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // GET = SSE event stream; no per-request user operation.
  if (req.method === "GET") {
    next();
    return;
  }

  const body = req.body as { method?: unknown } | undefined;
  const method = typeof body?.method === "string" ? body.method : "";

  if (isExemptMethod(method)) {
    next();
    return;
  }

  const bearer = extractBearer(
    Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization,
  );

  if (!bearer) {
    const proto =
      (Array.isArray(req.headers["x-forwarded-proto"])
        ? req.headers["x-forwarded-proto"][0]
        : req.headers["x-forwarded-proto"]
      )?.split(",")[0].trim() ?? req.protocol;
    const baseUrl = `${proto}://${req.get("host") ?? "localhost"}`;
    res.setHeader(
      "WWW-Authenticate",
      `Bearer error="invalid_token", error_description="Authorization: Bearer token required", ` +
        `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
    );
    res.status(401).json({
      code: 401,
      error: "invalid_token",
      message: "Unauthorized: Authorization: Bearer token required",
    });
    return;
  }

  next();
}
