/**
 * Incident model tests — `node --test dist/intelligence/incidents.test.js`
 *
 * Three of these tests exist because they pin facts that DISPROVED an earlier
 * design, and they are written from the real corpus (local `vfi` DB, 2026-09-16)
 * rather than from convenient fixtures:
 *
 *   - THE LEEDY SITE EXAMPLE. Five screens in one group on
 *     `screen-off-during-schedule`: 72 transitions, 21 half-hour windows, 14 of
 *     them with 3–5 screens firing together. It must be ONE incident with 14
 *     co-firing occurrences and a roster of 5 — not 72 queue rows and not 5
 *     device faults. This is the case that killed keying on (device, rule).
 *
 *   - `CENTER SPARK 5`. 81 `black-screen` transitions on ONE device (81, not the
 *     82 the backlog quotes — see the count comment below), opens in all 24 hours
 *     of the day, mean time-open 18.2 min. One incident, a roster of one, and
 *     classified `oscillating`.
 *
 *   - NO TRANSITION IS EVER LOST. The occurrence windows must PARTITION the
 *     incident's transitions: every alert id present exactly once, nothing
 *     duplicated, nothing dropped. An incident that hid an occurrence would be
 *     worse than the noisy queue it replaces, so this is asserted structurally
 *     rather than trusted.
 *
 * Plus the axis-honesty tests: an unresolvable site must produce a `group` scope
 * that SAYS it is a leaf group, and a groupless device must come out as an
 * `unattributed` single-device incident rather than vanishing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIncidentQueue,
  classifyFlap,
  incidentIdFor,
  scopeFor,
  resumeForOpen,
  MIN_CO_FIRING_DEVICES,
  OCCURRENCE_WINDOW_MS,
  RESUME_CLOCK_SKEW_SECONDS,
  RESUME_FIRST_PASS_SECONDS,
  type AlertTransition,
  type CollectorResume,
  type ResolvedSite,
} from "./incidents.js";

/** No group tree — this session's real condition, and the fallback path. */
const NO_SITE: ResolvedSite = {
  id: null,
  name: null,
  resolved: false,
  reason: "No Videri credentials are configured, so the group hierarchy could not be read.",
};

const site = (id: string, name: string | null): ResolvedSite => ({
  id,
  name,
  resolved: true,
  reason: name === null ? "This site has no display name on the platform." : null,
});

let seq = 0;
const transition = (over: Partial<AlertTransition> = {}): AlertTransition => {
  seq += 1;
  return {
    id: `alert-${String(seq).padStart(4, "0")}`,
    deviceId: "1000921",
    deviceName: "Leedy_Home_Spark3 Portrait",
    groupId: "grp-jay",
    groupName: "Jay",
    ruleId: "screen-off-during-schedule",
    severity: "medium",
    title: "Screen off during schedule",
    openedAt: "2026-08-27T21:40:00.000Z",
    lastFiredAt: "2026-08-27T21:40:00.000Z",
    resolvedAt: "2026-08-28T01:48:00.000Z",
    acknowledgedAt: null,
    site: NO_SITE,
    ...over,
  };
};

/** An open + resolve pair at a chosen instant, for one device. */
const firing = (
  deviceId: string,
  openedAt: string,
  openMinutes: number,
  over: Partial<AlertTransition> = {},
): AlertTransition => {
  const opened = new Date(openedAt).getTime();
  return transition({
    deviceId,
    deviceName: `dev ${deviceId}`,
    openedAt: new Date(opened).toISOString(),
    lastFiredAt: new Date(opened).toISOString(),
    resolvedAt: new Date(opened + openMinutes * 60_000).toISOString(),
    ...over,
  });
};

// ── the Leedy site example ──────────────────────────────────────────────────

/**
 * The real shape, reproduced from the DB rather than invented.
 *
 * Group `Jay` / `screen-off-during-schedule`, measured 2026-09-16: 5 devices, 72
 * transitions, 21 distinct half-hour windows, and this exact
 * devices-per-window histogram —
 *
 *   5 devices × 9 windows = 45 rows ┐
 *   4 devices × 4 windows = 16 rows ├ 14 co-firing windows, 64 rows (89%)
 *   3 devices × 1 window  =  3 rows ┘
 *   2 devices × 1 window  =  2 rows ┐ 7 isolated windows, 8 rows
 *   1 device  × 6 windows =  6 rows ┘
 *
 * The 2-device window is load-bearing: it is what makes this test fail if the
 * co-firing floor is ever lowered from 3, which would start calling a pair of
 * screens a site event.
 */
