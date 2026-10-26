import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { checkUserErrors, handleToolError, edgesToNodes } from "../lib/toolUtils.js";

// Input schema for creating a customer
const CreateCustomerInputSchema = z.object({
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
  tags: z.array(z.string()).optional().describe("Tags to apply to the customer."),
  note: z.string().optional().describe("Freeform staff note about the customer."),
  taxExempt: z
    .boolean()
    .optional()
    .describe("Whether the customer is exempt from taxes."),
  metafields: z
    .array(
      z.object({
        namespace: z.string().describe("Metafield namespace."),
        key: z.string().describe("Metafield key."),
        value: z.string().describe("Metafield value."),
        type: z
          .string()
          .optional()
          .describe("Metafield type, e.g. single_line_text_field.")
      })
    )
    .optional()
    .describe("Metafields to attach to the customer."),
  addresses: z
    .array(
      z.object({
        address1: z.string().optional().describe("Street address line 1."),
        address2: z
          .string()
          .optional()
          .describe("Street address line 2 (apartment, suite, etc.)."),
        city: z.string().optional().describe("City."),
        provinceCode: z
          .string()
          .optional()
          .describe("Province/state code, e.g. CA."),
        zip: z.string().optional().describe("Postal/ZIP code."),
        countryCode: z
          .string()
          .optional()
          .describe("Two-letter ISO country code, e.g. US."),
        phone: z.string().optional().describe("Phone number for this address.")
      })
    )
    .optional()
    .describe("Addresses to associate with the customer.")
});

type CreateCustomerInput = z.infer<typeof CreateCustomerInputSchema>;

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const createCustomer = {
  name: "create-customer",
  description: "Create a new customer",
  schema: CreateCustomerInputSchema,

  // Add initialize method to set up the GraphQL client
  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: CreateCustomerInput) => {
    try {
      const query = gql`
        #graphql

        mutation customerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
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
              createdAt
              updatedAt
              defaultAddress {
                address1
                address2
                city
                provinceCode
                zip
                country
                phone
              }
              addressesV2(first: 10) {
                edges {
                  node {
                    address1
                    address2
                    city
                    provinceCode
                    zip
                    country
                    phone
                  }
                }
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
          ...input
        }
      };

      const data = (await shopifyClient.request(query, variables)) as {
        customerCreate: {
          customer: any;
          userErrors: Array<{
            field: string;
            message: string;
          }>;
        };
      };

      checkUserErrors(data.customerCreate.userErrors, "create customer");

      // Format and return the created customer
      const customer = data.customerCreate.customer;

      // Format metafields if they exist
      const metafields =
        customer.metafields?.edges.map((edge: any) => edge.node) || [];
      const addresses = customer.addressesV2
        ? edgesToNodes(customer.addressesV2)
        : [];

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
          createdAt: customer.createdAt,
          updatedAt: customer.updatedAt,
          defaultAddress: customer.defaultAddress,
          addresses,
          metafields
        }
      };
    } catch (error) {
      handleToolError("create customer", error);
    }
  }
};

export { createCustomer };
