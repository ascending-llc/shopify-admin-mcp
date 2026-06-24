import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";

/**
 * Shared infrastructure for the custom analytics report tools (Workstream B).
 *
 * Data source: a paginated order fetch (`fetchOrdersForReport`) with one rich
 * query that covers returns, discounts, regional, and customer-lifecycle needs,
 * so each report aggregates over a common normalized shape instead of issuing
 * its own bespoke query. This is the plan's sanctioned "paginated fallback for
 * small date windows or dev stores"; a `bulkOperationRunQuery` runner is the
 * scaling follow-up for large shops (see SHOPIFY_MCP_FORK_PLAN.md §4 / §8.7).
 *
 * Reports return compact, pre-computed output and state the formula they used
 * (D22), so numbers are interpretable and revisable.
 */

// ── Date range + query filter ─────────────────────────────────────────

export interface DateRangeInput {
  /** ISO date (YYYY-MM-DD) lower bound, inclusive (created_at >=). */
  startDate?: string;
  /** ISO date (YYYY-MM-DD) upper bound, inclusive (created_at <=). */
  endDate?: string;
}

/** Build an Admin API search query for orders in a date range, plus extras. */
export function buildOrderQueryFilter(
  range?: DateRangeInput,
  extra?: string,
): string | undefined {
  const parts: string[] = [];
  if (range?.startDate) parts.push(`created_at:>=${range.startDate}`);
  if (range?.endDate) parts.push(`created_at:<=${range.endDate}`);
  if (extra?.trim()) parts.push(extra.trim());
  return parts.length ? parts.join(" ") : undefined;
}

export function describeRange(range?: DateRangeInput): string {
  const from = range?.startDate ?? "beginning";
  const to = range?.endDate ?? "now";
  return `${from} → ${to}`;
}

// ── Money + SKU helpers ───────────────────────────────────────────────

