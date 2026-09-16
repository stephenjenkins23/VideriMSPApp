/**
 * Conditional GETs — ETag / `If-None-Match` / 304.
 *
 * WHY. The console re-reads on the poller's cadence (120s) and walks collections
 * a page at a time, so a single idle dashboard re-issues the same handful of
 * queries forever. The rows almost never change between two consecutive reads;
 * the bytes and the JSON parse do. A validator lets an unchanged read cost one
 * round trip and no body.
 *
 * THE FAILURE MODE THIS FILE IS BUILT AROUND. An ETag that does not vary with
 * every input that varies the response serves ONE filter's body for ANOTHER
 * filter's request — a silent wrong answer, strictly worse than no caching at
 * all. Two defences, both deliberate:
 *
 *   1. the validator is computed over the ENTIRE serialised payload, not over a
 *      hand-listed set of "relevant" fields. There is no list to forget to
 *      update when a filter is added;
 *   2. the request's parsed parameters are hashed IN ADDITION, so two requests
 *      that happen to produce identical bodies (two filters that both match
 *      nothing, say) still get distinct validators. Belt and braces, because the
 *      cost is a few bytes of hash input and the cost of getting it wrong is a
 *      wrong answer a client cannot detect.
 *
 * WHY WEAK (`W/"…"`) AND NOT STRONG. Every response in this API carries
 * `meta.freshness.ageSeconds`, which is a pure function of the clock: it differs
 * between any two reads even when the data is byte-identical otherwise. A strong
 * validator asserts byte equality, so it would either be a lie or never match.
 * The weak validator asserts SEMANTIC equivalence, which is exactly the claim we
 * can honestly make: same data, same freshness state, age differs by less than a
 * tick. RFC 9110 §8.8.3.2 specifies weak comparison for `If-None-Match` on GET,
 * so this is the validator conditional requests were designed for.
 *
 * HOW FRESHNESS STAYS HONEST ACROSS A 304. A body-less 304 cannot restate the
 * age, and a client rendering "12 seconds ago" from a cached body would slowly
 * drift into presenting old data as current — the one thing this codebase will
 * not do. So:
 *   - `ageSeconds` is the ONLY field excluded from the validator. Everything else
 *     freshness reports — `newestSampleAt`, `state`, the warnings (which quote the
 *     age in whole minutes) and the per-poller run times — is hashed. A newly
 *     ingested sample, a state change fresh→lagging→stale, or the minute rolling
 *     over on a stale-data warning all change the validator, so a client can
 *     never sit on a cached body whose freshness CLAIM has gone out of date;
 *   - both the 200 and the 304 carry the live age in response HEADERS
 *     (`x-vfi-data-age-seconds`, `x-vfi-data-freshness`), so "how old is this"
 *     is answerable from a 304 without a body.
 */

import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Freshness } from "./freshness.js";

/**
 * Canonical JSON: `JSON.stringify`'s own semantics, with object keys SORTED.
 *
 * `JSON.stringify` preserves insertion order, which is stable for objects built
 * by the same code path — but "stable today" is not a property worth betting a
 * cache on, and a projection rebuilt with its fields in a different order would
 * silently invalidate every client's cache rather than break anything visibly.
 * Sorting makes the digest depend on the VALUES only.
 *
 * WHY `undefined` IS DROPPED FROM AN OBJECT AND NULL-ED IN AN ARRAY. Because
 * that is what `JSON.stringify` does, and a validator must describe the BYTES
 * THE CLIENT WOULD GET. It matters for the request key too: Zod fills an
 * unsupplied optional filter with `undefined`, so `?q=` — which trims to nothing
 * and means "no search" — and an absent `q` produce one tag rather than two.
 * They produce the same response, and two tags for one answer is a cache that
 * never hits.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    // `undefined` in an array serialises as null, not as a hole.
    return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** What identifies a response, beyond its own bytes. */
export interface EtagKey {
  /**
   * The route, as a literal. Two routes that happen to return the same body
   * (two empty collections, say) must not share a validator: a client holding
   * one and revalidating the other would be told its copy is current.
   */
  route: string;
  /**
   * The request's PARSED parameters — after Zod, so defaults are explicit and
   * two spellings of the same request share a validator. Everything that can
   * change the response belongs in here.
   */
  params?: unknown;
}

