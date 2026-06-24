# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is an MCP (Model Context Protocol) server for the **Shopify GraphQL Admin API**. It exposes Shopify store data (products, orders, customers, inventory, metafields, etc.) to LLM clients as a flat set of MCP tools. It is a fork of [`GeLi2001/shopify-mcp`](https://github.com/GeLi2001/shopify-mcp) maintained at `ascending-llc/shopify-admin-mcp`.

- **Language:** TypeScript (ESM, `"type": "module"`, `NodeNext` module resolution).
- **Runtime:** Node ≥ 18, compiled to `dist/` via `tsc`.
- **Transport:** two modes selected by `SHOPIFY_MCP_TRANSPORT` (default `stdio`). **stdio** runs as a local subprocess (e.g. Claude Desktop) via `npx shopify-mcp` with a single store bound at startup. **http** runs the Streamable HTTP transport (`POST /mcp`, `GET /healthz`) for container/Jarvis deployment — no startup credential; the user's Shopify token + `shop_domain` arrive per request.
- **Auth target:** a single Shopify store, configured at process start. This is **not** multi-tenant — one running server talks to one store with one credential.

> Future direction (HTTP transport, container deployment, read/write permission modes, custom analytics report tools) is specified in `SHOPIFY_MCP_FORK_PLAN.md`. That plan is **not yet implemented**; this document describes the repo as it stands today.

## Architecture

The whole server is wired up in three layers. Read these in order to understand a request end-to-end:

### 1. `src/index.ts` — entry point / composition root

This is the `bin` (`#!/usr/bin/env node`). On startup it:

1. Parses CLI args with `minimist` and loads `.env` via `dotenv`. CLI args take precedence over env vars.
2. Resolves credentials and picks an auth mode (see **Authentication** below).
3. Constructs one shared `GraphQLClient` (from `graphql-request`) pointed at `https://<domain>/admin/api/<version>/graphql.json` with the `X-Shopify-Access-Token` header.
4. Resolves the **permission mode** (`parsePermissionMode`, see **Permission modes** below) and filters `toolRegistry` to the active entries (`filterRegistryByMode`).
5. Calls `tool.initialize(client)` on each **active** tool, injecting the shared client.
6. Creates the `McpServer` (its description carries the active mode), then loops the active entries calling `server.tool(name, schema.shape, handler)`. The handler is wrapped with a **fail-closed write guard** (a `write` tool throws unless mode is `full`), runs `tool.execute(args)`, and wraps the result as `{ content: [{ type: "text", text: JSON.stringify(result) }] }`.
7. Connects a `StdioServerTransport`.

### Permission modes (`SHOPIFY_MCP_MODE`)

Every tool is classified `read` or `write` in `toolRegistry` (`src/tools/registry.ts`). The deploy-time mode selects which are exposed:

- `SHOPIFY_MCP_MODE=read` (**default**) — only `read` tools are initialized and registered.
- `SHOPIFY_MCP_MODE=full` — `read` + `write` tools.
- Compat: `SHOPIFY_MCP_READONLY=false` maps to `full` (consulted only when `SHOPIFY_MCP_MODE` is unset). Also overridable via `--mode` / `--readonly` CLI args.
- Parsing is **fail-closed**: any unrecognized value resolves to `read`, so a typo can never expose writes. The active mode is logged to stderr at startup and surfaced in the MCP server description.

Logic lives in `src/lib/permissionMode.ts`; classification is enforced by tests in `src/tools/registry.test.ts` (no duplicates, every tool file represented, `manage-tags` is `write`, `get-orders` is `read`, read mode exposes zero writes).

### 2. `src/tools/registry.ts` — the tool catalog

A single module that imports every tool and exports `toolRegistry: ToolRegistryEntry[]` — the source of truth — where each entry is `{ tool, mode: "read" | "write", category }`. A derived `tools: ShopifyTool[]` (`toolRegistry.map(e => e.tool)`) is kept for back-compat. Adding a tool = create the module, import it here, add **one classified entry**. This is the one place that decides what the server exposes and at which permission level; the completeness test fails if a tool file exists but has no entry.

