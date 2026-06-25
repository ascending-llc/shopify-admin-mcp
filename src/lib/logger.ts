import { STATUS_CODES } from "node:http";

import type { NextFunction, Request, Response } from "express";

import type { PermissionMode } from "./permissionMode.js";
import type { ToolRegistryEntry } from "./toolUtils.js";
import { toolRegistry } from "../tools/registry.js";

type Level = "INFO" | "WARNING" | "ERROR";

/**
 * Emit a single uvicorn-style `LEVEL:    message` line to stderr. stderr is used
 * for all transports so it never corrupts the stdio JSON-RPC channel.
 */
export function log(level: Level, message: string): void {
  console.error(`${`${level}:`.padEnd(10)}${message}`);
}

/**
 * Startup banner: the transport, the active permission mode, and the full list
 * of exposed tools (uvicorn INFO style). Logged once at boot.
 */
export function logServerInfo(
  transport: string,
  mode: PermissionMode,
  activeEntries: ToolRegistryEntry[],
): void {
  const writes = activeEntries.filter((e) => e.mode === "write").length;
  const reads = activeEntries.length - writes;
  log("INFO", `Shopify Admin MCP — transport=${transport}, mode=${mode}`);
  log(
    "INFO",
    `${activeEntries.length}/${toolRegistry.length} tools active ` +
      `(${reads} read, ${writes} write):`,
  );
  for (const { tool, mode: toolMode } of activeEntries) {
    log("INFO", `  - ${tool.name} (${toolMode})`);
  }
}

/**
 * Express middleware logging every request's outcome as a single uvicorn-style
 * access line: `<client> - "<METHOD> <path> HTTP/<ver>" <status> <reason>`. For
 * POST /mcp the JSON-RPC method (and tool name for `tools/call`) is appended, so
 * each call is one readable line. Registered before the JSON body parser so even
 * parse-error 400s are captured; req.body is populated by the time `finish` fires.
 */
export function accessLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.on("finish", () => {
    const client = `${req.socket.remoteAddress ?? "-"}:${req.socket.remotePort ?? "-"}`;
    const reason = STATUS_CODES[res.statusCode] ?? "";
    let rpc = "";
    if (req.method === "POST" && req.path === "/mcp") {
      const body = req.body as
        | { method?: string; params?: { name?: string } }
        | undefined;
      if (body?.method) {
        const tool =
          body.method === "tools/call" ? body.params?.name : undefined;
        rpc = ` ${body.method}${tool ? ` ${tool}` : ""}`;
      }
    }
    log(
      "INFO",
      `${client} - "${req.method} ${req.originalUrl} HTTP/${req.httpVersion}" ` +
        `${res.statusCode} ${reason}${rpc}`,
    );
  });
  next();
}