export function parseMoney(amount?: string | null): number {
  const n = Number(amount);
  return Number.isFinite(n) ? n : 0;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function normalizeSku(sku?: string | null): string {
  return (sku ?? "").trim() || "(no sku)";
}

// ── Normalized report order shape ─────────────────────────────────────

export interface ReportLineItem {
  sku: string;
  title: string;
  quantity: number;
  originalTotal: number;
  discountedTotal: number;
  productTags: string[];
}

export interface ReportRefundLine {
  sku: string;
  title: string;
  quantity: number;
}

export interface ReportCustomer {
  id: string;
  numberOfOrders: number;
  amountSpent: number;
  createdAt: string | null;
  tags: string[];
}

export interface ReportOrder {
  id: string;
  name: string;
  createdAt: string;
  currency: string;
  totalPrice: number;
  subtotal: number;
  totalDiscounts: number;
  discountCodes: string[];
  lineItems: ReportLineItem[];
  refundLines: ReportRefundLine[];
  shippingProvince: string | null;
  shippingCountry: string | null;
  customer: ReportCustomer | null;
}

// ── Paginated order fetch ─────────────────────────────────────────────

const REPORT_ORDERS_QUERY = gql`
  #graphql
  query ReportOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      edges {
        node {
          id
          name
          createdAt
          currencyCode
          discountCodes
          totalPriceSet { shopMoney { amount currencyCode } }
          subtotalPriceSet { shopMoney { amount } }
          totalDiscountsSet { shopMoney { amount } }
          shippingAddress { provinceCode countryCodeV2 }
          customer { id numberOfOrders amountSpent { amount } createdAt tags }
          lineItems(first: 100) {
            edges {
              node {
                sku
                title
                quantity
                originalTotalSet { shopMoney { amount } }
                discountedTotalSet { shopMoney { amount } }
                product { tags }
              }
            }
          }
          refunds(first: 50) {
            id
            refundLineItems(first: 100) {
              edges {
                node {
                  quantity
                  lineItem { sku title }
                }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface RawConnection<T> {
  edges: { node: T }[];
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
}

function mapOrder(node: any): ReportOrder {
  const lineItems: ReportLineItem[] = (node.lineItems?.edges ?? []).map(
    (e: any) => ({
      sku: normalizeSku(e.node.sku),
      title: e.node.title ?? "",
      quantity: e.node.quantity ?? 0,
      originalTotal: parseMoney(e.node.originalTotalSet?.shopMoney?.amount),
      discountedTotal: parseMoney(e.node.discountedTotalSet?.shopMoney?.amount),
      productTags: e.node.product?.tags ?? [],
    }),
  );

  const refundLines: ReportRefundLine[] = (node.refunds ?? []).flatMap(
    (refund: any) =>
      (refund.refundLineItems?.edges ?? []).map((e: any) => ({
        sku: normalizeSku(e.node.lineItem?.sku),
        title: e.node.lineItem?.title ?? "",
        quantity: e.node.quantity ?? 0,
      })),
  );

  return {
    id: node.id,
    name: node.name,
    createdAt: node.createdAt,
    currency: node.totalPriceSet?.shopMoney?.currencyCode ?? node.currencyCode ?? "",
    totalPrice: parseMoney(node.totalPriceSet?.shopMoney?.amount),
    subtotal: parseMoney(node.subtotalPriceSet?.shopMoney?.amount),
    totalDiscounts: parseMoney(node.totalDiscountsSet?.shopMoney?.amount),
    discountCodes: node.discountCodes ?? [],
    lineItems,
    refundLines,
    shippingProvince: node.shippingAddress?.provinceCode ?? null,
    shippingCountry: node.shippingAddress?.countryCodeV2 ?? null,
    customer: node.customer
      ? {
          id: node.customer.id,
          numberOfOrders: Number(node.customer.numberOfOrders ?? 0),
          amountSpent: parseMoney(node.customer.amountSpent?.amount),
          createdAt: node.customer.createdAt ?? null,
          tags: node.customer.tags ?? [],
        }
      : null,
  };
}

export interface FetchOrdersOptions {
  queryFilter?: string;
  /** Hard cap on orders fetched (protects the live token window). */
  maxOrders?: number;
  /** Orders per page. */
  pageSize?: number;
}

/**
 * Fetch orders for a report via cursor pagination, normalized to ReportOrder.
 * Stops at `maxOrders` or when Shopify reports no further pages.
 */
export async function fetchOrdersForReport(
  client: GraphQLClient,
  opts: FetchOrdersOptions = {},
): Promise<ReportOrder[]> {
  const pageSize = opts.pageSize ?? 100;
  const maxOrders = opts.maxOrders ?? 1000;
  const out: ReportOrder[] = [];
  let after: string | undefined;

  while (out.length < maxOrders) {
    const data = (await client.request(REPORT_ORDERS_QUERY, {
      first: Math.min(pageSize, maxOrders - out.length),
      after,
      query: opts.queryFilter,
    })) as { orders: RawConnection<any> };

    for (const edge of data.orders.edges) out.push(mapOrder(edge.node));

    const pageInfo = data.orders.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }

  return out.slice(0, maxOrders);
}

// ── US Census 4-region mapping ────────────────────────────────────────

export type UsRegion = "Northeast" | "Midwest" | "South" | "West";

const US_STATE_REGION: Record<string, UsRegion> = {
  // Northeast
  CT: "Northeast", ME: "Northeast", MA: "Northeast", NH: "Northeast",
  RI: "Northeast", VT: "Northeast", NJ: "Northeast", NY: "Northeast",
  PA: "Northeast",
  // Midwest
  IL: "Midwest", IN: "Midwest", MI: "Midwest", OH: "Midwest", WI: "Midwest",
  IA: "Midwest", KS: "Midwest", MN: "Midwest", MO: "Midwest", NE: "Midwest",
  ND: "Midwest", SD: "Midwest",
  // South
  DE: "South", FL: "South", GA: "South", MD: "South", NC: "South",
  SC: "South", VA: "South", DC: "South", WV: "South", AL: "South",
  KY: "South", MS: "South", TN: "South", AR: "South", LA: "South",
  OK: "South", TX: "South",
  // West
  AZ: "West", CO: "West", ID: "West", MT: "West", NV: "West", NM: "West",
  UT: "West", WY: "West", AK: "West", CA: "West", HI: "West", OR: "West",
  WA: "West",
};

/**
 * Map an order's shipping location to a region label.
 * US states → Census 4-region; non-US → the country code; missing → "Unknown".
 */
export function regionFor(
  countryCode?: string | null,
  provinceCode?: string | null,
): string {
  if (!countryCode) return "Unknown";
  if (countryCode === "US") {
    return provinceCode
      ? (US_STATE_REGION[provinceCode] ?? "US (Other)")
      : "US (Unknown state)";
  }
  return countryCode;
}
