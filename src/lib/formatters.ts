import { z } from "zod";

// ── Shared Zod schemas ────────────────────────────────────────────────

/**
 * Mailing address schema shared by createDraftOrder (shipping + billing)
 * and manageCustomerAddress. Uses countryCode/provinceCode (API input type).
 *
 * NOTE: updateOrder.shippingAddress intentionally uses country/province
 * (different Shopify input type) and is NOT shared here.
 */
export const shippingAddressSchema = z.object({
  address1: z.string().optional().describe("Street address line 1."),
  address2: z
    .string()
    .optional()
    .describe("Street address line 2 (apartment, suite, etc.)."),
  city: z.string().optional().describe("City."),
  company: z.string().optional().describe("Company name."),
  countryCode: z.string().optional().describe("Two-letter country code"),
  firstName: z.string().optional().describe("Recipient first name."),
  lastName: z.string().optional().describe("Recipient last name."),
  phone: z.string().optional().describe("Phone in E.164 format, e.g. +16135551111"),
  provinceCode: z.string().optional().describe("Province/state code, e.g. CA."),
  zip: z.string().optional().describe("Postal/ZIP code."),
});

// ── Shared formatters ─────────────────────────────────────────────────

interface RawLineItemNode {
  id: string;
  title: string;
  quantity: number;
  originalTotalSet: {
    shopMoney: { amount: string; currencyCode: string };
  };
  variant: {
    id: string;
    title: string;
    sku: string;
  } | null;
}

interface RawLineItemConnection {
  edges: Array<{ node: RawLineItemNode }>;
}

/**
 * Format a line-item connection into a clean array.
 * Used by getOrders, getOrderById, and getCustomerOrders.
 */
export function formatLineItems(lineItems: RawLineItemConnection) {
  return lineItems.edges.map((edge) => {
    const item = edge.node;
    return {
      id: item.id,
      title: item.title,
      quantity: item.quantity,
      originalTotal: item.originalTotalSet.shopMoney,
      variant: item.variant
        ? {
            id: item.variant.id,
            title: item.variant.title,
            sku: item.variant.sku,
          }
        : null,
    };
  });
}

interface RawOrderNode {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string;
  displayFulfillmentStatus: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  subtotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  totalShippingPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  totalTaxSet: { shopMoney: { amount: string; currencyCode: string } };
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    defaultEmailAddress?: { emailAddress: string } | null;
    defaultPhoneNumber?: { phoneNumber: string } | null;
  } | null;
  shippingAddress: Record<string, unknown> | null;
  lineItems: RawLineItemConnection;
  tags: string[];
  note: string | null;
}

/**
 * Format a raw order node into the standard order summary shape.
 * Used by getOrders, getCustomerOrders, and getOrderById (as a base).
 */
export function formatOrderSummary(order: RawOrderNode) {
  return {
    id: order.id,
    name: order.name,
    createdAt: order.createdAt,
    financialStatus: order.displayFinancialStatus,
    fulfillmentStatus: order.displayFulfillmentStatus,
    totalPrice: order.totalPriceSet.shopMoney,
    subtotalPrice: order.subtotalPriceSet.shopMoney,
    totalShippingPrice: order.totalShippingPriceSet.shopMoney,
    totalTax: order.totalTaxSet.shopMoney,
    customer: order.customer
      ? {
          id: order.customer.id,
          firstName: order.customer.firstName,
          lastName: order.customer.lastName,
          email: order.customer.defaultEmailAddress?.emailAddress || null,
        }
      : null,
    shippingAddress: order.shippingAddress,
    lineItems: formatLineItems(order.lineItems),
    tags: order.tags,
    note: order.note,
  };
}