function leedyCorpus(): AlertTransition[] {
  const devices = ["1027421", "1027422", "1000921", "1000922", "1027424"];
  const windowSizes = [5, 5, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4, 3, 2, 1, 1, 1, 1, 1, 1];
  const rows: AlertTransition[] = [];
  const base = Date.parse("2026-08-27T21:30:00.000Z");
  windowSizes.forEach((size, w) => {
    // 4h apart, so no two windows can collide in one 30-minute bucket. Real
    // recurrences are 6-24h apart, which is exactly why a time-boxed "same
    // incident" window cannot collapse them and an occurrence count must.
    const opened = base + w * 4 * 3_600_000;
    for (let d = 0; d < size; d += 1) {
      // A different device each time, +d minutes, still inside the same bucket:
      // in the real data every row in a window is a different screen.
      rows.push(
        firing(devices[(w + d) % devices.length]!, new Date(opened + d * 60_000).toISOString(), 248),
      );
    }
  });
  return rows;
}

test("the Leedy site example is ONE incident, 14 co-firing occurrences, 5 devices", () => {
  const rows = leedyCorpus();
  assert.equal(rows.length, 72, "fixture must hold the real 72 transitions");

  const queue = buildIncidentQueue(rows);

  // THE headline: 72 transitions collapse to one queue row, not 72 and not 5.
  assert.equal(queue.incidents.length, 1);
  const incident = queue.incidents[0]!;
  assert.equal(incident.transitionCount, 72);
  assert.equal(incident.deviceCount, 5);
  assert.equal(incident.roster.length, 5);
  assert.equal(incident.ruleId, "screen-off-during-schedule");

  // The occurrence count the epic quotes, and the total it is a subset of. BOTH
  // are published: 14 alone would hide 7 real recurrences, 21 alone would lose
  // the co-firing finding.
  assert.equal(incident.occurrences.coFiring, 14);
  assert.equal(incident.occurrences.total, 21);
  assert.equal(incident.occurrences.isolated, 7);
  assert.equal(incident.occurrences.transitionsCoFiring, 64);
  assert.equal(incident.occurrences.transitionsIsolated, 8);

  // Per-device occurrence counts, and they sum to the incident's own total —
  // the roster and the count come from the same set by construction.
  const rosterSum = incident.roster.reduce((a, r) => a + r.transitionCount, 0);
  assert.equal(rosterSum, incident.transitionCount);

  // A site condition that holds open four hours at a time is NOT a flap,
  // however often it recurs.
  assert.equal(incident.flap.classification, "sustained");
  assert.equal(incident.flap.meanOpenMinutes, 248);

  // And the queue-level co-firing statistic is computed from the same rows.
  assert.equal(queue.totals.coFiringEvents, 14);
  assert.equal(queue.totals.coFiringTransitions, 64);
  assert.equal(queue.totals.coFiringSharePercent, 88.9);
});

test("co-firing counts DEVICES, not rows: two alerts from one device is not a site event", () => {
  const rows = [
    firing("d1", "2026-08-27T21:31:00.000Z", 10),
    firing("d1", "2026-08-27T21:32:00.000Z", 10),
    firing("d1", "2026-08-27T21:33:00.000Z", 10),
  ];
  const incident = buildIncidentQueue(rows).incidents[0]!;
  assert.equal(incident.occurrences.total, 1);
  assert.equal(incident.occurrences.coFiring, 0, "3 rows, 1 device — not co-firing");
  assert.equal(incident.occurrences.windows[0]!.deviceCount, 1);
});

test("the co-firing floor is exactly MIN_CO_FIRING_DEVICES", () => {
  const at = "2026-08-27T21:31:00.000Z";
  const below = buildIncidentQueue([
    firing("d1", at, 5),
    firing("d2", at, 5),
  ]).incidents[0]!;
  assert.equal(below.occurrences.coFiring, 0);

  const atFloor = buildIncidentQueue([
    firing("d1", at, 5),
    firing("d2", at, 5),
    firing("d3", at, 5),
  ]).incidents[0]!;
  assert.equal(atFloor.occurrences.coFiring, 1);
  assert.equal(MIN_CO_FIRING_DEVICES, 3);
});

// ── Center Spark 5 ──────────────────────────────────────────────────────────

/**
 * 81 transitions on ONE device, opening in every hour of the day, each clearing
 * in ~18 minutes.
 *
 * 81 and not the backlog's 82: keyed on device ID there are 81 `black-screen`
 * rows on device 1009858. The 82nd belongs to device 1000152, which carries the
 * SAME display name "Center Spark 5" — so 82 is a NAME-keyed count that merges
 * two different screens. That is BUG-1's exact failure mode (resolve by id, never
 * by name), which is why this test pins the id-keyed number.
 */
