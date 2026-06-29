import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { checkUserErrors, handleToolError } from "../lib/toolUtils.js";

// Input schema for updating a customer
const UpdateCustomerInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "The customer ID — a Shopify GID (gid://shopify/Customer/123) or just the numeric ID (123).",
    ),
  firstName: z.string().optional().describe("Customer's first name."),
  lastName: z.string().optional().describe("Customer's last name."),
  email: z
    .string()
    .email()
    .optional()
    .describe("Customer's email address (must be unique in the store)."),
  phone: z
    .string()
    .optional()
    .describe("Customer's phone number in E.164 format, e.g. +14155551234."),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tags to set on the customer (replaces the existing tag set)."),
  note: z.string().optional().describe("Freeform staff note about the customer."),
  emailMarketingConsent: z
    .object({
      marketingState: z
        .enum(["NOT_SUBSCRIBED", "SUBSCRIBED", "UNSUBSCRIBED", "PENDING"])
        .describe("The customer's email marketing subscription state."),
      consentUpdatedAt: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp of when consent was last updated."),
      marketingOptInLevel: z
        .enum(["SINGLE_OPT_IN", "CONFIRMED_OPT_IN", "UNKNOWN"])
        .optional()
        .describe("The opt-in level for email marketing consent.")
    })
    .optional()
    .describe("The customer's email marketing consent settings."),
  taxExempt: z
    .boolean()
    .optional()
    .describe("Whether the customer is exempt from taxes."),
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
    .describe("Metafields to create or update on the customer.")
});

type UpdateCustomerInput = z.infer<typeof UpdateCustomerInputSchema>;

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const updateCustomer = {
  name: "update-customer",
  description: "Update a customer's information",
  schema: UpdateCustomerInputSchema,

  // Add initialize method to set up the GraphQL client
  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: UpdateCustomerInput) => {
    try {
      const { id, ...customerFields } = input;

      // Accept a GID or a bare numeric ID
      const customerGid = id.startsWith("gid://")
        ? id
        : `gid://shopify/Customer/${id}`;

      const query = gql`
        #graphql

        mutation customerUpdate($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer {
              id
              firstName
              lastName
              defaultEmailAddress {
                emailAddress
              }
              defaultPhoneNumber {
                phoneNumber
              }
              tags
              note
              taxExempt
              emailMarketingConsent {
                marketingState
                consentUpdatedAt
                marketingOptInLevel
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
          id: customerGid,
          ...customerFields
        }
      };

      const data = (await shopifyClient.request(query, variables)) as {
        customerUpdate: {
          customer: any;
          userErrors: Array<{
            field: string;
            message: string;
          }>;
        };
      };

      checkUserErrors(data.customerUpdate.userErrors, "update customer");

      // Format and return the updated customer
      const customer = data.customerUpdate.customer;

      // Format metafields if they exist
      const metafields =
        customer.metafields?.edges.map((edge: any) => edge.node) || [];

      return {
        customer: {
          id: customer.id,
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.defaultEmailAddress?.emailAddress || null,
          phone: customer.defaultPhoneNumber?.phoneNumber || null,
          tags: customer.tags,
          note: customer.note,
          taxExempt: customer.taxExempt,
          emailMarketingConsent: customer.emailMarketingConsent,
          metafields
        }
      };
    } catch (error) {
      handleToolError("update customer", error);
    }
  }
};

export { updateCustomer };