### 3. `src/lib/toolUtils.ts` — the `ShopifyTool` contract + shared helpers

Every tool is a plain object implementing:

```ts
interface ShopifyTool {
  name: string;                              // kebab-case, e.g. "get-orders"
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;        // Zod input schema; .shape is handed to server.tool()
  initialize(client: GraphQLClient): void;   // stores the shared client in a module-scoped var
  execute(args: Record<string, unknown>): Promise<unknown>;
}
```

Shared helpers in this file (use them, don't reinvent):
- `checkUserErrors(errors, operation)` — throws if Shopify's `userErrors[]` is non-empty (mutations).
- `handleToolError(operation, error)` — normalizes thrown errors and **avoids double-wrapping** the `"Failed to …"` prefix. Call it in every `catch`.
- `edgesToNodes(connection)` — flattens a `{ edges: [{ node }] }` connection into `node[]`.
- `shopMoney(moneyBag)` — pulls `.shopMoney` out of a Shopify MoneyBag.
- Shared types: `ShopifyUserError`, `ShopifyMoney`, `ShopifyEdge`, `ShopifyConnection`.

Output formatting lives in `src/lib/formatters.ts` (e.g. `formatOrderSummary`).

## HTTP transport & per-request auth (Jarvis path)

Under `SHOPIFY_MCP_TRANSPORT=http` the server is a **stateless resource server** (D12/D15): it holds no Shopify credential; the gateway forwards the user's token + identity per request. Key modules:

- `src/server/httpServer.ts` — Express app: `GET /healthz` and `POST /mcp`. Builds **one** stateless `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`, `enableJsonResponse: true`) reused across requests; each request runs inside `runWithContext(...)` so identity/routing are isolated via `AsyncLocalStorage`.
- `src/lib/authMiddleware.ts` — requires `Authorization: Bearer` on `tools/call`; **exempts** `initialize`/`ping`/`tools/list`/`resources/*`/`prompts/*`/`notifications/*` and GET (D9). Returns `401 + WWW-Authenticate`. Ported from the SFDC server. Never logs tokens.
- `src/lib/credentialResolver.ts` — the D15 seam. `PassthroughResolver` (shipped) reads bearer + `X-User-Id`/`X-Username`/`X-Scopes` + `X-Shopify-Shop-Domain`. `SelfHostedOAuthResolver` (path b) is a stub.
- `src/lib/requestContext.ts` — `AsyncLocalStorage<RequestContext>` holding `{ bearer, userId, scopes, shopDomainHeader, apiVersion, shopDomain?, client? }`.
- `src/server/mcpServer.ts` — `createMcpServer(activeEntries, mode, transportMode)`. In http mode it **advertises `shop_domain` on each tool's schema**, then the per-call wrapper **strips it** and calls `resolveShopRouting` to build the per-request client (no tool file is edited).
- `src/lib/shopRouting.ts` — `resolveShopRouting` (pure): prefers the forwarded `X-Shopify-Shop-Domain` over the `shop_domain` arg (D20/O9), rejects a mismatch (confused-deputy pre-check), validates the domain (SSRF guard) before building the client.
- `src/lib/shopifyClientProxy.ts` — a `GraphQLClient`-shaped `Proxy` injected into every tool via `initialize()`. Each access forwards to the active per-request client (http) or the startup client (stdio), so all ~40 tools keep calling `shopifyClient.request(...)` unchanged. Fails closed when no client is resolvable.

In **stdio** mode there is no per-request context: a single startup client is set as the proxy's default and tools route to it (back-compat). `shop_domain` is only advertised in http mode.

> Not yet wired (open items, see `SHOPIFY_MCP_FORK_PLAN.md`): verifying the gateway's internal JWT (`X-Jarvis-Auth`) before trusting `X-User-Id` (O13), and the `list-my-stores` tool (O5). The container currently trusts the gateway's identity headers (network-isolation trust, like the reference servers).

## Tool anatomy

Each tool is one file in `src/tools/`. Canonical pattern (see `src/tools/getOrders.ts` for a read, `src/tools/manageTags.ts` for a write):

