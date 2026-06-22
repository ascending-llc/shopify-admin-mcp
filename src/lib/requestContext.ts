import { AsyncLocalStorage } from "node:async_hooks";
import type { GraphQLClient } from "graphql-request";

/**
 * Per-request context, isolated via AsyncLocalStorage (D9/D15). Under HTTP
 * transport one of these is seeded per request from the forwarded headers; the
 * tool-call wrapper then resolves `shopDomain` and builds the per-request
 * `client`. The context-aware proxy client (shopifyClientProxy) reads `client`
 * from here so the ~40 tool modules stay unchanged.
 *
 * Tokens are never logged; only presence/length is ever surfaced.
 */
export interface RequestContext {
  transportMode: "http" | "stdio";
  apiVersion: string;

  /** Forwarded user's Shopify Admin token (HTTP mode). */
  bearer?: string;
  /** Gateway-asserted identity (HTTP mode). */
  userId?: string;
  username?: string;
  scopes?: string[];
  /** Routing fast-path: X-Shopify-Shop-Domain forwarded by the registry (D20). */
  shopDomainHeader?: string;

  /** Filled by the tool-call wrapper for the active call. */
  shopDomain?: string;
  client?: GraphQLClient;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(
  context: RequestContext,
  fn: () => T | Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    storage.run(context, () => {
      void Promise.resolve(fn()).then(resolve, reject);
    });
  });
}
