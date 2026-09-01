/**
 * Screen-verdict repository tests —
 *   `node --test dist/db/screen-verdict-repo.test.js`
 *
 * Same approach as repository.test.ts: a stub pool that captures SQL and
 * parameters, no database and no migrations. What is guarded here is TARGET
 * SELECTION, because this lane is the one place in the codebase that spends real
 * wall-clock seconds per row it selects, and every way of widening it is silent:
 *
 *   - drop the strict presence join and we spend ~11s of timeout per offline
 *     device. Measured 2026-09-01: 8 of the 9 devices flagged black were offline,
 *     so the wrong filter turns a one-second batch into a ninety-second one that
 *     learns nothing;
 *   - copy the telemetry lane's "was online in the last 30 minutes" instead and a
 *     device that dropped 29 minutes ago is still asked;
 *   - drop the `is_black_screen` join and we command the whole online estate to
 *     hear `no-claim`;
 *   - treat a NULL flag as a claim and we verify devices the platform never
 *     accused;
 *   - drop `retired_at IS NULL` and decommissioned rows come back;
 *   - drop NULLS FIRST / the id tiebreak and the rotation never sweeps.
 *
 * None of those raise an error. Hence asserting the statement itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { Repository } from "./repository.js";

interface Captured {
  sql: string;
  values: unknown[];
}

function stubPool(rows: Array<Record<string, unknown>> = []): {
  pool: Pool;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      captured.push({ sql, values });
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  return { pool, captured };
}

/** Collapse whitespace so multi-line SQL can be matched readably. */
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

// ─── screenVerifyTargets: reachable AND claiming black, and nothing else ─────

test("screenVerifyTargets requires the LATEST presence to be online", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).screenVerifyTargets(5);
  const sql = flat(captured[0]!.sql);

  // The strict idiom: newest presence row only, joined on being online — so a
  // device that went offline one sample ago is excluded.
  assert.match(
    sql,
    /JOIN LATERAL \( SELECT presence FROM health_samples WHERE device_id = d\.id ORDER BY observed_at DESC LIMIT 1 \) hs ON hs\.presence = 'online'/,
  );
  // And explicitly NOT the telemetry lane's looser window.
  assert.doesNotMatch(sql, /interval '30 minutes'/);
  assert.doesNotMatch(sql, /bool_or/);
});

test("screenVerifyTargets only selects devices whose newest READABLE flag claims black", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).screenVerifyTargets(5);
  const sql = flat(captured[0]!.sql);

  // `is_black_screen IS NOT NULL` inside the lateral is what makes this the
  // newest READABLE flag rather than the newest row (which may carry NULL).
  assert.match(
    sql,
    /JOIN LATERAL \( SELECT is_black_screen, observed_at FROM health_samples WHERE device_id = d\.id AND is_black_screen IS NOT NULL ORDER BY observed_at DESC LIMIT 1 \) claim ON claim\.is_black_screen/,
  );
  // An inner JOIN on the truthy flag, so a device not claiming black is absent
  // rather than returned with a false claim.
  assert.doesNotMatch(sql, /LEFT JOIN LATERAL \( SELECT is_black_screen/);
});

test("screenVerifyTargets never targets a retired device", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).screenVerifyTargets(5);
  assert.match(flat(captured[0]!.sql), /d\.retired_at IS NULL/);
});

test("screenVerifyTargets requires an addressable device", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).screenVerifyTargets(5);
  const sql = flat(captured[0]!.sql);
  assert.match(sql, /d\.device_id IS NOT NULL/);
  assert.match(sql, /d\.device_jid IS NOT NULL/);
});

test("screenVerifyTargets rotates stalest-verdict-first, never-verified leading", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).screenVerifyTargets(5);
  const sql = flat(captured[0]!.sql);

  assert.match(sql, /LEFT JOIN LATERAL \( SELECT observed_at FROM device_screen_verdict v/);
  // NULLS FIRST puts a never-verified device at the front; the id tiebreak keeps
  // successive ticks from re-picking the same arbitrary batch out of a tie.
  assert.match(sql, /ORDER BY latest\.observed_at ASC NULLS FIRST, d\.id/);
});

test("screenVerifyTargets binds its batch size, keeping the tick bounded", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).screenVerifyTargets(5);
  assert.match(flat(captured[0]!.sql), /LIMIT \$1/);
  assert.deepEqual(captured[0]!.values, [5]);
});

