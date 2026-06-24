import type { GraphQLClient } from "graphql-request";
import { z } from "zod";

import { handleToolError } from "../lib/toolUtils.js";
import {
  buildOrderQueryFilter,
  describeRange,
  fetchOrdersForReport,
  round2,
} from "../lib/reporting.js";

const InputSchema = z.object({
  startDate: z.string().optional().describe("Order created_at lower bound, YYYY-MM-DD"),
  endDate: z.string().optional().describe("Order created_at upper bound, YYYY-MM-DD"),
  limit: z.number().default(50).describe("Max discount-code rows to return"),
  maxOrders: z.number().default(1000).describe("Safety cap on orders scanned"),
});

type Input = z.infer<typeof InputSchema>;

let shopifyClient: GraphQLClient;

interface CodeAgg {
  code: string;
  orders: number;
  grossSales: number;
  discountAmount: number;
  unitsSold: number;
  unitsReturned: number;
  returnedBySku: Map<string, number>;
}

const reportDiscountPerformance = {
  name: "report-discount-performance",
  description:
    "Per discount-code performance over a date range: orders, gross/net sales, " +
    "discount amount, units sold/returned, and the top returned SKU per code.",
  schema: InputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: Input) => {
    try {
      const range = { startDate: input.startDate, endDate: input.endDate };
      const orders = await fetchOrdersForReport(shopifyClient, {
        queryFilter: buildOrderQueryFilter(range),
        maxOrders: input.maxOrders,
      });

      const byCode = new Map<string, CodeAgg>();
      const get = (code: string): CodeAgg => {
        let agg = byCode.get(code);
        if (!agg) {
          agg = {
            code,
            orders: 0,
            grossSales: 0,
            discountAmount: 0,
            unitsSold: 0,
            unitsReturned: 0,
            returnedBySku: new Map(),
          };
          byCode.set(code, agg);
        }
        return agg;
      };

      for (const order of orders) {
        if (order.discountCodes.length === 0) continue;
        const gross = order.lineItems.reduce((s, li) => s + li.originalTotal, 0);
        const units = order.lineItems.reduce((s, li) => s + li.quantity, 0);
        // An order may carry multiple codes; attribute the order's metrics to
        // each code it used (documented in the formula).
        for (const code of order.discountCodes) {
          const agg = get(code);
          agg.orders += 1;
          agg.grossSales += gross;
          agg.discountAmount += order.totalDiscounts;
          agg.unitsSold += units;
          for (const rl of order.refundLines) {
            agg.unitsReturned += rl.quantity;
            agg.returnedBySku.set(
              rl.sku,
              (agg.returnedBySku.get(rl.sku) ?? 0) + rl.quantity,
            );
          }
        }
      }

      const rows = [...byCode.values()]
        .map((a) => {
          let topReturnedSku: string | null = null;
          let topQty = 0;
          for (const [sku, qty] of a.returnedBySku) {
            if (qty > topQty) {
              topQty = qty;
              topReturnedSku = sku;
            }
          }
          return {
            code: a.code,
            orders: a.orders,
            grossSales: round2(a.grossSales),
            discountAmount: round2(a.discountAmount),
            netSales: round2(a.grossSales - a.discountAmount),
            unitsSold: a.unitsSold,
            unitsReturned: a.unitsReturned,
            topReturnedSku,
          };
        })
        .sort((x, y) => y.netSales - x.netSales)
        .slice(0, input.limit);

      return {
        report: "discount-performance",
        dateRange: describeRange(range),
        formula:
          "grossSales = Σ line originalTotal; netSales = grossSales − discountAmount " +
          "(excludes tax & shipping); an order using multiple codes is attributed to " +
          "each; topReturnedSku = SKU with most refunded units under the code.",
        ordersScanned: orders.length,
        codesReported: rows.length,
        rows,
      };
    } catch (error) {
      handleToolError("build discount-performance report", error);
    }
  },
};

export { reportDiscountPerformance };
