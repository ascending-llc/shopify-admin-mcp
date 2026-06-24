import { GraphQLClient } from "graphql-request";

/**
 * Shopify shop domains look like `your-store.myshopify.com`. This is the same
 * shape Shopify validates in the OAuth callback. We validate strictly because
 * `shop_domain` is untrusted routing input that gets interpolated into a URL we
 * make a server-side request to — an unvalidated value is an SSRF/host-injection
 * vector (SHOPIFY_MCP_FORK_PLAN.md §5, O7 security note).
 */
const SHOP_DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN_RE.test(shop);
}

export function normalizeShopDomain(shop: string): string {
  return shop.trim().toLowerCase();
}

/**
 * Build a per-request Shopify Admin GraphQL client for `(shop, bearer)`.
 * The bearer is used directly as the Shopify Admin access token (D12/D15).
 */
export function buildShopifyClient(
  shop: string,
  accessToken: string,
  apiVersion: string,
): GraphQLClient {
  return new GraphQLClient(
    `https://${shop}/admin/api/${apiVersion}/graphql.json`,
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    },
  );
}

export interface ShopRoutingInput {
  /** Forwarded Shopify Admin token. */
  bearer?: string;
  /** X-Shopify-Shop-Domain forwarded by the registry (preferred over the arg). */
  shopDomainHeader?: string;
  apiVersion: string;
}

export interface ShopRoutingResult {
  /** Tool args with `shop_domain` stripped. */
  toolArgs: Record<string, unknown>;
  shopDomain: string;
  client: GraphQLClient;
}

/**
 * Resolve the target shop for an HTTP tool call and build its client. Pure and
 * unit-testable: no AsyncLocalStorage, no MCP. Prefers the registry-forwarded
 * header over the LLM-supplied `shop_domain` arg (D20/O9), rejects a mismatch
 * (confused-deputy pre-check), and validates before URL interpolation (SSRF).
 */
export function resolveShopRouting(
  rawArgs: Record<string, unknown>,
  input: ShopRoutingInput,
): ShopRoutingResult {
  const { shop_domain: argShopRaw, ...toolArgs } = rawArgs;
  const argShop = typeof argShopRaw === "string" ? argShopRaw.trim() : undefined;
  const headerShop = input.shopDomainHeader?.trim();

  if (
    headerShop &&
    argShop &&
    normalizeShopDomain(headerShop) !== normalizeShopDomain(argShop)
  ) {
    throw new Error(
      "shop_domain does not match the authenticated shop for this request.",
    );
  }

  if (!input.bearer) {
    throw new Error(
      "Missing Shopify credential: no Authorization: Bearer token on this request.",
    );
  }

  const shop = headerShop ?? argShop;
  if (!shop) {
    throw new Error(
      "shop_domain is required (no X-Shopify-Shop-Domain header and no shop_domain argument).",
    );
  }
  if (!isValidShopDomain(shop)) {
    throw new Error(
      `Invalid shop_domain "${shop}" (expected <store>.myshopify.com).`,
    );
  }

  const shopDomain = normalizeShopDomain(shop);
  return {
    toolArgs,
    shopDomain,
    client: buildShopifyClient(shopDomain, input.bearer, input.apiVersion),
  };
}