function centerSparkCorpus(): AlertTransition[] {
  const rows: AlertTransition[] = [];
  const base = Date.parse("2026-08-27T18:01:00.000Z");
  for (let i = 0; i < 81; i += 1) {
    // ~2.32h apart: 81 opens across 188 hours, sweeping every hour of the day.
    rows.push(
      firing("1009858", new Date(base + i * 2.32 * 3_600_000).toISOString(), 18.2, {
        deviceName: "Center Spark 5",
        groupId: "grp-front-sitting",
        groupName: "Front Sitting Area",
        ruleId: "black-screen",
        severity: "critical",
        title: "Screen is black",
      }),
    );
  }
  return rows;
}

test("Center Spark 5 is ONE incident classified oscillating, not 81 queue rows", () => {
  const queue = buildIncidentQueue(centerSparkCorpus());

  assert.equal(queue.incidents.length, 1);
  const incident = queue.incidents[0]!;
  assert.equal(incident.transitionCount, 81);

  // The degenerate case of the SAME structure — a roster of one, not a type.
  assert.equal(incident.deviceCount, 1);
  assert.equal(incident.roster.length, 1);
  assert.equal(incident.roster[0]!.deviceId, "1009858");
  assert.equal(incident.roster[0]!.transitionCount, 81);

  assert.equal(incident.flap.classification, "oscillating");
  assert.equal(incident.flap.distinctHoursOfDay, 24, "opens in every hour of the day");
  assert.ok(
    incident.flap.meanOpenMinutes !== null && incident.flap.meanOpenMinutes < 60,
    "mean time-open must be stated and must be short",
  );
  assert.ok(
    incident.flap.opensPerDay !== null && incident.flap.opensPerDay > 9,
    "opens-per-day must be stated",
  );
  // The classification has to SAY its basis — an operator acts on this without
  // opening the row.
  assert.match(incident.flap.reason, /18\.2 min/);
  assert.match(incident.flap.reason, /24 of the 24 hours/);

  // Single-device incidents are never co-firing, and that is not a missing value.
  assert.equal(incident.occurrences.coFiring, 0);
  assert.equal(queue.totals.coFiringEvents, 0);
});

// ── nothing is ever lost ────────────────────────────────────────────────────

test("every transition stays reachable: the occurrence windows PARTITION the incident", () => {
  const rows = [...leedyCorpus(), ...centerSparkCorpus()];
  const queue = buildIncidentQueue(rows);

  const seen: string[] = [];
  for (const incident of queue.incidents) {
    for (const window of incident.occurrences.windows) seen.push(...window.transitionIds);
  }
  assert.equal(seen.length, rows.length, "no transition dropped, none duplicated");
  assert.deepEqual(
    [...new Set(seen)].sort(),
    rows.map((r) => r.id).sort(),
    "the set of reachable alert ids IS the set handed in",
  );

  // The same statement as a number the API publishes, so a client can assert it.
  assert.equal(queue.reconciliation.transitionsIn, rows.length);
  assert.equal(queue.reconciliation.transitionsInIncidents, rows.length);
  assert.equal(queue.reconciliation.transitionsInOccurrenceWindows, rows.length);
  assert.equal(queue.reconciliation.distinctTransitionIds, rows.length);
  assert.equal(queue.reconciliation.balanced, true);

  // Sums, not spot checks: the totals cannot come from a wider set than the rows.
  const transitionSum = queue.incidents.reduce((a, i) => a + i.transitionCount, 0);
  assert.equal(transitionSum, rows.length);
  const rosterSum = queue.incidents.reduce(
    (a, i) => a + i.roster.reduce((b, r) => b + r.transitionCount, 0),
    0,
  );
  assert.equal(rosterSum, rows.length);
  // And each incident's drilldown names every device on its own roster, so the
  // expansion cannot list fewer devices than the row claims.
  for (const incident of queue.incidents) {
    assert.deepEqual(
      [...incident.drilldown.deviceIds].sort(),
      incident.roster.map((r) => r.deviceId).sort(),
    );
  }
});

// ── the axis is labelled honestly ───────────────────────────────────────────

test("with no group tree the scope is a LEAF GROUP and says so", () => {
  const queue = buildIncidentQueue([transition()], {
    hierarchyReason: "No Videri credentials are configured.",
  });
  const scope = queue.incidents[0]!.scope;
  assert.equal(scope.axis, "group");
  assert.equal(scope.id, "grp-jay");
  assert.equal(scope.siteResolved, false);
  assert.match(scope.reason!, /LEAF group/);
  assert.equal(queue.grouping.axis, "group");
  assert.equal(queue.grouping.siteAxisAvailable, false);
  // The label must not be able to read as "site".
  assert.match(queue.grouping.axisLabel, /NOT site/);
  assert.match(queue.grouping.reason, /UPPER BOUND/);
  assert.match(queue.grouping.reason, /No Videri credentials/);
});

