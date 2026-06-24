import { describe, expect, it } from "@jest/globals";

import {
  filterRegistryByMode,
  parsePermissionMode,
} from "./permissionMode.js";
import type { ShopifyTool, ToolRegistryEntry } from "./toolUtils.js";

const fakeTool = (name: string): ShopifyTool =>
  ({ name }) as unknown as ShopifyTool;

const sampleRegistry: ToolRegistryEntry[] = [
  { tool: fakeTool("get-thing"), mode: "read", category: "system" },
  { tool: fakeTool("set-thing"), mode: "write", category: "system" },
  { tool: fakeTool("get-other"), mode: "read", category: "products" },
];

describe("parsePermissionMode", () => {
  it("parses explicit modes", () => {
    expect(parsePermissionMode("read")).toBe("read");
    expect(parsePermissionMode("full")).toBe("full");
  });

  it("is case-insensitive and trims", () => {
    expect(parsePermissionMode("  FULL ")).toBe("full");
    expect(parsePermissionMode("Read")).toBe("read");
  });

  it("defaults to read when unset", () => {
    expect(parsePermissionMode(undefined)).toBe("read");
    expect(parsePermissionMode(null)).toBe("read");
    expect(parsePermissionMode("")).toBe("read");
  });

  it("fails closed on unrecognized values", () => {
    expect(parsePermissionMode("write")).toBe("read");
    expect(parsePermissionMode("garbage")).toBe("read");
    expect(parsePermissionMode("readonly")).toBe("read");
  });

  it("honors SHOPIFY_MCP_READONLY only when mode is unset", () => {
    expect(parsePermissionMode(undefined, "false")).toBe("full");
    expect(parsePermissionMode(undefined, "true")).toBe("read");
    expect(parsePermissionMode("", "false")).toBe("full");
    // Primary var wins over the compat boolean.
    expect(parsePermissionMode("read", "false")).toBe("read");
    expect(parsePermissionMode("full", "true")).toBe("full");
  });
});

describe("filterRegistryByMode", () => {
  it("read mode excludes all write tools", () => {
    const active = filterRegistryByMode(sampleRegistry, "read");
    expect(active.map((e) => e.tool.name)).toEqual(["get-thing", "get-other"]);
    expect(active.every((e) => e.mode === "read")).toBe(true);
  });

  it("full mode includes every tool", () => {
    const active = filterRegistryByMode(sampleRegistry, "full");
    expect(active).toHaveLength(sampleRegistry.length);
  });
});