```ts
import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError, edgesToNodes, type ShopifyConnection } from "../lib/toolUtils.js";

const InputSchema = z.object({ /* zod fields with .describe() */ });
type Input = z.infer<typeof InputSchema>;

let shopifyClient: GraphQLClient;          // module-scoped, set by initialize()

const myTool = {
  name: "my-tool",                         // kebab-case
  description: "…",
  schema: InputSchema,
  initialize(client: GraphQLClient) { shopifyClient = client; },
  execute: async (input: Input) => {
    try {
      const query = gql`#graphql
        query …`;
      const data = await shopifyClient.request(query, variables);
      return /* compact, formatted result */;
    } catch (error) {
      handleToolError("do the thing", error);   // mutations also call checkUserErrors() first
    }
  },
};

export { myTool };
```

Conventions to keep:
- **Tool `name` is kebab-case** (`get-orders`, `manage-tags`); the **exported binding and filename are camelCase** (`getOrders`). Don't conflate the two.
- Read tools are `get*` / future `report-*`. Write tools are `create*` / `update*` / `delete*` / `manage*` / `set*` / `order*` / `merge*` / `complete*`. `manageTags` mutates and is a **write** tool even though it preserves existing tags. (The fork plan formalizes this read/write split as registry metadata — not yet present.)
- Every GraphQL document starts with the `#graphql` comment so codegen and editor tooling pick it up.
- Import sibling modules with the `.js` extension (required by `NodeNext` ESM), even though the source is `.ts`.
- Tools return JSON-serializable data; `index.ts` does the `JSON.stringify`. Prefer compact, pre-formatted output over raw API dumps.

## Authentication

`src/lib/shopifyAuth.ts` plus logic in `index.ts`. Two mutually exclusive modes, chosen by which credentials are present:

1. **Static access token** (legacy apps): `--accessToken=shpat_…` or `SHOPIFY_ACCESS_TOKEN`. Used directly as `X-Shopify-Access-Token`.
2. **Client credentials** (Dev Dashboard apps, Jan 2026+): `--clientId` + `--clientSecret` (or `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`). As of Jan 1 2026, Shopify no longer issues static Admin tokens for new apps. `ShopifyAuth` performs the OAuth `client_credentials` token exchange against `https://<domain>/admin/oauth/access_token`, caches the short-lived (~24h) token, and **hot-swaps the `X-Shopify-Access-Token` header on the shared `GraphQLClient`** ~5 min before expiry via a self-rescheduling `setTimeout` (which `unref()`s so it never blocks process exit).

Client-credentials mode is preferred when both client ID and secret are set. The domain (`--domain` / `MYSHOPIFY_DOMAIN`) and, optionally, API version (`--apiVersion` / `SHOPIFY_API_VERSION`, default `2026-01`) are always required.

> Note: this is the **app/store-level (offline-style)** credential model — one credential resolved once at startup, shared by all callers — and it is **single-tenant**. This is the *current implementation's* choice, **not** a Shopify limitation: Shopify supports **per-user OAuth "online access mode"** tokens bound to an individual signed-in staff user (carry `associated_user`, expire with the user's session, and make the API enforce that user's own permissions). The planned Jarvis deployment replaces this with a **multi-tenant** model — one always-up container serving many users/companies via a required `shop_domain` tool arg + authorization-code grant + a per-`(user, shop)` credential store + a `list-my-stores` discovery tool. See the "Resolved multi-tenant design" in `SHOPIFY_MCP_FORK_PLAN.md` §5 and decisions D9/D10/D11.

## Commands

```bash
npm install              # install deps
npm run build            # rimraf dist && tsc  → dist/index.js
npm start                # node dist/index.js  (needs build first + credentials/domain)
npm run dev              # ts-node/esm runner against src/index.ts (no build step)
npm test                 # jest (no test files exist yet)
npm run lint             # eslint 'src/**/*.ts'
npm run validate:graphql # graphql-codegen — validates GraphQL docs against the live Shopify schema
npm run clean            # rimraf dist
```

### Running locally for a real store