test("with a group tree the scope IS the site, and the label changes with it", () => {
  const rows = [
    transition({ deviceId: "d1", groupId: "grp-jay", site: site("site-mtl", "Montreal Office") }),
    transition({ deviceId: "d2", groupId: "grp-other", site: site("site-mtl", "Montreal Office") }),
  ];
  const queue = buildIncidentQueue(rows);
  // TWO leaf groups, ONE site: this is the collapse the leaf-group fallback
  // cannot reach, and the reason its count is an upper bound.
  assert.equal(queue.incidents.length, 1);
  const scope = queue.incidents[0]!.scope;
  assert.equal(scope.axis, "site");
  assert.equal(scope.id, "site-mtl");
  assert.equal(scope.label, "Montreal Office");
  assert.equal(scope.siteResolved, true);
  assert.equal(queue.grouping.axis, "site");
  assert.match(queue.grouping.axisLabel, /depth-1 ancestor/);
});

test("a groupless device is UNATTRIBUTED — never dropped, never folded in", () => {
  const rows = [
    transition({ deviceId: "d1", groupId: "grp-jay", groupName: "Jay" }),
    transition({ deviceId: "d2", groupId: "grp-jay", groupName: "Jay" }),
    transition({ deviceId: "orphan", deviceName: "Center spark 5", groupId: null, groupName: null }),
  ];
  const queue = buildIncidentQueue(rows);

  assert.equal(queue.totals.transitions, 3);
  assert.equal(queue.totals.unattributedTransitions, 1);
  assert.equal(queue.grouping.incidentsByAxis.device, 1);
  assert.equal(queue.grouping.incidentsByAxis.group, 1);

  const orphan = queue.incidents.find((i) => i.scope.axis === "device")!;
  assert.equal(orphan.scope.id, "orphan");
  assert.match(orphan.scope.reason!, /Unattributed/);
  assert.match(queue.grouping.reason, /UNATTRIBUTED/);
  // It did NOT join the Jay roster, which would have invented a site membership.
  const jay = queue.incidents.find((i) => i.scope.axis === "group")!;
  assert.deepEqual(jay.roster.map((r) => r.deviceId), ["d1", "d2"]);
  // An unattributed row can never co-fire, so it must not be in the attributed
  // denominator either.
  assert.equal(queue.totals.coFiringShareOfAttributedPercent, 0);
});

test("the same device+rule in two groups stays two incidents; the key is scope, not name", () => {
  const rows = [
    transition({ deviceId: "1009858", deviceName: "Center Spark 5", groupId: "grp-a", ruleId: "black-screen" }),
    transition({ deviceId: "1000152", deviceName: "Center Spark 5", groupId: "grp-b", ruleId: "black-screen" }),
  ];
  const queue = buildIncidentQueue(rows);
  assert.equal(queue.incidents.length, 2, "two screens sharing a display name are two incidents");
  assert.notEqual(queue.incidents[0]!.id, queue.incidents[1]!.id);
});

test("the incident id is deterministic and is the key the queue groups on", () => {
  const row = transition();
  const id = incidentIdFor(row);
  assert.equal(buildIncidentQueue([row]).incidents[0]!.id, id);
  assert.equal(incidentIdFor(row), id, "same input, same id — safe across polls");
  assert.equal(scopeFor(row).axis, "group");
});

// ── honest nulls in the flap classification ─────────────────────────────────

test("nothing resolved means mean time-open is NULL with a reason, never zero", () => {
  const rows = [0, 1, 2].map((i) =>
    transition({
      deviceId: `d${i}`,
      openedAt: new Date(Date.parse("2026-08-27T00:00:00.000Z") + i * 86_400_000).toISOString(),
      lastFiredAt: new Date(Date.parse("2026-08-27T00:00:00.000Z") + i * 86_400_000).toISOString(),
      resolvedAt: null,
    }),
  );
  const incident = buildIncidentQueue(rows).incidents[0]!;
  assert.equal(incident.state, "open");
  assert.equal(incident.openTransitions, 3);
  assert.equal(incident.flap.meanOpenMinutes, null);
  assert.equal(incident.flap.classification, "indeterminate");
  assert.match(incident.flap.reason, /null, not zero/);
});

