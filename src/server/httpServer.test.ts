import { describe, expect, it } from "@jest/globals";
import type { Request, Response } from "express";

import { createOAuthDiscoveryHandler } from "./httpServer.js";

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: "GET",
    headers: {},
    protocol: "https",
    get: () => "shopify-mcp.example.com",
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response & {
  statusCode?: number;
  jsonBody?: Record<string, unknown>;
} {
  const res = {
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      this.jsonBody = body;
      return this;
    },
  };
  return res as unknown as Response & {
    statusCode?: number;
    jsonBody?: Record<string, unknown>;
  };
}

describe("createOAuthDiscoveryHandler (RFC 9728)", () => {
  it("returns protected-resource metadata when no bearer is present", () => {
    const handler = createOAuthDiscoveryHandler({
      port: 8080,
      oauthAuthorizationServer:
        "https://ascending-test.myshopify.com/admin/oauth/authorize",
      scopesSupported: ["read_orders", "read_products"],
    });
    const res = mockRes();
    handler(mockReq(), res);

    expect(res.statusCode).toBeUndefined(); // defaults to 200
    expect(res.jsonBody).toMatchObject({
      resource: "https://shopify-mcp.example.com",
      authorization_servers: [
        "https://ascending-test.myshopify.com/admin/oauth/authorize",
      ],
      scopes_supported: ["read_orders", "read_products"],
      bearer_methods_supported: ["header"],
    });
  });

  it("returns 404 to short-circuit discovery when a bearer is already present", () => {
    const handler = createOAuthDiscoveryHandler({ port: 8080 });
    const res = mockRes();
    handler(
      mockReq({ headers: { authorization: "Bearer shpat_abc" } }),
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(res.jsonBody?.error).toBe("not_found");
  });

  it("omits authorization_servers when none is configured", () => {
    const handler = createOAuthDiscoveryHandler({ port: 8080 });
    const res = mockRes();
    handler(mockReq(), res);

    expect(res.jsonBody).not.toHaveProperty("authorization_servers");
    expect(res.jsonBody?.scopes_supported).toEqual([]);
  });

  it("honors X-Forwarded-Proto from the gateway", () => {
    const handler = createOAuthDiscoveryHandler({ port: 8080 });
    const res = mockRes();
    handler(
      mockReq({
        protocol: "http",
        headers: { "x-forwarded-proto": "https, http" },
      }),
      res,
    );

    expect(res.jsonBody?.resource).toBe("https://shopify-mcp.example.com");
  });
});