The server needs credentials + domain. Either pass CLI args:

```bash
node dist/index.js --accessToken=shpat_xxx --domain=your-store.myshopify.com
# or
node dist/index.js --clientId=xxx --clientSecret=yyy --domain=your-store.myshopify.com
```

…or put `SHOPIFY_ACCESS_TOKEN` / `SHOPIFY_CLIENT_ID`+`SHOPIFY_CLIENT_SECRET` / `MYSHOPIFY_DOMAIN` in a `.env` (gitignored) and run `npm start`. For an MCP client like Claude Desktop, register it with `claude mcp add shopify -- npx shopify-mcp --accessToken … --domain …` (see `README.md`).

To exercise tools interactively without a client, use the MCP Inspector:
`npx @modelcontextprotocol/inspector node dist/index.js --accessToken … --domain …`.

## GraphQL codegen validation

`.graphqlrc.ts` configures `@shopify/api-codegen-preset` against the Admin API schema (currently pinned to `2026-01`). `npm run validate:graphql` (and the `.github/workflows/graphql-validate.yml` CI workflow) checks that every `gql` document in `src/**` is valid against Shopify's real schema. When you add or change a query/mutation, run this — a typo'd field name fails here, not at runtime. Keep the API version in `.graphqlrc.ts` in sync with the default in `index.ts`.

## Conventions & gotchas

- **ESM everywhere.** Relative imports must end in `.js`. No CommonJS `require`.
- **`strict` TypeScript.** No implicit `any`; non-null assertions are used sparingly where invariants are known (e.g. after a credential check).
- **Errors surface to the client as thrown `Error`s** with a `"Failed to <operation>: <message>"` shape via `handleToolError`. Don't `console.log` to stdout — stdout is the MCP transport channel; use `console.error` for diagnostics.
- **One shared GraphQL client** is injected into all tools; there is no per-tool client construction.
- `diagnostic.cjs` / `direct_test.cjs` at the repo root are ad-hoc manual probes, not part of the build or test suite.

## Repo layout

```
src/
├── index.ts                 # entry point: arg/env parsing, mode/transport select, stdio-vs-http wiring
├── lib/
│   ├── toolUtils.ts         # ShopifyTool + ToolMode/ToolRegistryEntry types + shared helpers
│   ├── permissionMode.ts    # parsePermissionMode (fail-closed) + filterRegistryByMode
│   ├── requestContext.ts    # AsyncLocalStorage RequestContext (per-request isolation)
│   ├── credentialResolver.ts# CredentialResolver seam: PassthroughResolver (+ stubbed path-b)
│   ├── authMiddleware.ts     # Express bearer auth, exempts discovery/lifecycle (SFDC-ported)
│   ├── shopRouting.ts        # shop_domain validation + resolveShopRouting + per-request client
│   ├── shopifyClientProxy.ts # context-aware GraphQLClient proxy injected into every tool
│   ├── shopifyAuth.ts        # client_credentials OAuth exchange + token auto-refresh (stdio)
│   └── formatters.ts         # response formatting helpers
├── server/
│   ├── mcpServer.ts         # createMcpServer: registration wrapper (shop_domain advertise/strip, write guard)
│   └── httpServer.ts        # Express app: POST /mcp (stateless streamable) + GET /healthz
├── tools/
│   ├── registry.ts          # `toolRegistry[]` (tool + read/write mode + category) — the catalog
│   ├── get*.ts              # read tools
│   └── create*/update*/delete*/manage*/set*/order*/merge*.ts  # write tools
└── **/*.test.ts             # jest (ESM) unit tests (registry, permission, auth, routing, proxy)

Dockerfile, docker-compose.yml       # container build; SHOPIFY_MCP_MODE flag picks read or full (one service)
.github/workflows/{ci,docker-build-push,deploy}.yml  # build/test, ECR push, EKS deploy w/ mode flag (D23)
.graphqlrc.ts                # GraphQL codegen config (schema version pin)
SHOPIFY_MCP_FORK_PLAN.md      # design + decisions; reports (Phase 3+) not yet built
```
