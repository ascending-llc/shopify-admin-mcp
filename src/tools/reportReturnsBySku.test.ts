import { describe, expect, it } from "@jest/globals";
import type { GraphQLClient } from "graphql-request";

import { reportReturnsBySku } from "./reportReturnsBySku.js";

/** Build a line-item edge in the shape mapOrder() expects. */
function li(sku: string, title: string, quantity: number) {
  return {
    node: {
      sku,
      title,
      quantity,
      originalTotalSet: { shopMoney: { amount: "10.00" } },
      discountedTotalSet: { shopMoney: { amount: "10.00" } },
      product: { tags: [] },
    },
  };
}

/** Build a refund (list element) with refund line items. */
function refund(lines: { sku: string; title: string; quantity: number }[]) {
  return {
    id: "gid://shopify/Refund/1",
    refundLineItems: {
      edges: lines.map((l) => ({
        node: { quantity: l.quantity, lineItem: { sku: l.sku, title: l.title } },
      })),
    },
  };
}

function orderNode(
  name: string,
  lineItems: ReturnType<typeof li>[],
  refunds: ReturnType<typeof refund>[],
) {
  return {
    id: `gid://shopify/Order/${name}`,
    name,
    createdAt: "2026-06-01T00:00:00Z",
    currencyCode: "USD",
    discountCodes: [],
    totalPriceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    subtotalPriceSet: { shopMoney: { amount: "0.00" } },
    totalDiscountsSet: { shopMoney: { amount: "0.00" } },
    shippingAddress: null,
    customer: null,
    lineItems: { edges: lineItems },
    refunds,
  };
}

/** A one-page fake client returning the supplied order nodes. */
function fakeClient(nodes: unknown[]): GraphQLClient {
  return {
    request: async () => ({
      orders: {
        edges: nodes.map((node) => ({ node })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }),
  } as unknown as GraphQLClient;
}

describe("report-returns-by-sku aggregation", () => {
  it("computes units sold/returned and return rate per SKU, sorted desc", async () => {
    const orders = [
      orderNode(
        "#1001",
        [li("SKU-A", "Widget A", 5), li("SKU-B", "Widget B", 2)],
        [refund([{ sku: "SKU-A", title: "Widget A", quantity: 1 }])],
      ),
      orderNode(
        "#1002",
        [li("SKU-A", "Widget A", 3)],
        [refund([{ sku: "SKU-A", title: "Widget A", quantity: 1 }])],
      ),
    ];
    reportReturnsBySku.initialize(fakeClient(orders));

    const out = (await reportReturnsBySku.execute({
      minUnitsSold: 1,
      limit: 50,
      maxOrders: 1000,
    })) as any;

    expect(out.ordersScanned).toBe(2);
    expect(out.skusReported).toBe(2);

    const a = out.rows.find((r: any) => r.sku === "SKU-A");
    const b = out.rows.find((r: any) => r.sku === "SKU-B");
    expect(a).toMatchObject({ unitsSold: 8, unitsReturned: 2, returnRatePercent: 25 });
    expect(b).toMatchObject({ unitsSold: 2, unitsReturned: 0, returnRatePercent: 0 });

    // Sorted by return rate descending → SKU-A first, and flagged as top returner.
    expect(out.rows[0].sku).toBe("SKU-A");
    expect(out.topReturner.sku).toBe("SKU-A");
  });

  it("excludes SKUs below the minUnitsSold threshold", async () => {
    const orders = [
      orderNode("#1003", [li("RARE", "Rare", 1), li("COMMON", "Common", 10)], []),
    ];
    reportReturnsBySku.initialize(fakeClient(orders));

    const out = (await reportReturnsBySku.execute({
      minUnitsSold: 5,
      limit: 50,
      maxOrders: 1000,
    })) as any;

    expect(out.skusReported).toBe(1);
    expect(out.rows[0].sku).toBe("COMMON");
  });
});
