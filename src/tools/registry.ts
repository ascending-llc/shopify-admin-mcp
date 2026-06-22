import type { ShopifyTool, ToolRegistryEntry } from "../lib/toolUtils.js";

// Product tools
import { getProducts } from "./getProducts.js";
import { getProductById } from "./getProductById.js";
import { createProduct } from "./createProduct.js";
import { updateProduct } from "./updateProduct.js";
import { deleteProduct } from "./deleteProduct.js";
import { manageProductVariants } from "./manageProductVariants.js";
import { deleteProductVariants } from "./deleteProductVariants.js";
import { manageProductOptions } from "./manageProductOptions.js";

// Order tools
import { getOrders } from "./getOrders.js";
import { getOrderById } from "./getOrderById.js";
import { updateOrder } from "./updateOrder.js";
import { createDraftOrder } from "./createDraftOrder.js";
import { completeDraftOrder } from "./completeDraftOrder.js";
import { orderCancel } from "./orderCancel.js";
import { orderCloseOpen } from "./orderCloseOpen.js";
import { orderMarkAsPaid } from "./orderMarkAsPaid.js";
import { createFulfillment } from "./createFulfillment.js";
import { createRefund } from "./createRefund.js";

// Customer tools
import { getCustomers } from "./getCustomers.js";
import { getCustomerById } from "./getCustomerById.js";
import { getCustomerOrders } from "./getCustomerOrders.js";
import { createCustomer } from "./createCustomer.js";
import { updateCustomer } from "./updateCustomer.js";
import { deleteCustomer } from "./deleteCustomer.js";
import { mergeCustomers } from "./mergeCustomers.js";
import { manageCustomerAddress } from "./manageCustomerAddress.js";

// Metafield tools
import { getMetafields } from "./getMetafields.js";
import { setMetafields } from "./setMetafields.js";
import { deleteMetafields } from "./deleteMetafields.js";

// Convenience / cross-resource tools
import { manageTags } from "./manageTags.js";
import { setInventoryQuantities } from "./setInventoryQuantities.js";

// Configuration & discovery tools
import { getShopInfo } from "./getShopInfo.js";
import { getMetafieldDefinitions } from "./getMetafieldDefinitions.js";
import { getLocations } from "./getLocations.js";
import { getMarkets } from "./getMarkets.js";
import { getCollections } from "./getCollections.js";

// Enhanced order & fulfillment tools
import { getOrderTransactions } from "./getOrderTransactions.js";
import { getFulfillmentOrders } from "./getFulfillmentOrders.js";
import { getOrderRefundDetails } from "./getOrderRefundDetails.js";
import { getCollectionById } from "./getCollectionById.js";

// Inventory & pricing read tools
import { getInventoryLevels } from "./getInventoryLevels.js";
import { getInventoryItems } from "./getInventoryItems.js";
import { getPriceLists } from "./getPriceLists.js";
import { getProductVariantsDetailed } from "./getProductVariantsDetailed.js";

/**
 * The single source of truth for what this server exposes. Every tool is
 * classified explicitly with a read/write `mode` and a `category`:
 * - `mode` drives deploy-time permission filtering (SHOPIFY_MCP_MODE, D2/D3).
 *   Tests enforce that the classification is complete and that no write tool
 *   is registered in read mode.
 * - `category` is for grouping/discovery only.
 *
 * Adding a tool = import it above and add a classified entry here. A tool file
 * that exists but is missing here will fail the registry completeness test.
 */
export const toolRegistry: ToolRegistryEntry[] = [
  // Products (8)
  { tool: getProducts, mode: "read", category: "products" },
  { tool: getProductById, mode: "read", category: "products" },
  { tool: createProduct, mode: "write", category: "products" },
  { tool: updateProduct, mode: "write", category: "products" },
  { tool: deleteProduct, mode: "write", category: "products" },
  { tool: manageProductVariants, mode: "write", category: "products" },
  { tool: deleteProductVariants, mode: "write", category: "products" },
  { tool: manageProductOptions, mode: "write", category: "products" },
  // Orders (10)
  { tool: getOrders, mode: "read", category: "orders" },
  { tool: getOrderById, mode: "read", category: "orders" },
  { tool: updateOrder, mode: "write", category: "orders" },
  { tool: createDraftOrder, mode: "write", category: "orders" },
  { tool: completeDraftOrder, mode: "write", category: "orders" },
  { tool: orderCancel, mode: "write", category: "orders" },
  { tool: orderCloseOpen, mode: "write", category: "orders" },
  { tool: orderMarkAsPaid, mode: "write", category: "orders" },
  { tool: createFulfillment, mode: "write", category: "orders" },
  { tool: createRefund, mode: "write", category: "orders" },
  // Customers (8)
  { tool: getCustomers, mode: "read", category: "customers" },
  { tool: getCustomerById, mode: "read", category: "customers" },
  { tool: getCustomerOrders, mode: "read", category: "customers" },
  { tool: createCustomer, mode: "write", category: "customers" },
  { tool: updateCustomer, mode: "write", category: "customers" },
  { tool: deleteCustomer, mode: "write", category: "customers" },
  { tool: mergeCustomers, mode: "write", category: "customers" },
  { tool: manageCustomerAddress, mode: "write", category: "customers" },
  // Metafields (3)
  { tool: getMetafields, mode: "read", category: "metafields" },
  { tool: setMetafields, mode: "write", category: "metafields" },
  { tool: deleteMetafields, mode: "write", category: "metafields" },
  // Convenience / cross-resource (2)
  // manageTags mutates resource tags → write, even though it preserves existing tags (D4).
  { tool: manageTags, mode: "write", category: "system" },
  { tool: setInventoryQuantities, mode: "write", category: "inventory" },
  // Configuration & discovery (5)
  { tool: getShopInfo, mode: "read", category: "system" },
  { tool: getMetafieldDefinitions, mode: "read", category: "metafields" },
  { tool: getLocations, mode: "read", category: "inventory" },
  { tool: getMarkets, mode: "read", category: "system" },
  { tool: getCollections, mode: "read", category: "products" },
  // Enhanced order & fulfillment (4)
  { tool: getOrderTransactions, mode: "read", category: "orders" },
  { tool: getFulfillmentOrders, mode: "read", category: "orders" },
  { tool: getOrderRefundDetails, mode: "read", category: "orders" },
  { tool: getCollectionById, mode: "read", category: "products" },
  // Inventory & pricing reads (4)
  { tool: getInventoryLevels, mode: "read", category: "inventory" },
  { tool: getInventoryItems, mode: "read", category: "inventory" },
  { tool: getPriceLists, mode: "read", category: "products" },
  { tool: getProductVariantsDetailed, mode: "read", category: "products" },
];

/**
 * Flat list of all tools, derived from the registry. Retained for back-compat;
 * prefer `toolRegistry` (with mode/category) for new code.
 */
export const tools: ShopifyTool[] = toolRegistry.map((entry) => entry.tool);