test("too few transitions, or too short a span, is indeterminate and says which", () => {
  const thin = classifyFlap({
    transitionCount: 2,
    openTransitions: 0,
    resolvedCount: 2,
    resolvedDurationMs: 5 * 60_000,
    spanMs: 3 * 86_400_000,
    distinctHoursOfDay: 2,
  });
  assert.equal(thin.classification, "indeterminate");
  assert.match(thin.reason, /fewer than the 3/);

  const brief = classifyFlap({
    transitionCount: 5,
    openTransitions: 0,
    resolvedCount: 5,
    resolvedDurationMs: 5 * 5 * 60_000,
    spanMs: 10 * 60_000,
    distinctHoursOfDay: 1,
  });
  assert.equal(brief.classification, "indeterminate");
  assert.equal(brief.opensPerDay, null, "1,080/day is arithmetically true and misinforming");
  assert.match(brief.reason, /too short a span/);
});

test("oscillating needs BOTH a short mean open and a real daily rate", () => {
  const shortAndFrequent = classifyFlap({
    transitionCount: 20,
    openTransitions: 0,
    resolvedCount: 20,
    resolvedDurationMs: 20 * 18 * 60_000,
    spanMs: 5 * 86_400_000,
    distinctHoursOfDay: 24,
  });
  assert.equal(shortAndFrequent.classification, "oscillating");

  // Short opens, but only once every few days — not a flap.
  const rare = classifyFlap({
    transitionCount: 4,
    openTransitions: 0,
    resolvedCount: 4,
    resolvedDurationMs: 4 * 18 * 60_000,
    spanMs: 20 * 86_400_000,
    distinctHoursOfDay: 3,
  });
  assert.equal(rare.classification, "sustained");
  assert.match(rare.reason, /not oscillating/);

  // Frequent, but each occurrence lasts hours — an outage, not a flap.
  const longAndFrequent = classifyFlap({
    transitionCount: 20,
    openTransitions: 0,
    resolvedCount: 20,
    resolvedDurationMs: 20 * 240 * 60_000,
    spanMs: 5 * 86_400_000,
    distinctHoursOfDay: 9,
  });
  assert.equal(longAndFrequent.classification, "sustained");

  // The boundary itself: 60 minutes is NOT under 60.
  const atBoundary = classifyFlap({
    transitionCount: 10,
    openTransitions: 0,
    resolvedCount: 10,
    resolvedDurationMs: 10 * 60 * 60_000,
    spanMs: 2 * 86_400_000,
    distinctHoursOfDay: 5,
  });
  assert.equal(atBoundary.classification, "sustained");
});

// ── structure ───────────────────────────────────────────────────────────────

test("an incident is open while ANY transition is unresolved, and carries the worst severity", () => {
  const rows = [
    transition({ deviceId: "d1", severity: "medium", resolvedAt: "2026-08-28T01:00:00.000Z" }),
    transition({ deviceId: "d2", severity: "critical", resolvedAt: null }),
    transition({ deviceId: "d3", severity: "info", resolvedAt: "2026-08-28T02:00:00.000Z" }),
  ];
  const incident = buildIncidentQueue(rows).incidents[0]!;
  assert.equal(incident.state, "open");
  assert.equal(incident.openTransitions, 1);
  assert.equal(incident.resolvedTransitions, 2);
  assert.equal(incident.severity, "critical");
  assert.deepEqual(incident.severityCounts, { critical: 1, high: 0, medium: 1, info: 1 });
});

test("occurrence windows are fixed clock buckets, so they are re-derivable by hand", () => {
  const incident = buildIncidentQueue([
    firing("d1", "2026-08-27T21:31:00.000Z", 5),
    firing("d2", "2026-08-27T21:59:59.000Z", 5),
    // One second later is the NEXT bucket — the known cost of fixed buckets, and
    // why co-firing is documented as a lower bound.
    firing("d3", "2026-08-27T22:00:00.000Z", 5),
  ]).incidents[0]!;
  assert.equal(incident.occurrences.total, 2);
  assert.equal(incident.occurrences.coFiring, 0, "the split pair never reaches 3 together");
  assert.equal(incident.occurrences.windows[0]!.windowStart, "2026-08-27T21:30:00.000Z");
  assert.equal(incident.occurrences.windows[0]!.windowEnd, "2026-08-27T22:00:00.000Z");
  assert.equal(OCCURRENCE_WINDOW_MS, 30 * 60 * 1000);
  assert.equal(incident.occurrences.windowMinutes, 30);
});

test("an empty queue reports nulls, not zeros dressed as measurements", () => {
  const queue = buildIncidentQueue([]);
  assert.deepEqual(queue.incidents, []);
  assert.equal(queue.totals.transitions, 0);
  assert.equal(queue.totals.collapsePercent, null);
  assert.equal(queue.totals.coFiringSharePercent, null);
  assert.equal(queue.totals.coFiringShareOfAttributedPercent, null);
  assert.equal(queue.reconciliation.balanced, true);
});

