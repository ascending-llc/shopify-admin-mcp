import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

import { filterRegistryByMode } from "../lib/permissionMode.js";
import { toolRegistry, tools } from "./registry.js";

const names = toolRegistry.map((e) => e.tool.name);

describe("toolRegistry classification", () => {
  it("has no duplicate tool names", () => {
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  it("uses kebab-case tool names", () => {
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("classifies every entry with a valid mode and category", () => {
    const categories = new Set([
      "products",
      "orders",
      "customers",
      "metafields",
      "inventory",
      "reports",
      "system",
    ]);
    for (const entry of toolRegistry) {
      expect(["read", "write"]).toContain(entry.mode);
      expect(categories.has(entry.category)).toBe(true);
    }
  });

  it("keeps `tools` in sync with the registry", () => {
    expect(tools).toHaveLength(toolRegistry.length);
    expect(tools.map((t) => t.name)).toEqual(names);
  });

  // Plan-mandated specific guardrails (D4/D5).
  it("classifies manage-tags as a write tool", () => {
    const entry = toolRegistry.find((e) => e.tool.name === "manage-tags");
    expect(entry?.mode).toBe("write");
  });

  it("classifies get-orders as a read tool", () => {
    const entry = toolRegistry.find((e) => e.tool.name === "get-orders");
    expect(entry?.mode).toBe("read");
  });
});

describe("mode filtering", () => {
  it("read mode exposes zero write tools", () => {
    const active = filterRegistryByMode(toolRegistry, "read");
    expect(active.some((e) => e.mode === "write")).toBe(false);
    expect(active.length).toBeGreaterThan(0);
  });

  it("read mode keeps get-orders active", () => {
    const active = filterRegistryByMode(toolRegistry, "read");
    expect(active.map((e) => e.tool.name)).toContain("get-orders");
  });

  it("full mode exposes every tool, including writes", () => {
    const active = filterRegistryByMode(toolRegistry, "full");
    expect(active).toHaveLength(toolRegistry.length);
    expect(active.some((e) => e.mode === "write")).toBe(true);
  });
});

describe("registry completeness", () => {
  it("represents every tool file in src/tools", async () => {
    const toolsDir = join(process.cwd(), "src", "tools");
    const files = readdirSync(toolsDir).filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        f !== "registry.ts",
    );

    const missing: string[] = [];
    for (const file of files) {
      const mod = await import(`./${file.replace(/\.ts$/, ".js")}`);
      const exportedTools = Object.values(mod).filter(
        (v): v is { name: string } =>
          !!v &&
          typeof v === "object" &&
          typeof (v as { name?: unknown }).name === "string" &&
          typeof (v as { execute?: unknown }).execute === "function",
      );
      for (const t of exportedTools) {
        if (!names.includes(t.name)) {
          missing.push(`${file} → "${t.name}"`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
