// Ad-hoc seed script (dev probe, not part of the build). Creates products with
// SKUs + a "vego" tag, customers, real orders across US states, and refunds, so
// the report tools show real numbers. Run: node seed_test_data.mjs
import { readFileSync } from "node:fs";

const DOMAIN = process.env.MYSHOPIFY_DOMAIN;
const VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";
const TOKEN = readFileSync("/tmp/sk", "utf8").trim();
const URL = `https://${DOMAIN}/admin/api/${VERSION}/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error("GraphQL: " + JSON.stringify(json.errors));
  }
  return json.data;
}

function checkUserErrors(obj, label) {
  const ue = obj?.userErrors ?? [];
  if (ue.length) throw new Error(`${label} userErrors: ` + JSON.stringify(ue));
}

const stamp = Date.now();

async function createProduct(title, sku, price, tags) {
  const created = await gql(
    `mutation($p: ProductCreateInput!) {
      productCreate(product: $p) {
        product { id variants(first: 1) { nodes { id } } }
        userErrors { field message }
      }
    }`,
    { p: { title, tags } },
  );
  checkUserErrors(created.productCreate, `productCreate ${title}`);
  const product = created.productCreate.product;
  const variantId = product.variants.nodes[0].id;

  const upd = await gql(
    `mutation($pid: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $pid, variants: $variants) {
        productVariants { id sku }
        userErrors { field message }
      }
    }`,
    {
      pid: product.id,
      variants: [
        { id: variantId, price, inventoryItem: { sku, tracked: false } },
      ],
    },
  );
  checkUserErrors(upd.productVariantsBulkUpdate, `variantUpdate ${sku}`);
  console.log(`  product ${title} (${sku}) → variant ${variantId}`);
  return variantId;
}

async function createCustomer(firstName, lastName) {
  const r = await gql(
    `mutation($i: CustomerInput!) {
      customerCreate(input: $i) { customer { id } userErrors { field message } }
    }`,
    {
      i: {
        firstName,
        lastName,
        email: `${firstName.toLowerCase()}+${stamp}@example.com`,
      },
    },
  );
  checkUserErrors(r.customerCreate, `customerCreate ${firstName}`);
  console.log(`  customer ${firstName} ${lastName} → ${r.customerCreate.customer.id}`);
  return r.customerCreate.customer.id;
}

async function createOrder({ customerId, province, lines }) {
  const draft = await gql(
    `mutation($i: DraftOrderInput!) {
      draftOrderCreate(input: $i) { draftOrder { id } userErrors { field message } }
    }`,
    {
      i: {
        ...(customerId ? { customerId } : {}),
        shippingAddress: {
          address1: "1 Test St",
          city: "Testville",
          provinceCode: province,
          countryCode: "US",
          zip: "10001",
        },
        lineItems: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      },
    },
  );
  checkUserErrors(draft.draftOrderCreate, "draftOrderCreate");
  const draftId = draft.draftOrderCreate.draftOrder.id;

  const done = await gql(
    `mutation($id: ID!) {
      draftOrderComplete(id: $id, paymentPending: false) {
        draftOrder {
          order {
            id name
            lineItems(first: 20) { nodes { id sku quantity } }
            transactions { id kind gateway }
          }
        }
        userErrors { field message }
      }
    }`,
    { id: draftId },
  );
  checkUserErrors(done.draftOrderComplete, "draftOrderComplete");
  const order = done.draftOrderComplete.draftOrder.order;
  console.log(`  order ${order.name} (${province}) → ${order.id}`);
  return order;
}

async function refund(order, sku, quantity) {
  const li = order.lineItems.nodes.find((n) => n.sku === sku);
  if (!li) throw new Error(`refund: no line item ${sku} on ${order.name}`);
  const saleTxn = order.transactions.find((t) => t.kind === "SALE") ?? order.transactions[0];

  const r = await gql(
    `mutation($i: RefundInput!) {
      refundCreate(input: $i) {
        refund { id totalRefundedSet { shopMoney { amount } } }
        userErrors { field message }
      }
    }`,
    {
      i: {
        orderId: order.id,
        note: "seed refund",
        refundLineItems: [
          { lineItemId: li.id, quantity, restockType: "NO_RESTOCK" },
        ],
        ...(saleTxn
          ? {
              transactions: [
                {
                  orderId: order.id,
                  gateway: saleTxn.gateway,
                  kind: "REFUND",
                  amount: "1.00",
                  parentId: saleTxn.id,
                },
              ],
            }
          : {}),
      },
    },
  );
  checkUserErrors(r.refundCreate, `refundCreate ${sku}`);
  console.log(`  refund ${order.name} ${sku} x${quantity} → ${r.refundCreate.refund.id}`);
}

async function main() {
  console.log("Products:");
  const vBurger = await createProduct("Vego Burger", "VEGO-BURGER", "12.00", ["vego"]);
  const vWrap = await createProduct("Vego Wrap", "VEGO-WRAP", "9.50", ["vego"]);
  const tee = await createProduct("Classic Tee", "TEE-001", "25.00", []);
  const cap = await createProduct("Cap", "CAP-001", "18.00", []);

  console.log("Customers:");
  const ada = await createCustomer("Ada", "New");
  const ben = await createCustomer("Ben", "Repeat");

  console.log("Orders:");
  const o1 = await createOrder({
    customerId: ada,
    province: "NY",
    lines: [{ variantId: tee, quantity: 2 }, { variantId: cap, quantity: 1 }],
  });
  const o2 = await createOrder({
    customerId: ben,
    province: "CA",
    lines: [{ variantId: vBurger, quantity: 3 }, { variantId: tee, quantity: 1 }],
  });
  await createOrder({
    customerId: ben,
    province: "TX",
    lines: [{ variantId: vWrap, quantity: 1 }],
  });
  await createOrder({
    customerId: null,
    province: "IL",
    lines: [{ variantId: cap, quantity: 4 }],
  });

  console.log("Refunds:");
  await refund(o1, "TEE-001", 1);
  await refund(o2, "VEGO-BURGER", 1);

  console.log("\nSeed complete.");
}

main().catch((e) => {
  console.error("SEED FAILED:", e.message);
  process.exit(1);
});
