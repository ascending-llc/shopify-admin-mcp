import type { GraphQLClient } from "graphql-request";
import { z } from "zod";

import { handleToolError } from "../lib/toolUtils.js";
import {
  buildOrderQueryFilter,
  describeRange,
  fetchOrdersForReport,
  round2,
  type ReportOrder,
} from "../lib/reporting.js";

const InputSchema = z.object({
  startDate: z.string().optional().describe("Order created_at lower bound, YYYY-MM-DD"),
  endDate: z.string().optional().describe("Order created_at upper bound, YYYY-MM-DD"),
  vegoTag: z
    .string()
    .default("vego")
    .describe("Product tag that marks a 'vego' product (D17, case-insensitive)"),
  includeDrilldown: z
    .boolean()
    .default(false)
    .describe("Include a per-customer breakdown (customer IDs + metrics, no PII)"),
  maxOrders: z.number().default(1000).describe("Safety cap on orders scanned"),
});

type Input = z.infer<typeof InputSchema>;

let shopifyClient: GraphQLClient;

const DAY_MS = 1000 * 60 * 60 * 24;

function daysBetween(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, (to - from) / DAY_MS);
}

interface CustomerAgg {
  id: string;
  numberOfOrders: number;
  amountSpent: number;
  createdAt: string | null;
  firstVegoOrderDate: string | null;
}

function orderHasVego(order: ReportOrder, vegoTag: string): boolean {
  const tag = vegoTag.toLowerCase();
  return order.lineItems.some((li) =>
    li.productTags.some((t) => t.toLowerCase() === tag),
  );
}

const reportCustomerLifecycle = {
  name: "report-customer-lifecycle",
  description:
    "Customer lifecycle over a date range: new vs. buyback segments, average " +
    "orders, lifetime, total spent, and average days to first 'vego' purchase. " +
    "Defaults to no PII (customer IDs + metrics only).",
  schema: InputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: Input) => {
    try {
      const range = { startDate: input.startDate, endDate: input.endDate };
      const now = new Date().toISOString();
      const orders = await fetchOrdersForReport(shopifyClient, {
        queryFilter: buildOrderQueryFilter(range),
        maxOrders: input.maxOrders,
      });

      const byCustomer = new Map<string, CustomerAgg>();
      for (const order of orders) {
        const c = order.customer;
        if (!c) continue;
        let agg = byCustomer.get(c.id);
        if (!agg) {
          agg = {
            id: c.id,
            numberOfOrders: c.numberOfOrders,
            amountSpent: c.amountSpent,
            createdAt: c.createdAt,
            firstVegoOrderDate: null,
          };
          byCustomer.set(c.id, agg);
        }
        if (orderHasVego(order, input.vegoTag)) {
          if (!agg.firstVegoOrderDate || order.createdAt < agg.firstVegoOrderDate) {
            agg.firstVegoOrderDate = order.createdAt;
          }
        }
      }

      const customers = [...byCustomer.values()];

      const summarize = (segment: string, members: CustomerAgg[]) => {
        const n = members.length;
        const avg = (sel: (c: CustomerAgg) => number | null) => {
          const vals = members
            .map(sel)
            .filter((v): v is number => v !== null);
          return vals.length
            ? round2(vals.reduce((s, v) => s + v, 0) / vals.length)
            : null;
        };
        return {
          segment,
          customers: n,
          avgOrders: avg((c) => c.numberOfOrders),
          avgLifetimeDays: avg((c) => daysBetween(c.createdAt, now)),
          avgDaysToFirstVego: avg((c) =>
            daysBetween(c.createdAt, c.firstVegoOrderDate),
          ),
          totalSpent: round2(members.reduce((s, c) => s + c.amountSpent, 0)),
        };
      };

      // D22: "new" = exactly 1 lifetime order; "buyback" = 2+.
      const newbies = customers.filter((c) => c.numberOfOrders <= 1);
      const buyback = customers.filter((c) => c.numberOfOrders >= 2);

      const result: Record<string, unknown> = {
        report: "customer-lifecycle",
        dateRange: describeRange(range),
        vegoTag: input.vegoTag,
        formula:
          "segment by lifetime numberOfOrders (new = 1, buyback = 2+); " +
          "lifetimeDays = createdAt → now; daysToFirstVego = createdAt → first order " +
          "(within the scanned window) containing a line item whose product carries the " +
          "vego tag — window-limited, so it can under-count for customers whose first " +
          "vego order predates the range.",
        ordersScanned: orders.length,
        customersReported: customers.length,
        segments: [
          summarize("new", newbies),
          summarize("buyback", buyback),
        ],
      };

      if (input.includeDrilldown) {
        result.customers = customers.map((c) => ({
          id: c.id,
          numberOfOrders: c.numberOfOrders,
          amountSpent: round2(c.amountSpent),
          lifetimeDays: round2(daysBetween(c.createdAt, now) ?? 0),
          daysToFirstVego: c.firstVegoOrderDate
            ? round2(daysBetween(c.createdAt, c.firstVegoOrderDate) ?? 0)
            : null,
        }));
      }

      return result;
    } catch (error) {
      handleToolError("build customer-lifecycle report", error);
    }
  },
};

export { reportCustomerLifecycle };
