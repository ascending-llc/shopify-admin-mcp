import { describe, expect, it, jest } from "@jest/globals";
import type { GraphQLClient } from "graphql-request";

import { runWithContext } from "./requestContext.js";
import { setDefaultClient, shopifyClientProxy } from "./shopifyClientProxy.js";

function fakeClient(label: string): GraphQLClient {
  return {
    request: jest.fn(async () => `result:${label}`),
  } as unknown as GraphQLClient;
}

const ctxBase = { transportMode: "http" as const, apiVersion: "2026-01" };

describe("shopifyClientProxy", () => {
  it("throws when there is no context and no default client", () => {
    // The proxy resolves the active client at property-access time, so this
    // throws synchronously before `.request` is invoked.
    expect(() => shopifyClientProxy.request("query")).toThrow(
      /No Shopify client/,
    );
  });

  it("forwards to the per-request client from context", async () => {
    const client = fakeClient("ctx");
    const out = await runWithContext({ ...ctxBase, client }, () =>
      shopifyClientProxy.request("query"),
    );
    expect(out).toBe("result:ctx");
    expect(client.request).toHaveBeenCalledWith("query");
  });

  it("falls back to the default client when there is no context", async () => {
    const client = fakeClient("default");
    setDefaultClient(client);
    const out = await shopifyClientProxy.request("query");
    expect(out).toBe("result:default");
    expect(client.request).toHaveBeenCalledTimes(1);
  });
});
