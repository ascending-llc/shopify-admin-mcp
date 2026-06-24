import { describe, expect, it } from "@jest/globals";

import {
  isValidShopDomain,
  normalizeShopDomain,
  resolveShopRouting,
} from "./shopRouting.js";

describe("isValidShopDomain", () => {
  it("accepts well-formed myshopify domains", () => {
    expect(isValidShopDomain("store.myshopify.com")).toBe(true);
    expect(isValidShopDomain("a1-b2.myshopify.com")).toBe(true);
  });

  it("rejects host-injection / SSRF-shaped values", () => {
    expect(isValidShopDomain("evil.com")).toBe(false);
    expect(isValidShopDomain("store.myshopify.com.evil.com")).toBe(false);
    expect(isValidShopDomain("store.myshopify.com/admin")).toBe(false);
    expect(isValidShopDomain("-store.myshopify.com")).toBe(false);
    expect(isValidShopDomain("")).toBe(false);
    expect(isValidShopDomain("http://store.myshopify.com")).toBe(false);
  });
});

describe("normalizeShopDomain", () => {
  it("trims and lowercases", () => {
    expect(normalizeShopDomain("  Store.MyShopify.com ")).toBe(
      "store.myshopify.com",
    );
  });
});

describe("resolveShopRouting", () => {
  const base = { bearer: "shpat_x", apiVersion: "2026-01" };

  it("uses the header shop and strips shop_domain from args", () => {
    const r = resolveShopRouting(
      { id: "123" },
      { ...base, shopDomainHeader: "header.myshopify.com" },
    );
    expect(r.shopDomain).toBe("header.myshopify.com");
    expect(r.toolArgs).toEqual({ id: "123" });
  });

  it("accepts a matching header and arg", () => {
    const r = resolveShopRouting(
      { shop_domain: "Same.myshopify.com", id: "1" },
      { ...base, shopDomainHeader: "same.myshopify.com" },
    );
    expect(r.shopDomain).toBe("same.myshopify.com");
    expect(r.toolArgs).toEqual({ id: "1" });
  });

  it("falls back to the arg when no header", () => {
    const r = resolveShopRouting(
      { shop_domain: "arg.myshopify.com", q: "x" },
      { ...base },
    );
    expect(r.shopDomain).toBe("arg.myshopify.com");
    expect(r.toolArgs).toEqual({ q: "x" });
  });

  it("rejects a header/arg mismatch (confused deputy)", () => {
    expect(() =>
      resolveShopRouting(
        { shop_domain: "arg.myshopify.com" },
        { ...base, shopDomainHeader: "header.myshopify.com" },
      ),
    ).toThrow(/does not match/);
  });

  it("throws when no shop is available", () => {
    expect(() => resolveShopRouting({}, { ...base })).toThrow(/required/);
  });

  it("throws when no bearer is present", () => {
    expect(() =>
      resolveShopRouting(
        { shop_domain: "arg.myshopify.com" },
        { apiVersion: "2026-01" },
      ),
    ).toThrow(/Missing Shopify credential/);
  });

  it("throws on an invalid shop domain", () => {
    expect(() =>
      resolveShopRouting({ shop_domain: "evil.com" }, { ...base }),
    ).toThrow(/Invalid shop_domain/);
  });
});