test("screenVerifyTargets returns the claim instant so the verdict can be dated against it", async () => {
  const claimAt = new Date("2026-09-01T11:58:00Z");
  const { pool } = stubPool([
    {
      id: "canvas-1", device_id: "1000152", device_jid: "1000152@videri",
      player_id: "p1", name: "Center Spark 5",
      is_black_screen: true, claim_observed_at: claimAt,
    },
  ]);
  const [t] = await new Repository(pool).screenVerifyTargets(5);

  assert.equal(t?.id, "canvas-1");
  assert.equal(t?.deviceId, "1000152");
  assert.equal(t?.platformClaim, true);
  assert.equal(t?.claimObservedAt, claimAt);
});

test("screenVerifyTargets on a fleet with nothing to verify is an empty batch, not an error", async () => {
  const { pool } = stubPool([]);
  assert.deepEqual(await new Repository(pool).screenVerifyTargets(5), []);
});

// ─── saveScreenVerdict: persistence shaping ─────────────────────────────────

test("saveScreenVerdict writes every column, with honest nulls intact", async () => {
  const { pool, captured } = stubPool();
  const observedAt = new Date("2026-09-01T12:00:00Z");
  await new Repository(pool).saveScreenVerdict("canvas-1", {
    platformClaim: true,
    deviceIsBlack: null,
    deviceIsShowingLogo: null,
    verdict: "unanswered",
    detail: "the panel did not answer",
    verbsRead: [],
    observedAt,
  });

  const sql = flat(captured[0]!.sql);
  assert.match(sql, /INSERT INTO device_screen_verdict/);
  assert.deepEqual(captured[0]!.values, [
    "canvas-1", observedAt, true, null, null, "unanswered", "the panel did not answer", [],
  ]);
});

test("saveScreenVerdict carries observed_at explicitly rather than defaulting to now()", async () => {
  // The engine's freshness gate compares this instant against the platform
  // sample. Letting the database stamp it would make the row's age the age of
  // the WRITE, not of the answer — and a slow save would then look like a fresher
  // verdict than it is.
  const { pool, captured } = stubPool();
  const observedAt = new Date("2026-09-01T12:00:00Z");
  await new Repository(pool).saveScreenVerdict("canvas-1", {
    platformClaim: true, deviceIsBlack: false, deviceIsShowingLogo: false,
    verdict: "contradicted", detail: "d", verbsRead: ["is_blackscreen"], observedAt,
  });

  assert.match(flat(captured[0]!.sql), /\(device_id, observed_at, platform_claim/);
  assert.equal(captured[0]!.values[1], observedAt);
});

test("saveScreenVerdict writes one row per call and touches nothing else", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).saveScreenVerdict("canvas-1", {
    platformClaim: true, deviceIsBlack: false, deviceIsShowingLogo: null,
    verdict: "contradicted", detail: "d", verbsRead: ["is_blackscreen"],
    observedAt: new Date(),
  });

  assert.equal(captured.length, 1);
  assert.doesNotMatch(flat(captured[0]!.sql), /UPDATE|DELETE/);
});

// ─── latestScreenVerdicts: what the engine reads ────────────────────────────

test("latestScreenVerdicts reads one newest row per device in a single query", async () => {
  const { pool, captured } = stubPool();
  await new Repository(pool).latestScreenVerdicts();

  assert.equal(captured.length, 1, "the engine must never fan this out per device");
  const sql = flat(captured[0]!.sql);
  assert.match(sql, /ORDER BY observed_at DESC LIMIT 1/);
  assert.match(sql, /d\.retired_at IS NULL/, "retired devices stay excluded here too");
});

test("latestScreenVerdicts keys by device and preserves an unanswered null", async () => {
  const observedAt = new Date("2026-09-01T12:00:00Z");
  const { pool } = stubPool([
    { device_id: "canvas-1", verdict: "unanswered", observed_at: observedAt, device_is_black: null },
  ]);
  const map = await new Repository(pool).latestScreenVerdicts();

  assert.equal(map.size, 1);
  assert.equal(map.get("canvas-1")?.verdict, "unanswered");
  assert.equal(map.get("canvas-1")?.observedAt, observedAt);
  assert.equal(map.get("canvas-1")?.deviceIsBlack, null, "null must survive the round trip");
});

test("latestScreenVerdicts on an unverified fleet is an empty map, not a throw", async () => {
  const { pool } = stubPool([]);
  assert.equal((await new Repository(pool).latestScreenVerdicts()).size, 0);
});
