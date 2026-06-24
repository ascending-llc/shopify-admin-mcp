import type { GraphQLClient } from "graphql-request";
import { z } from "zod";

import { handleToolError } from "../lib/toolUtils.js";
import {
  buildOrderQueryFilter,
  describeRange,
  fetchOrdersForReport,
  regionFor,
  round2,
} from "../lib/reporting.js";

const InputSchema = z.object({
  startDate: z.string().optional().describe("Order created_at lower bound, YYYY-MM-DD"),
  endDate: z.string().optional().describe("Order created_at upper bound, YYYY-MM-DD"),
  skuLimitPerRegion: z
    .number()
    .default(10)
    .describe("Max per-SKU rows to include per region (by sales)"),
  maxOrders: z.number().default(1000).describe("Safety cap on orders scanned"),
});

type Input = z.infer<typeof InputSchema>;

let shopifyClient: GraphQLClient;

interface RegionAgg {
  region: string;
  orders: number;
  units: number;
  sales: number;
  bySku: Map<string, { sku: string; title: string; units: number; sales: number }>;
}

const reportRegionalSales = {
  name: "report-regional-sales",
  description:
    "Sales by region over a date range — US split into Census 4-regions " +
    "(Northeast/Midwest/South/West), non-US grouped by country — with a per-SKU " +
    "breakdown per region. Orders missing a shipping region fall under 'Unknown'.",
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

      const byRegion = new Map<string, RegionAgg>();
      const get = (region: string): RegionAgg => {
        let agg = byRegion.get(region);
        if (!agg) {
          agg = { region, orders: 0, units: 0, sales: 0, bySku: new Map() };
          byRegion.set(region, agg);
        }
        return agg;
      };

      for (const order of orders) {
        const region = regionFor(order.shippingCountry, order.shippingProvince);
        const agg = get(region);
        agg.orders += 1;
        for (const li of order.lineItems) {
          agg.units += li.quantity;
          agg.sales += li.originalTotal;
          let s = agg.bySku.get(li.sku);
          if (!s) {
            s = { sku: li.sku, title: li.title, units: 0, sales: 0 };
            agg.bySku.set(li.sku, s);
          }
          s.units += li.quantity;
          s.sales += li.originalTotal;
        }
      }

      const regions = [...byRegion.values()]
        .map((a) => ({
          region: a.region,
          orders: a.orders,
          units: a.units,
          sales: round2(a.sales),
          skus: [...a.bySku.values()]
            .map((s) => ({ ...s, sales: round2(s.sales) }))
            .sort((x, y) => y.sales - x.sales)
            .slice(0, input.skuLimitPerRegion),
        }))
        .sort((x, y) => y.sales - x.sales);

      return {
        report: "regional-sales",
        dateRange: describeRange(range),
        formula:
          "region from shippingAddress (US states → Census 4-region; non-US → country; " +
          "missing → Unknown); sales = Σ line originalTotal (shop currency, excl. tax & shipping).",
        ordersScanned: orders.length,
        regionsReported: regions.length,
        regions,
      };
    } catch (error) {
      handleToolError("build regional-sales report", error);
    }
  },
};

export { reportRegionalSales };