test("queue order is stable and puts open work first", () => {
  const rows = [
    transition({ deviceId: "d1", groupId: "g1", severity: "info", resolvedAt: "2026-08-28T01:00:00.000Z" }),
    transition({ deviceId: "d2", groupId: "g2", severity: "critical", resolvedAt: null }),
    transition({ deviceId: "d3", groupId: "g3", severity: "critical", resolvedAt: "2026-08-28T01:00:00.000Z" }),
  ];
  const first = buildIncidentQueue(rows).incidents.map((i) => i.id);
  const second = buildIncidentQueue([...rows].reverse()).incidents.map((i) => i.id);
  assert.deepEqual(first, second, "order must not depend on input order");
  assert.equal(buildIncidentQueue(rows).incidents[0]!.scope.id, "g2");
});

// ── BUG-10: a collector RESUME must not manufacture a site event ────────────

/**
 * The real resume history around the burst, from the local `vfi` DB
 * (2026-09-18), not invented:
 *
 *   `poller_runs` ∪ `fleet_snapshots` go quiet at 2026-08-25T18:33:24Z and come
 *   back at 2026-08-26T18:06:52.734Z — 84,808 s, 23.6 h. `correlateOutages`
 *   CANNOT see that window (`snapshot` was the only lane with any observation
 *   history in that era, so the outage has one member lane against the two it
 *   requires), which is why the route feeds the observation timeline as well.
 */
const RESUME_23H: CollectorResume = {
  resumedAt: "2026-08-26T18:06:52.734Z",
  blindSeconds: 84_808,
  blindReason: null,
  lanes: [],
  source: "observation-gap",
};

/**
 * The `Montreal Office` burst, exactly as the DB holds it: six screens, six
 * `offline-4h` criticals, every `opened_at` inside 2.3 MILLISECONDS of
 * 2026-08-26T18:06:57.579Z — 4.8 s after collection resumed from 23.6 h of
 * blindness. Six devices "offline together" is a dispatch to Montreal; the
 * truth is that our first pass back found six devices already down, separately,
 * at unknown times.
 */
const montrealBurst = (): AlertTransition[] =>
  ["1000101", "1000102", "1000103", "1000104", "1000105", "1000106"].map((deviceId, i) =>
    firing(deviceId, new Date(Date.parse("2026-08-26T18:06:57.579Z") + i * 0.4).toISOString(), 240, {
      groupId: "grp-montreal",
      groupName: "Montreal Office",
      ruleId: "offline-4h",
      severity: "critical",
      title: "Offline for 4h",
    }),
  );

test("BUG-10: the Montreal Office 14:06:57 resume burst is NOT a co-firing site event", () => {
  const rows = montrealBurst();
  const queue = buildIncidentQueue(rows, { collectorResumes: [RESUME_23H] });
  const incident = queue.incidents[0]!;
  const window = incident.occurrences.windows[0]!;

  // The signature is still reported honestly — six devices DID fire in this
  // window — but not one of them can date a failure, so the correlation is not
  // claimed.
  assert.equal(window.deviceCount, 6);
  assert.equal(window.failedTogetherDeviceCount, 0);
  assert.equal(window.coFiring, false, "the co-firing claim must be withdrawn");
  assert.equal(window.noticedTogether, true);
  assert.equal(incident.occurrences.coFiring, 0);
  assert.equal(incident.occurrences.noticedTogether, 1);
  assert.equal(incident.occurrences.transitionsCoFiring, 0);
  assert.equal(incident.occurrences.transitionsNoticedTogether, 6);
  assert.equal(queue.totals.coFiringEvents, 0);
  assert.equal(queue.totals.noticedTogetherEvents, 1);
  assert.equal(queue.totals.noticedTogetherTransitions, 6);

  // And it says WHY, with the instant and the duration an operator can check.
  const provenance = window.provenance!;
  assert.equal(provenance.resumedAt, RESUME_23H.resumedAt);
  assert.equal(provenance.blindSeconds, 84_808);
  assert.equal(provenance.transitions, 6);
  assert.equal(provenance.devices, 6);
  assert.match(provenance.note, /Noticed together, NOT failed together/);
  assert.match(provenance.note, /23\.6h/);

  // NOTHING IS LOST. Every alert is still in its window, on the roster and in
  // the drilldown — only the co-firing claim went away.
  assert.equal(window.transitionIds.length, 6);
  assert.deepEqual([...window.transitionIds].sort(), rows.map((r) => r.id).sort());
  assert.equal(incident.transitionCount, 6);
  assert.equal(incident.roster.length, 6);
  assert.equal(incident.drilldown.deviceIds.length, 6);
  assert.equal(queue.reconciliation.balanced, true);
  assert.equal(queue.totals.transitions, 6);
});

