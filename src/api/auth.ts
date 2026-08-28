/**
 * API authentication.
 *
 * This API sits in front of **our** datastore, not Videri's, so it needs its own
 * auth — a Videri JWT says nothing about who may read our aggregates.
 *
 * For now: a shared bearer token, compared in constant time. Deliberately simple
 * and deliberately mandatory — the server refuses to start without a token unless
 * anonymous access is explicitly requested for local development. A read API over
 * a whole fleet's operational data must not be open by accident.
 *
 * The intended end state is validating the Cognito JWT the dashboard already
 * holds and mapping identity through RPM, which already models hierarchical
 * groups, roles and access scopes (docs/02 §9). That gives per-group scoping for
 * free instead of inventing a parallel permission model. Not built yet: it needs
 * the Cognito pool configuration we are still waiting on.
 */

import { timingSafeEqual } from "node:crypto";

export interface AuthConfig {
  token: string | null;
  allowAnonymous: boolean;
}

export function resolveAuth(token: string | undefined, allowAnonymous: boolean): AuthConfig {
  if (allowAnonymous) return { token: null, allowAnonymous: true };
  if (!token || token.trim().length < 16) {
    throw new Error(
      "VFI_API_TOKEN must be set to at least 16 characters to start the read API. " +
        "Pass --allow-anonymous only for local development — it exposes the whole " +
        "fleet's operational data without authentication.",
    );
  }
  return { token, allowAnonymous: false };
}

/** Constant-time comparison, so a wrong token cannot be recovered by timing. */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (a.length !== b.length) {
    // Still perform a comparison so the work is roughly constant.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}
