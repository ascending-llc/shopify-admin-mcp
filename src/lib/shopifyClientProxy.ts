import type { GraphQLClient } from "graphql-request";

import { getRequestContext } from "./requestContext.js";

/**
 * In stdio/local mode there is a single startup client shared by all calls.
 * In HTTP mode there is no default — every call must resolve a per-request
 * client (failing closed if it can't, so a missing credential never silently
 * falls back to someone else's store).
 */
let defaultClient: GraphQLClient | undefined;

export function setDefaultClient(client: GraphQLClient): void {
  defaultClient = client;
}

function activeClient(): GraphQLClient {
  const ctx = getRequestContext();
  if (ctx?.client) return ctx.client;
  if (defaultClient) return defaultClient;
  throw new Error(
    "No Shopify client for this request: missing per-request credential/shop " +
      "and no default client configured.",
  );
}

/**
 * A stable `GraphQLClient`-shaped proxy injected into every tool via
 * `initialize()`. Each property/method access is forwarded to the client that
 * is active for the current request (per-request in HTTP mode, the startup
 * client in stdio mode), so tool modules keep calling `shopifyClient.request()`
 * unchanged (SHOPIFY_MCP_FORK_PLAN.md §5 "Context-aware GraphQL client").
 */
export const shopifyClientProxy: GraphQLClient = new Proxy(
  {} as GraphQLClient,
  {
    get(_target, prop, receiver) {
      const client = activeClient();
      const value = Reflect.get(client, prop, receiver);
      return typeof value === "function" ? value.bind(client) : value;
    },
  },
);
