import type { ToolRegistryEntry } from "./toolUtils.js";

/**
 * Deploy-time permission mode (SHOPIFY_MCP_FORK_PLAN.md §3, D2).
 * - "read": only read tools are registered.
 * - "full": read + write tools are registered.
 * Default is "read" and parsing is fail-closed: any unrecognized value falls
 * back to "read" so a typo can never silently expose write tools.
 */
export type PermissionMode = "read" | "full";

export const DEFAULT_PERMISSION_MODE: PermissionMode = "read";

/**
 * Resolve the active permission mode from env/CLI.
 *
 * Precedence:
 *   1. SHOPIFY_MCP_MODE = "read" | "full" (primary).
 *   2. SHOPIFY_MCP_READONLY = "true"/"false" (compat boolean) — only consulted
 *      when SHOPIFY_MCP_MODE is absent.
 *   3. Default "read".
 *
 * Fail-closed: anything not explicitly "full" (or readonly=false) resolves read.
 */
export function parsePermissionMode(
  modeValue?: string | null,
  readonlyValue?: string | null,
): PermissionMode {
  const mode = modeValue?.trim().toLowerCase();
  if (mode === "full") return "full";
  if (mode === "read") return "read";

  // Only fall back to the compat boolean when the primary var is unset/empty.
  if (mode === undefined || mode === "") {
    const readonly = readonlyValue?.trim().toLowerCase();
    if (readonly === "false") return "full";
    // readonly === "true", unset, or anything else → read.
  }

  return DEFAULT_PERMISSION_MODE;
}

/**
 * In "full" mode every tool is active; in "read" mode only read tools.
 */
export function isEntryActive(
  entry: ToolRegistryEntry,
  mode: PermissionMode,
): boolean {
  return mode === "full" || entry.mode === "read";
}

/**
 * Filter the registry down to the tools that should be registered for `mode`.
 */
export function filterRegistryByMode(
  registry: ToolRegistryEntry[],
  mode: PermissionMode,
): ToolRegistryEntry[] {
  return registry.filter((entry) => isEntryActive(entry, mode));
}