/**
 * The payload with `meta.freshness.ageSeconds` removed, and nothing else.
 *
 * Narrow on purpose: it strips one named field at one known path rather than
 * every key called `ageSeconds`. Other age fields in this API
 * (`settingsAgeSeconds`, `hierarchyAgeSeconds`) describe the DATA and must stay
 * in the digest — a device whose settings aged out is a different answer.
 */
function validatorSeed(key: EtagKey, payload: unknown): string {
  const body = payload as { data?: unknown; meta?: Record<string, unknown> } | null;
  if (!body || typeof body !== "object" || body.meta === undefined) {
    return stableStringify({ route: key.route, params: key.params ?? null, payload });
  }
  const meta: Record<string, unknown> = { ...body.meta };
  const freshness = meta["freshness"];
  if (freshness && typeof freshness === "object") {
    const { ageSeconds: _clockTick, ...rest } = freshness as Record<string, unknown>;
    meta["freshness"] = rest;
  }
  return stableStringify({
    route: key.route,
    params: key.params ?? null,
    data: body.data,
    meta,
  });
}

/**
 * The validator for one response. Weak, for the reason at the top of this file.
 *
 * 128 bits of a sha-256, hex. Truncated because the full digest buys nothing
 * here — this is a change detector, not a signature, and there is no adversary
 * who profits from colliding two of their own cache entries — and because an
 * `ETag` header rides on every response.
 */
export function etagFor(key: EtagKey, payload: unknown): string {
  const digest = createHash("sha256").update(validatorSeed(key, payload)).digest("hex");
  return `W/"${digest.slice(0, 32)}"`;
}

/**
 * Does the client's `If-None-Match` cover this validator?
 *
 * WEAK COMPARISON, per RFC 9110 §8.8.3.2: the `W/` prefix is ignored on both
 * sides, so a client that stored the tag with or without it still revalidates
 * correctly. `*` matches anything, which for a GET means "I hold a copy".
 *
 * A malformed or absent header is simply "no match" — a client that cannot state
 * what it holds gets the body. Failing towards sending data is the only safe
 * direction: the failure on the other side is serving a 304 to a client that has
 * nothing, which renders an empty page with no error.
 */
export function ifNoneMatchSatisfied(
  header: string | string[] | undefined,
  etag: string,
): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  const normalise = (t: string) => t.trim().replace(/^W\//i, "");
  const mine = normalise(etag);
  for (const candidate of raw.split(",")) {
    const token = normalise(candidate);
    if (token === "*" || token === mine) return true;
  }
  return false;
}

/**
 * Send a payload with a validator, honouring `If-None-Match`.
 *
 * Returns the reply so a route can `return sendConditional(...)`, matching how
 * the rest of the API returns from `reply.send()`.
 *
 * `Cache-Control: private, no-cache` is not a contradiction with the ETag —
 * `no-cache` means "revalidate before reuse", not "do not store". That is
 * precisely the behaviour we want: the client may keep the body, but it may
 * never show it without asking, because whether it is still current is a fact
 * only the server holds. `private` because these responses are per-token fleet
 * data and must not land in a shared cache.
 */
export function sendConditional<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  key: EtagKey,
  payload: T,
  freshness?: Freshness,
): FastifyReply {
  const etag = etagFor(key, payload);
  reply.header("etag", etag);
  reply.header("cache-control", "private, no-cache");
  // Freshness on the ENVELOPE of the response as well as in its body, so a 304
  // — which carries no body by definition — still answers "how old is this".
  // Without this a client revalidating an unchanged snapshot would have to
  // render the age it cached, which drifts, and stale data shown as current is
  // the one failure this API is built to prevent.
  if (freshness) {
    reply.header(
      "x-vfi-data-age-seconds",
      freshness.ageSeconds === null ? "unknown" : String(Math.round(freshness.ageSeconds)),
    );
    reply.header("x-vfi-data-freshness", freshness.state);
  }
  if (ifNoneMatchSatisfied(request.headers["if-none-match"], etag)) {
    return reply.code(304).send();
  }
  return reply.send(payload);
}
