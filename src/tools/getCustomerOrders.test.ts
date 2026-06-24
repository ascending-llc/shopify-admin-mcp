import { describe, expect, it } from "@jest/globals";
import type { GraphQLClient } from "graphql-request";

import { getCustomerOrders } from "./getCustomerOrders.js";

/** Capture the variables passed to the GraphQL client. */
function captureClient(): { client: GraphQLClient; lastVars: () => any } {
  let vars: any;
  const client = {
    request: async (_q: unknown, v: unknown) => {
      vars = v;
      return { orders: { edges: [], pageInfo: {} } };
    },
  } as unknown as GraphQLClient;
  return { client, lastVars: () => vars };
}

describe("get-customer-orders id normalization", () => {
  it("accepts a bare numeric id", async () => {
    const { client, lastVars } = captureClient();
    getCustomerOrders.initialize(client);
    await getCustomerOrders.execute({ customerId: "9664121012473", limit: 10 });
    expect(lastVars().query).toBe("customer_id:9664121012473");
  });

  it("accepts a GID and strips it to the numeric id", async () => {
    const { client, lastVars } = captureClient();
    getCustomerOrders.initialize(client);
    await getCustomerOrders.execute({
      customerId: "gid://shopify/Customer/9664121012473",
      limit: 10,
    });
    expect(lastVars().query).toBe("customer_id:9664121012473");
  });
});
