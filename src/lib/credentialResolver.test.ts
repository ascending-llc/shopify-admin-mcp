import { describe, expect, it } from "@jest/globals";

import {
  PassthroughResolver,
  SelfHostedOAuthResolver,
  extractBearer,
} from "./credentialResolver.js";

describe("extractBearer", () => {
  it("extracts the token, case-insensitively", () => {
    expect(extractBearer("Bearer abc123")).toBe("abc123");
    expect(extractBearer("bearer abc123")).toBe("abc123");
    expect(extractBearer("Bearer   spaced  ")).toBe("spaced");
  });

  it("returns undefined for missing/malformed values", () => {
    expect(extractBearer(undefined)).toBeUndefined();
    expect(extractBearer("abc123")).toBeUndefined();
    expect(extractBearer("Bearer ")).toBeUndefined();
    expect(extractBearer("Basic abc")).toBeUndefined();
  });
});

describe("PassthroughResolver", () => {
  const resolver = new PassthroughResolver();

  it("maps forwarded headers into an identity", () => {
    const id = resolver.resolve({
      authorization: "Bearer shpat_token",
      "x-user-id": "user-1",
      "x-username": "alex@example.com",
      "x-scopes": "read_orders read_products",
      "x-shopify-shop-domain": "acme.myshopify.com",
    });
    expect(id).toEqual({
      bearer: "shpat_token",
      userId: "user-1",
      username: "alex@example.com",
      scopes: ["read_orders", "read_products"],
      shopDomainHeader: "acme.myshopify.com",
    });
  });

  it("returns null when no bearer is present", () => {
    expect(resolver.resolve({ "x-user-id": "user-1" })).toBeNull();
  });

  it("handles array-valued headers (takes the first)", () => {
    const id = resolver.resolve({
      authorization: ["Bearer t1", "Bearer t2"],
    });
    expect(id?.bearer).toBe("t1");
  });
});

describe("SelfHostedOAuthResolver", () => {
  it("is a stub that throws (path-b fallback)", () => {
    expect(() => new SelfHostedOAuthResolver().resolve()).toThrow(
      /not implemented/,
    );
  });
});
