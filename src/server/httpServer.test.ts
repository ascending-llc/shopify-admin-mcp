import { describe, expect, it } from "@jest/globals";
import type { Request, Response } from "express";

import {
  createOAuthDiscoveryHandler,
  createTokenProxyHandler,
} from "./httpServer.js";

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
      port: 3334,
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
    const handler = createOAuthDiscoveryHandler({ port: 3334 });
    const res = mockRes();
    handler(
      mockReq({ headers: { authorization: "Bearer shpat_abc" } }),
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(res.jsonBody?.error).toBe("not_found");
  });

  it("omits authorization_servers when none is configured", () => {
    const handler = createOAuthDiscoveryHandler({ port: 3334 });
    const res = mockRes();
    handler(mockReq(), res);

    expect(res.jsonBody).not.toHaveProperty("authorization_servers");
    expect(res.jsonBody?.scopes_supported).toEqual([]);
  });

  it("honors X-Forwarded-Proto from the gateway", () => {
    const handler = createOAuthDiscoveryHandler({ port: 3334 });
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

// --- token-exchange normalizing proxy -------------------------------------

function proxyReq(opts: {
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
}): Request {
  const headers = opts.headers ?? {};
  return {
    query: opts.query ?? {},
    body: opts.body,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function proxyRes(): Response & {
  statusCode?: number;
  jsonBody?: Record<string, unknown>;
  sentBody?: string;
  headers: Record<string, string>;
} {
  const res = {
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      this.jsonBody = body;
      return this;
    },
    send(body: string) {
      this.sentBody = body;
      return this;
    },
  };
  return res as unknown as Response & {
    statusCode?: number;
    jsonBody?: Record<string, unknown>;
    sentBody?: string;
    headers: Record<string, string>;
  };
}

function fetchResponse(opts: {
  ok: boolean;
  status: number;
  body: string;
  contentType?: string;
}): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    text: async () => opts.body,
    headers: {
      get: (key: string) =>
        key.toLowerCase() === "content-type"
          ? (opts.contentType ?? "application/json")
          : null,
    },
  } as unknown as Response;
}

/** A fetch spy that records calls and returns a fixed response. */
function spyFetch(response: Response | (() => never)): {
  fn: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (typeof response === "function") response();
    return response as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("createTokenProxyHandler (RFC 6749 §5.1 normalization)", () => {
  const SHOP = "ascending-test.myshopify.com";

  it("injects token_type:Bearer on a 200 that omits it, preserving other fields", async () => {
    const { fn, calls } = spyFetch(
      fetchResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({
          access_token: "shpat_abc",
          scope: "read_orders",
          expires_in: 86399,
        }),
      }),
    );
    const res = proxyRes();
    await createTokenProxyHandler(fn)(
      proxyReq({
        query: { shop: SHOP },
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: Buffer.from("grant_type=authorization_code&code=xyz"),
      }),
      res,
    );

    // Forwarded verbatim to the shop's real token endpoint.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://${SHOP}/admin/oauth/access_token`,
    );
    expect(calls[0].init.body).toEqual(
      Buffer.from("grant_type=authorization_code&code=xyz"),
    );

    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.sentBody as string);
    expect(out).toEqual({
      access_token: "shpat_abc",
      scope: "read_orders",
      expires_in: 86399,
      token_type: "Bearer",
    });
  });

  it("leaves a compliant response (token_type present) untouched", async () => {
    const compliant = JSON.stringify({
      access_token: "shpat_abc",
      token_type: "mac",
    });
    const { fn } = spyFetch(
      fetchResponse({ ok: true, status: 200, body: compliant }),
    );
    const res = proxyRes();
    await createTokenProxyHandler(fn)(
      proxyReq({ query: { shop: SHOP }, body: Buffer.from("x") }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.sentBody as string)).toEqual({
      access_token: "shpat_abc",
      token_type: "mac",
    });
  });

  it("forwards the Authorization header (client_secret_basic)", async () => {
    const { fn, calls } = spyFetch(
      fetchResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ access_token: "t" }),
      }),
    );
    await createTokenProxyHandler(fn)(
      proxyReq({
        query: { shop: SHOP },
        headers: { authorization: "Basic Zm9vOmJhcg==" },
        body: Buffer.from(""),
      }),
      proxyRes(),
    );

    expect(
      (calls[0].init.headers as Record<string, string>).authorization,
    ).toBe("Basic Zm9vOmJhcg==");
  });

  it("rejects an invalid shop without calling upstream (SSRF guard)", async () => {
    const { fn, calls } = spyFetch(
      fetchResponse({ ok: true, status: 200, body: "{}" }),
    );
    const res = proxyRes();
    await createTokenProxyHandler(fn)(
      proxyReq({ query: { shop: "evil.example.com" }, body: Buffer.from("x") }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody?.error).toBe("invalid_shop");
    expect(calls).toHaveLength(0);
  });

  it("passes through a non-200 upstream response untouched", async () => {
    const errBody = JSON.stringify({ error: "invalid_request" });
    const { fn } = spyFetch(
      fetchResponse({ ok: false, status: 401, body: errBody }),
    );
    const res = proxyRes();
    await createTokenProxyHandler(fn)(
      proxyReq({ query: { shop: SHOP }, body: Buffer.from("x") }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.sentBody).toBe(errBody);
  });

  it("passes through a non-JSON 200 untouched", async () => {
    const { fn } = spyFetch(
      fetchResponse({
        ok: true,
        status: 200,
        body: "not json",
        contentType: "text/plain",
      }),
    );
    const res = proxyRes();
    await createTokenProxyHandler(fn)(
      proxyReq({ query: { shop: SHOP }, body: Buffer.from("x") }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.sentBody).toBe("not json");
  });

  it("returns 502 when the upstream fetch throws", async () => {
    const { fn } = spyFetch(() => {
      throw new Error("network down");
    });
    const res = proxyRes();
    await createTokenProxyHandler(fn)(
      proxyReq({ query: { shop: SHOP }, body: Buffer.from("x") }),
      res,
    );

    expect(res.statusCode).toBe(502);
    expect(res.jsonBody?.error).toBe("token_proxy_error");
  });
});
