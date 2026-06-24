import { describe, expect, it } from "@jest/globals";
import type { GraphQLClient } from "graphql-request";

import { reportDiscountPerformance } from "./reportDiscountPerformance.js";
import { reportRegionalSales } from "./reportRegionalSales.js";
import { reportCustomerLifecycle } from "./reportCustomerLifecycle.js";

interface LiSpec {
  sku: string;
  title?: string;
  quantity: number;
  original?: number;
  tags?: string[];
}
interface OrderSpec {
  name: string;
  createdAt?: string;
  discountCodes?: string[];
  totalDiscounts?: number;
  country?: string | null;
  province?: string | null;
  customer?: {
    id: string;
    numberOfOrders: number;
    amountSpent: number;
    createdAt: string;
    tags?: string[];
  } | null;
  lineItems: LiSpec[];
  refunds?: { sku: string; title?: string; quantity: number }[];
}

function node(spec: OrderSpec) {
  return {
    id: `gid://shopify/Order/${spec.name}`,
    name: spec.name,
    createdAt: spec.createdAt ?? "2026-06-01T00:00:00Z",
    currencyCode: "USD",
    discountCodes: spec.discountCodes ?? [],
    totalPriceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
    subtotalPriceSet: { shopMoney: { amount: "0.00" } },
    totalDiscountsSet: { shopMoney: { amount: String(spec.totalDiscounts ?? 0) } },
    shippingAddress:
      spec.country === null
        ? null
        : { provinceCode: spec.province ?? null, countryCodeV2: spec.country ?? null },
    customer: spec.customer
      ? {
          id: spec.customer.id,
          numberOfOrders: spec.customer.numberOfOrders,
          amountSpent: { amount: String(spec.customer.amountSpent) },
          createdAt: spec.customer.createdAt,
          tags: spec.customer.tags ?? [],
        }
      : null,
    lineItems: {
      edges: spec.lineItems.map((l) => ({
        node: {
          sku: l.sku,
          title: l.title ?? l.sku,
          quantity: l.quantity,
          originalTotalSet: { shopMoney: { amount: String(l.original ?? 0) } },
          discountedTotalSet: { shopMoney: { amount: String(l.original ?? 0) } },
          product: { tags: l.tags ?? [] },
        },
      })),
    },
    refunds: (spec.refunds ?? []).length
      ? [
          {
            id: "gid://shopify/Refund/1",
            refundLineItems: {
              edges: (spec.refunds ?? []).map((r) => ({
                node: {
                  quantity: r.quantity,
                  lineItem: { sku: r.sku, title: r.title ?? r.sku },
                },
              })),
            },
          },
        ]
      : [],
  };
}

function fakeClient(specs: OrderSpec[]): GraphQLClient {
  return {
    request: async () => ({
      orders: {
        edges: specs.map((s) => ({ node: node(s) })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }),
  } as unknown as GraphQLClient;
}

describe("report-discount-performance", () => {
  it("aggregates per code, attributing multi-code orders to each, with top returned SKU", async () => {
    reportDiscountPerformance.initialize(
      fakeClient([
        {
          name: "#1",
          discountCodes: ["SAVE10"],
          totalDiscounts: 3,
          lineItems: [
            { sku: "A", quantity: 2, original: 20 },
            { sku: "B", quantity: 1, original: 10 },
          ],
          refunds: [{ sku: "A", quantity: 1 }],
        },
        {
          name: "#2",
          discountCodes: ["SAVE10"],
          totalDiscounts: 1,
          lineItems: [{ sku: "A", quantity: 1, original: 10 }],
        },
        { name: "#3", lineItems: [{ sku: "C", quantity: 5, original: 50 }] }, // no code → ignored
      ]),
    );

    const out = (await reportDiscountPerformance.execute({ limit: 50, maxOrders: 1000 })) as any;
    expect(out.codesReported).toBe(1);
    expect(out.rows[0]).toMatchObject({
      code: "SAVE10",
      orders: 2,
      grossSales: 40,
      discountAmount: 4,
      netSales: 36,
      unitsSold: 4,
      unitsReturned: 1,
      topReturnedSku: "A",
    });
  });
});

describe("report-regional-sales", () => {
  it("maps US states to Census regions and sorts by sales", async () => {
    reportRegionalSales.initialize(
      fakeClient([
        { name: "#1", country: "US", province: "NY", lineItems: [{ sku: "A", quantity: 2, original: 20 }] },
        {
          name: "#2",
          country: "US",
          province: "CA",
          lineItems: [
            { sku: "A", quantity: 1, original: 10 },
            { sku: "B", quantity: 3, original: 30 },
          ],
        },
        { name: "#3", country: null, lineItems: [{ sku: "C", quantity: 1, original: 5 }] },
      ]),
    );

    const out = (await reportRegionalSales.execute({ skuLimitPerRegion: 10, maxOrders: 1000 })) as any;
    const names = out.regions.map((r: any) => r.region);
    expect(names).toEqual(["West", "Northeast", "Unknown"]); // by sales: 40, 20, 5
    const west = out.regions.find((r: any) => r.region === "West");
    expect(west.sales).toBe(40);
    expect(west.skus[0]).toMatchObject({ sku: "B", sales: 30 });
  });
});

describe("report-customer-lifecycle", () => {
  it("segments new vs buyback and computes days-to-first-vego", async () => {
    reportCustomerLifecycle.initialize(
      fakeClient([
        {
          name: "#1",
          createdAt: "2026-02-01T00:00:00Z",
          customer: { id: "C1", numberOfOrders: 1, amountSpent: 50, createdAt: "2026-01-01T00:00:00Z" },
          lineItems: [{ sku: "V", quantity: 1, original: 50, tags: ["Vego"] }], // case-insensitive
        },
        {
          name: "#2",
          createdAt: "2026-03-01T00:00:00Z",
          customer: { id: "C2", numberOfOrders: 3, amountSpent: 300, createdAt: "2025-06-01T00:00:00Z" },
          lineItems: [{ sku: "X", quantity: 1, original: 100 }],
        },
      ]),
    );

    const out = (await reportCustomerLifecycle.execute({
      vegoTag: "vego",
      includeDrilldown: false,
      maxOrders: 1000,
    })) as any;

    const newSeg = out.segments.find((s: any) => s.segment === "new");
    const buyback = out.segments.find((s: any) => s.segment === "buyback");
    expect(newSeg).toMatchObject({ customers: 1, avgOrders: 1, totalSpent: 50, avgDaysToFirstVego: 31 });
    expect(buyback).toMatchObject({ customers: 1, avgOrders: 3, totalSpent: 300, avgDaysToFirstVego: null });
  });
});
