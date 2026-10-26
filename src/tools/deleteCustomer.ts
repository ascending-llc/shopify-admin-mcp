import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { checkUserErrors, handleToolError } from "../lib/toolUtils.js";

// Input schema for deleting a customer
const DeleteCustomerInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "The customer ID — a Shopify GID (gid://shopify/Customer/123) or just the numeric ID (123).",
    )
});

type DeleteCustomerInput = z.infer<typeof DeleteCustomerInputSchema>;

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const deleteCustomer = {
  name: "delete-customer",
  description: "Delete a customer",
  schema: DeleteCustomerInputSchema,

  // Add initialize method to set up the GraphQL client
  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: DeleteCustomerInput) => {
    try {
      const { id } = input;

      // Accept a GID or a bare numeric ID
      const customerGid = id.startsWith("gid://")
        ? id
        : `gid://shopify/Customer/${id}`;

      const query = gql`
        #graphql

        mutation customerDelete($input: CustomerDeleteInput!) {
          customerDelete(input: $input) {
            deletedCustomerId
            userErrors {
              field
              message
            }
          }
        }
      `;

      const data = (await shopifyClient.request(query, {
        input: { id: customerGid }
      })) as {
        customerDelete: {
          deletedCustomerId: string | null;
          userErrors: Array<{ field: string; message: string }>;
        };
      };

      checkUserErrors(data.customerDelete.userErrors, "delete customer");

      return { deletedCustomerId: data.customerDelete.deletedCustomerId };
    } catch (error) {
      handleToolError("delete customer", error);
    }
  }
};

export { deleteCustomer };
