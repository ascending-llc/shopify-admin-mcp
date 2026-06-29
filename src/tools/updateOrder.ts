import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { checkUserErrors, handleToolError } from "../lib/toolUtils.js";

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

// Input schema for updateOrder
// Based on https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderupdate
const UpdateOrderInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe("The order's Shopify GID, e.g. gid://shopify/Order/123."),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tags to set on the order (replaces the existing tag set)."),
  email: z
    .string()
    .email()
    .optional()
    .describe("Customer-facing email address for the order."),
  note: z.string().optional().describe("Freeform staff note on the order."),
  customAttributes: z
    .array(
      z.object({
        key: z.string().describe("Attribute name."),
        value: z.string().describe("Attribute value.")
      })
    )
    .optional()
    .describe("Custom name/value attributes to attach to the order."),
  metafields: z
    .array(
      z.object({
        id: z
          .string()
          .optional()
          .describe("Existing metafield GID to update (omit to create a new one)."),
        namespace: z
          .string()
          .optional()
          .describe("Metafield namespace (required when creating)."),
        key: z
          .string()
          .optional()
          .describe("Metafield key (required when creating)."),
        value: z.string().describe("Metafield value."),
        type: z
          .string()
          .optional()
          .describe("Metafield type, e.g. single_line_text_field.")
      })
    )
    .optional()
    .describe("Metafields to create or update on the order."),
  phone: z.string().optional().describe("Customer phone number for the order."),
  poNumber: z
    .string()
    .optional()
    .describe("Purchase order number for the order."),
  shippingAddress: z
    .object({
      address1: z.string().optional().describe("Street address line 1."),
      address2: z
        .string()
        .optional()
        .describe("Street address line 2 (apartment, suite, etc.)."),
      city: z.string().optional().describe("City."),
      company: z.string().optional().describe("Company name."),
      countryCode: z
        .string()
        .optional()
        .describe("Two-letter ISO country code, e.g. US."),
      firstName: z.string().optional().describe("Recipient first name."),
      lastName: z.string().optional().describe("Recipient last name."),
      phone: z.string().optional().describe("Recipient phone number."),
      provinceCode: z
        .string()
        .optional()
        .describe("Province/state code, e.g. CA."),
      zip: z.string().optional().describe("Postal/ZIP code.")
    })
    .optional()
    .describe("Shipping address for the order.")
});

type UpdateOrderInput = z.infer<typeof UpdateOrderInputSchema>;

const updateOrder = {
  name: "update-order",
  description: "Update an existing order with new information",
  schema: UpdateOrderInputSchema,

  // Add initialize method to set up the GraphQL client
  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: UpdateOrderInput) => {
    try {
      // Prepare input for GraphQL mutation
      const { id, ...orderFields } = input;

      const query = gql`
        #graphql

        mutation orderUpdate($input: OrderInput!) {
          orderUpdate(input: $input) {
            order {
              id
              name
              email
              note
              tags
              customAttributes {
                key
                value
              }
              metafields(first: 10) {
                edges {
                  node {
                    id
                    namespace
                    key
                    value
                  }
                }
              }
              shippingAddress {
                address1
                address2
                city
                company
                country
                firstName
                lastName
                phone
                province
                zip
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const variables = {
        input: {
          id,
          ...orderFields
        }
      };

      const data = (await shopifyClient.request(query, variables)) as {
        orderUpdate: {
          order: any;
          userErrors: Array<{
            field: string;
            message: string;
          }>;
        };
      };

      checkUserErrors(data.orderUpdate.userErrors, "update order");

      // Format and return the updated order
      const order = data.orderUpdate.order;

      // Return the updated order data
      return {
        order: {
          id: order.id,
          name: order.name,
          email: order.email,
          note: order.note,
          tags: order.tags,
          customAttributes: order.customAttributes,
          metafields:
            order.metafields?.edges.map((edge: any) => edge.node) || [],
          shippingAddress: order.shippingAddress
        }
      };
    } catch (error) {
      handleToolError("update order", error);
    }
  }
};

export { updateOrder };
