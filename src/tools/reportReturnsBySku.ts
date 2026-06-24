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
  startDate: z
    .string()
    .optional()
    .describe("Lower bound on order created_at, ISO date YYYY-MM-DD (inclusive)"),
  endDate: z
    .string()
    .optional()
    .describe("Upper bound on order created_at, ISO date YYYY-MM-DD (inclusive)"),
  minUnitsSold: z
    .number()
    .default(1)
    .describe("Exclude SKUs with fewer than this many units sold (default 1)"),
  limit: z
    .number()
    .default(50)
    .describe("Max SKU rows to return, sorted by return rate descending"),
  maxOrders: z
    .number()
    .default(1000)
    .describe("Safety cap on orders scanned for the report"),
});

type Input = z.infer<typeof InputSchema>;

let shopifyClient: GraphQLClient;

interface SkuAgg {
  sku: string;
  title: string;
  unitsSold: number;
  unitsReturned: number;
}

const reportReturnsBySku = {
  name: "report-returns-by-sku",
  description:
    "Return ratio per SKU over a date range: units sold vs. units refunded, " +
    "sorted by return rate, with the highest-returning SKU highlighted.",
  schema: InputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: Input) => {
    try {
      const range = { startDate: input.startDate, endDate: input.endDate };
      const queryFilter = buildOrderQueryFilter(range);
      const orders = await fetchOrdersForReport(shopifyClient, {
        queryFilter,
        maxOrders: input.maxOrders,
      });

      const bySku = new Map<string, SkuAgg>();
      const get = (sku: string, title: string): SkuAgg => {
        let agg = bySku.get(sku);
        if (!agg) {
          agg = { sku, title, unitsSold: 0, unitsReturned: 0 };
          bySku.set(sku, agg);
        }
        // Keep the first non-empty title we see.
        if (!agg.title && title) agg.title = title;
        return agg;
      };

      for (const order of orders) {
        for (const li of order.lineItems) {
          get(li.sku, li.title).unitsSold += li.quantity;
        }
        for (const rl of order.refundLines) {
          get(rl.sku, rl.title).unitsReturned += rl.quantity;
        }
      }

      const rows = [...bySku.values()]
        .filter((a) => a.unitsSold >= input.minUnitsSold)
        .map((a) => ({
          sku: a.sku,
          title: a.title,
          unitsSold: a.unitsSold,
          unitsReturned: a.unitsReturned,
          returnRatePercent:
            a.unitsSold > 0
              ? round2((a.unitsReturned / a.unitsSold) * 100)
              : 0,
        }))
        .sort((x, y) => y.returnRatePercent - x.returnRatePercent)
        .slice(0, input.limit);

      return {
        report: "returns-by-sku",
        dateRange: describeRange(range),
        formula:
          "returnRatePercent = unitsReturned / unitsSold * 100; partial refunds " +
          "counted as fractional units; SKUs with unitsSold < minUnitsSold excluded; " +
          "zero-sold SKUs reported as 0%.",
        ordersScanned: orders.length,
        skusReported: rows.length,
        topReturner: rows[0] ?? null,
        rows,
      };
    } catch (error) {
      handleToolError("build returns-by-sku report", error);
    }
  },
};

export { reportReturnsBySku };
