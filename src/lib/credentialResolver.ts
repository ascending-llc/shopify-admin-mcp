/**
 * Per-request credential acquisition behind one interface (D15, O8 path a).
 * `PassthroughResolver` is the shipped default: the Jarvis Registry owns OAuth
 * and the gateway forwards the user's Shopify token + identity per request, so
 * the container is a stateless resource server. `SelfHostedOAuthResolver`
 * (path b) is the documented fallback and stays stubbed.
 */

export type IncomingHeaders = Record<string, string | string[] | undefined>;

export interface ResolvedIdentity {
  /** The user's Shopify Admin access token (used directly as the credential). */
  bearer: string;
  /** Gateway-asserted identity (see O13 for trust hardening). */
  userId?: string;
  username?: string;
  scopes?: string[];
  /** Registry-forwarded shop routing fast-path (D20/O9). */
  shopDomainHeader?: string;
}

export interface CredentialResolver {
  /** Returns the resolved identity, or null when no bearer is present. */
  resolve(headers: IncomingHeaders): ResolvedIdentity | null;
}

function headerValue(
  headers: IncomingHeaders,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function extractBearer(authorization?: string): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

export class PassthroughResolver implements CredentialResolver {
  resolve(headers: IncomingHeaders): ResolvedIdentity | null {
    const bearer = extractBearer(headerValue(headers, "authorization"));
    if (!bearer) return null;

    const scopesRaw = headerValue(headers, "x-scopes");
    return {
      bearer,
      userId: headerValue(headers, "x-user-id"),
      username: headerValue(headers, "x-username"),
      scopes: scopesRaw ? scopesRaw.split(/\s+/).filter(Boolean) : undefined,
      shopDomainHeader: headerValue(headers, "x-shopify-shop-domain"),
    };
  }
}

/**
 * Path-b fallback: container-hosted OAuth + per-(user, shop) store. Not built;
 * present so the seam is honored and the upgrade is non-breaking.
 */
export class SelfHostedOAuthResolver implements CredentialResolver {
  resolve(): ResolvedIdentity | null {
    throw new Error(
      "SelfHostedOAuthResolver is not implemented (D15 path-b fallback).",
    );
  }
}