test("BUG-10: with no resume history the claim stands, and the queue SAYS it is unchecked", () => {
  const queue = buildIncidentQueue(montrealBurst());
  // Unchanged behaviour when we did not look — plus the honest admission that
  // we did not. A silent "checked and clean" here is how the bug shipped.
  assert.equal(queue.incidents[0]!.occurrences.coFiring, 1);
  assert.equal(queue.provenance.checked, false);
  assert.equal(queue.provenance.resumes, 0);
  assert.notEqual(queue.provenance.reason, null);
  assert.match(queue.provenance.reason!, /not been provenance-checked|not supplied/);
  assert.equal(queue.incidents[0]!.occurrences.windows[0]!.provenance, null);
});

test("BUG-10: a genuine site event in the same bucket as a resume is STILL reported", () => {
  // Ten minutes after the resume — inside the same fixed 30-minute bucket the
  // resume falls in, and outside the first pass. Provenance, not timing: a
  // suppression keyed on the WINDOW would lose this real event.
  const at = new Date(Date.parse(RESUME_23H.resumedAt) + 10 * 60_000).toISOString();
  const rows = ["d1", "d2", "d3"].map((d) => firing(d, at, 30, { groupId: "grp-real" }));
  const queue = buildIncidentQueue(rows, { collectorResumes: [RESUME_23H] });
  const window = queue.incidents[0]!.occurrences.windows[0]!;

  assert.equal(window.windowStart, "2026-08-26T18:00:00.000Z", "same bucket as the resume");
  assert.equal(window.coFiring, true, "a real site event near a resume must survive");
  assert.equal(window.noticedTogether, false);
  assert.equal(window.failedTogetherDeviceCount, 3);
  assert.equal(window.provenance, null, "no transition here is the first pass's work");
  assert.equal(queue.totals.coFiringEvents, 1);
  assert.equal(queue.totals.noticedTogetherEvents, 0);
});

test("BUG-10: a mixed window keeps the claim on the devices that can date a failure", () => {
  const resumedAt = Date.parse(RESUME_23H.resumedAt);
  const rows = [
    // Found already down by the first pass back.
    ...["n1", "n2", "n3"].map((d) =>
      firing(d, new Date(resumedAt + 1_000).toISOString(), 30, { groupId: "grp-mix" }),
    ),
    // Failed twelve minutes later, while we were watching.
    ...["f1", "f2", "f3"].map((d) =>
      firing(d, new Date(resumedAt + 12 * 60_000).toISOString(), 30, { groupId: "grp-mix" }),
    ),
  ];
  const window = buildIncidentQueue(rows, { collectorResumes: [RESUME_23H] })
    .incidents[0]!.occurrences.windows[0]!;

  assert.equal(window.deviceCount, 6);
  assert.equal(window.failedTogetherDeviceCount, 3, "only the later three can date a failure");
  assert.equal(window.coFiring, true, "three datable devices still clear the floor");
  assert.equal(window.noticedTogether, false);
  assert.equal(window.noticedTogetherTransitions, 3);
  // The note has to distinguish the halves, or an operator reads our blind spot
  // as estate evidence.
  assert.match(window.provenance!.note, /still co-fires on the 3 device/);
});

test("BUG-10: a device with one first-pass open and a later open still counts as failed", () => {
  const resumedAt = Date.parse(RESUME_23H.resumedAt);
  const rows = [
    ...["d1", "d2", "d3"].map((d) =>
      firing(d, new Date(resumedAt + 1_000).toISOString(), 5, { groupId: "grp-both" }),
    ),
    ...["d1", "d2", "d3"].map((d) =>
      firing(d, new Date(resumedAt + 15 * 60_000).toISOString(), 5, { groupId: "grp-both" }),
    ),
  ];
  const window = buildIncidentQueue(rows, { collectorResumes: [RESUME_23H] })
    .incidents[0]!.occurrences.windows[0]!;
  assert.equal(window.deviceCount, 3);
  assert.equal(window.failedTogetherDeviceCount, 3);
  assert.equal(window.coFiring, true);
  assert.equal(window.provenance!.devices, 0, "no device is first-pass ONLY");
  assert.equal(window.provenance!.transitions, 3);
});

test("BUG-10: a SHORT outage is not blindness — the Leedy example survives its resume", () => {
  /**
   * The Leedy incident's first co-firing occurrence opens 0.1 s after a real
   * correlated outage of `snapshot` and `status` that had lasted 1,064 s —
   * under three alerting intervals, and not including the lanes that produce
   * `screen-off-during-schedule` at all. An earlier cut of this fix treated it
   * as a resume and took the epic's headline example from 14 co-firing
   * occurrences to 13.
   *
   * The real pair is 2026-08-27T21:46:04.881Z / 21:46:05.057Z; the resume is
   * placed 0.1 s before `leedyCorpus`'s FIRST window here so the fixture keeps
   * the measured offset — a resume 12 minutes away would pin nothing.
   */
  const shortOutage: CollectorResume = {
    resumedAt: "2026-08-27T21:29:59.900Z",
    blindSeconds: 1_064.289,
    blindReason: null,
    lanes: ["snapshot", "status"],
    source: "correlated-outage",
  };
  const resumes = [
    shortOutage,
    RESUME_23H,
    {
      resumedAt: "2026-08-25T18:14:29.428Z",
      blindSeconds: null,
      blindReason: "earliest observation we hold; retention-pruned tables",
      lanes: [],
      source: "observation-start" as const,
    },
  ];
  const queue = buildIncidentQueue(leedyCorpus(), { collectorResumes: resumes });
  const incident = queue.incidents[0]!;

  assert.equal(incident.deviceCount, 5);
  assert.equal(incident.transitionCount, 72);
  assert.equal(incident.occurrences.total, 21);
  assert.equal(incident.occurrences.coFiring, 14, "THE epic's number — 14, not 13");
  assert.equal(incident.occurrences.noticedTogether, 0);
  assert.equal(incident.occurrences.transitionsCoFiring, 64);
  assert.equal(queue.provenance.checked, true);
  assert.equal(queue.provenance.suppressedEvents, 0);
});

test("BUG-10: the first-pass boundary is one lane interval, and the skew is symmetric", () => {
  const resumedAt = Date.parse(RESUME_23H.resumedAt);
  const inside = resumeForOpen(resumedAt + RESUME_FIRST_PASS_SECONDS * 1000, [RESUME_23H]);
  const outside = resumeForOpen(resumedAt + RESUME_FIRST_PASS_SECONDS * 1000 + 1, [RESUME_23H]);
  assert.equal(inside?.resumedAt, RESUME_23H.resumedAt, "the boundary is inclusive");
  assert.equal(outside, null, "one millisecond past one lane interval is datable");

  // Before the instant we hold: the alerting lane can write its rows ahead of
  // whichever lane stamps the resume (measured at 244 ms on this corpus).
  assert.notEqual(resumeForOpen(resumedAt - RESUME_CLOCK_SKEW_SECONDS * 1000, [RESUME_23H]), null);
  assert.equal(resumeForOpen(resumedAt - RESUME_CLOCK_SKEW_SECONDS * 1000 - 1, [RESUME_23H]), null);

  // A short outage is never admitted, however close the open sits to it.
  const brief = { ...RESUME_23H, blindSeconds: RESUME_FIRST_PASS_SECONDS * 3 - 1 };
  assert.equal(resumeForOpen(resumedAt, [brief]), null);
  assert.notEqual(resumeForOpen(resumedAt, [{ ...brief, blindSeconds: RESUME_FIRST_PASS_SECONDS * 3 }]), null);
  // Unknown blind length is the UNBOUNDED case, so it is admitted.
  assert.notEqual(
    resumeForOpen(resumedAt, [{ ...RESUME_23H, blindSeconds: null, blindReason: "no earlier observation" }]),
    null,
  );
});

test("BUG-10: the three occurrence buckets partition the windows and the transitions", () => {
  const resumedAt = Date.parse(RESUME_23H.resumedAt);
  const rows = [
    ...montrealBurst(),
    // A real recurrence of the same incident, a day later.
    ...["1000101", "1000102", "1000103"].map((d) =>
      firing(d, "2026-08-28T09:00:00.000Z", 30, {
        groupId: "grp-montreal",
        groupName: "Montreal Office",
        ruleId: "offline-4h",
      }),
    ),
    // And one lone device, in its own window.
    firing("1000101", new Date(resumedAt + 6 * 3_600_000).toISOString(), 30, {
      groupId: "grp-montreal",
      groupName: "Montreal Office",
      ruleId: "offline-4h",
    }),
  ];
  const o = buildIncidentQueue(rows, { collectorResumes: [RESUME_23H] }).incidents[0]!.occurrences;
  assert.equal(o.coFiring + o.noticedTogether + o.isolated, o.total);
  assert.equal(
    o.transitionsCoFiring + o.transitionsNoticedTogether + o.transitionsIsolated,
    rows.length,
    "every transition is in exactly one bucket",
  );
  assert.equal(o.coFiring, 1);
  assert.equal(o.noticedTogether, 1);
  assert.equal(o.isolated, 1);
});
