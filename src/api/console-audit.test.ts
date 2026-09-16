/**
 * The AUDIT view's invariants, asserted against the console's own source.
 *
 * Same technique as console-invariants.test.ts, and for the same reason: the
 * audit surface is logic living in a 6,400-line HTML file that no type checker
 * can see, and the two properties it must never lose are exactly the two this
 * file has broken before elsewhere —
 *
 *   1. COUNT THE THING YOU FILTER. `/api/audit` filters and pages in the
 *      database, so the only count this view may take from the rows is a count
 *      of the rows on screen. A tally that looks like a tally of the log is the
 *      248-above-250 bug in a new costume.
 *   2. HONEST NULLS. `requested_value`/`observed_value` are NULL for "not
 *      applicable, or could not be read" and never 0. An unreadable read-back is
 *      the finding the rollback cycle exists to produce, so it must render as a
 *      reason — never a zero, and never a bare dash standing in for a value.
 *
 * Plus one binding that only a test can hold: the outcome vocabulary rendered in
 * the console must be the CLOSED vocabulary the database CHECKs, imported here
 * from the repository rather than retyped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEVICE_ACTION_OUTCOMES } from "../db/repository.js";

// ─── lifting the console's own declarations ──────────────────────────────────

const consoleScript = async (): Promise<string> => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(join(here, "..", "..", "public", "console.html"), "utf8");
  const open = src.lastIndexOf("<script>");
  const close = src.lastIndexOf("</script>");
  assert.ok(open > 0 && close > open, "console.html must contain a trailing <script> block");
  return src.slice(open + "<script>".length, close);
};

/** Delimited by parseability, not by brace counting — see console-invariants. */
const declarationOf = (script: string, name: string): string => {
  const lines = script.split("\n");
  const start = new RegExp(`^(?:async\\s+)?(?:function|const|let)\\s+${name}\\b`);
  const i = lines.findIndex((l) => start.test(l));
  assert.notEqual(
    i, -1,
    `console.html no longer declares a top-level "${name}". This test lifts it by ` +
    `name; if it moved or was renamed, follow it — do not delete the check.`,
  );
  for (let k = 1; k <= 250 && i + k <= lines.length; k++) {
    const text = lines.slice(i, i + k).join("\n");
    try {
      new Function(text);
    } catch {
      continue;
    }
    return text;
  }
  throw new assert.AssertionError({
    message: `could not delimit the declaration of "${name}" within 250 lines`,
  });
};

class El {
  innerHTML = "";
  textContent = "";
  title = "";
  className = "";
  readonly children: El[] = [];
  readonly dataset: Record<string, string> = {};
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  setAttribute(): void {}
  addEventListener(): void {}
  querySelectorAll(): El[] {
    return [];
  }
}

/** Source order, because these are `const`s and `function`s in one scope. */
const AUDIT_DECLS = [
  "esc", "ago",
  "AUD_LIMIT", "AUD_OUTCOMES", "AUD_ATTENTION", "AUD_ACTIONS",
  "auditQuery", "auditOutcome", "auditWhyNoValue", "auditFromValue", "auditTable",
  "renderAuditFilters", "renderAudit", "tabAudit",
] as const;

type AuditApi = {
  AUD_LIMIT: number;
  AUD_OUTCOMES: [string, string, string][];
  AUD_ATTENTION: string[];
  auditQuery: (over?: Record<string, unknown>) => string;
  auditWhyNoValue: (row: Record<string, unknown>, which: string) => string;
  auditTable: (rows: unknown[], opts: { device: boolean; actorFilter: boolean }) => string;
  renderAudit: () => void;
  tabAudit: (d: { id: string; name: string }) => string;
};

type Harness = { api: AuditApi; S: Record<string, unknown>; el: (id: string) => El };

const harness = async (state: Record<string, unknown>): Promise<Harness> => {
  const script = await consoleScript();
  const els = new Map<string, El>();
  const el = (id: string): El => {
    const key = id.replace(/^#/, "");
    let e = els.get(key);
    if (!e) {
      e = new El();
      els.set(key, e);
    }
    return e;
  };
  const S: Record<string, unknown> = {
    audit: null, audPage: null, audErr: null, audLoading: false, audAt: Date.now(),
    aud: { page: 1, outcome: "all", action: "all", actor: null, deviceId: null },
    dev: null, dtab: "audit",
    ...state,
  };
  const body =
    `"use strict";\nconst { document, S, openDevice, loadAudit } = ctx;\n` +
    `const $ = (s) => document.querySelector(s);\n` +
    AUDIT_DECLS.map((n) => declarationOf(script, n)).join("\n") +
    `\nreturn { AUD_LIMIT, AUD_OUTCOMES, AUD_ATTENTION, auditQuery, auditWhyNoValue,` +
    ` auditTable, renderAudit, tabAudit };`;
  const api = new Function("ctx", body)({
    document: { querySelector: (sel: string): El => el(sel), createElement: (): El => new El() },
    S,
    openDevice: (): void => {},
    loadAudit: (): void => {},
  }) as AuditApi;
  return { api, S, el };
};

// ─── fixtures, shaped like the rows commands.ts actually writes ──────────────

type Row = Record<string, unknown>;

const verifiedRow = (over: Row = {}): Row => ({
  id: 9, action: "brightness_write", verb: "set_brightness",
  deviceId: "canvas-1", deviceName: "Lobby VQ Left",
  requestedValue: "60%", observedValue: "60%",
  params: { arg: "set_brightness:=153" },
  detail: { mode: "verify", state: "verified", requestedRaw: 153, originalRaw: 128, observedRaw: 153 },
  outcome: "verified", actor: "api:sj", actorIp: "10.0.0.9",
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  finishedAt: new Date(Date.now() - 58_000).toISOString(),
  durationMs: 2_010, error: null,
  ...over,
});

/** The row the rollback cycle exists to produce: nothing could be read back. */
const unreadableRow = (): Row => verifiedRow({
  id: 10, outcome: "refused", observedValue: null,
  detail: { mode: "verify", state: "preflight_blocked", originalRaw: null, reason: "preflight_unreadable" },
  error: "The device's current brightness could not be read, so it was not written.",
});

/** A generic command: no argument, so no requested value. */
const commandRow = (): Row => verifiedRow({
  id: 11, action: "device_command", verb: "ops_get_settings",
  requestedValue: null, observedValue: null, outcome: "applied",
  detail: { responseCode: "SUCCESS", risk: "unverified", verified: false },
});

const page = (over: Record<string, number> = {}): Record<string, number> =>
  ({ page: 1, limit: 50, totalItems: 3, totalPages: 1, ...over });

const payload = (rows: Row[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  actions: rows,
  oldestActionAt: rows.length ? (rows[rows.length - 1] as Row).startedAt : null,
  newestActionAt: rows.length ? (rows[0] as Row).startedAt : null,
  emptyReason: null,
  retention: { retainDays: 730, enforced: false, note: "bounded as a ceiling" },
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Count the thing you filter
// ─────────────────────────────────────────────────────────────────────────────

test("the audit header counts the rows in its own table, not the server's match", async () => {
  const rows = [verifiedRow(), unreadableRow(), commandRow()];
  const h = await harness({
    audit: payload(rows),
    audPage: page({ totalItems: 137, totalPages: 3 }),
  });
  h.api.renderAudit();
  // Three rows rendered, 137 matched in the database. The badge is the former.
  assert.equal(h.el("audcount").textContent, "3");
  const table = h.el("audlist").innerHTML;
  // Counted by the "when" cell, which every body row has and the header does not.
  assert.equal((table.match(/<td class="n">/g) || []).length, 3,
    "the table must hold exactly the rows the badge counted");
  // And the sentence beside it must carry the server's total, so the "3" is
  // never read as "three things have ever happened here".
  assert.match(h.el("audsub").textContent, /of 137 matching/);
  assert.match(h.el("audsub").textContent, /page 1 of 3/);
});

test("a page of a larger match says out loud that it is not the whole match", async () => {
  const h = await harness({
    audit: payload([verifiedRow()]),
    audPage: page({ totalItems: 137, totalPages: 3 }),
  });
  h.api.renderAudit();
  const pager = h.el("audpager").innerHTML;
  assert.match(pager, /not the whole match/i, "a truncated list must not look complete");
  assert.match(pager, /Showing <b>1<\/b> of <b>137<\/b>/);
});

test("a match that fits on one page is not described as truncated", async () => {
  const h = await harness({ audit: payload([verifiedRow()]), audPage: page({ totalItems: 1 }) });
  h.api.renderAudit();
  assert.match(h.el("audpager").innerHTML, /This page is the whole match/);
});

test("a response with no page meta refuses to claim the list is complete", async () => {
  const h = await harness({ audit: payload([verifiedRow()]), audPage: null });
  h.api.renderAudit();
  assert.match(h.el("audpager").innerHTML, /cannot say.*whether more rows exist/is);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Honest nulls — including the null that means "we could not ask"
// ─────────────────────────────────────────────────────────────────────────────

test("an unreadable log renders no count at all, never a zero", async () => {
  const h = await harness({ audit: null, audErr: "GET /api/audit returned 500" });
  h.api.renderAudit();
  assert.notEqual(h.el("audcount").textContent, "0",
    "a failed read must never be counted as zero actions");
  assert.equal(h.el("audcount").textContent, "?");
  assert.match(h.el("audcount").title, /not zero/i);
  const body = h.el("audlist").innerHTML;
  assert.match(body, /could not be read/i);
  assert.match(body, /500/, "the failure's own words must survive to the screen");
  assert.match(body, /not.*the same as saying nothing was changed/is);
});

test("an empty log prints WHICH empty it is, in the endpoint's own words", async () => {
  // The endpoint distinguishes "never logged anything" from "your filter matched
  // nothing"; the view must not flatten that into a bare "no results".
  const reason =
    "No device action has been logged yet. This log starts empty and is only " +
    "written when VFI actually writes to a device.";
  const h = await harness({
    audit: payload([], { emptyReason: reason }),
    audPage: page({ totalItems: 0, totalPages: 1 }),
  });
  h.api.renderAudit();
  assert.equal(h.el("audcount").textContent, "0", "zero rows really are zero rows");
  assert.match(h.el("audlist").innerHTML, /No device action has been logged yet/);
  // Nothing matched, so there is nothing to page: "page 1 of 1" under an empty
  // log is noise over the sentence that actually explains it.
  assert.equal(h.el("audpager").innerHTML, "");
  // The retention statement still renders — whether rows can age out is exactly
  // the question an empty audit log raises.
  assert.match(h.el("audnote").innerHTML, /730 days as a ceiling/);
  assert.match(h.el("audnote").innerHTML, /not that it expired/);
});

test("a value that could not be read renders the reason, not a zero or a dash", async () => {
  const h = await harness({ audit: payload([unreadableRow()]), audPage: page({ totalItems: 1 }) });
  h.api.renderAudit();
  const html = h.el("audlist").innerHTML;
  // The read-back cell: a reason, marked as unresolved.
  assert.match(html, /read back: <span class="unres">Never read back/);
  // The prior value is the finding itself, not a blank.
  assert.match(html, /original value could not be read/);
  // And nowhere does a zero or a lone em-dash stand in for a brightness value.
  assert.ok(!/<b>0<\/b>/.test(html), "0 must never stand in for an unread value");
  assert.ok(!/read back: (&#8212;|—)/.test(html), "a dash must never stand in for a value");
});

test("every missing-value reason is a sentence, never a placeholder glyph", async () => {
  const h = await harness({});
  for (const outcome of DEVICE_ACTION_OUTCOMES) {
    for (const which of ["requested", "observed"]) {
      const why = h.api.auditWhyNoValue({ action: "brightness_write", outcome }, which);
      assert.ok(why.length > 12, `${outcome}/${which} reason is too short to be one: "${why}"`);
      assert.ok(!/^[-—–0\s]*$/.test(why), `${outcome}/${which} rendered a glyph, not a reason`);
    }
  }
});

test("a command that carries no argument says so rather than showing an empty value", async () => {
  const h = await harness({ audit: payload([commandRow()]), audPage: page({ totalItems: 1 }) });
  h.api.renderAudit();
  assert.match(h.el("audlist").innerHTML, /No value requested/);
  // `applied` with a null read-back is "accepted, unconfirmed" — the migration's
  // own reading of that combination, and the one a reviewer must see.
  assert.match(h.el("audlist").innerHTML, /Accepted but unconfirmed/);
});

test("a device the audit row outlived is named as such, not left blank", async () => {
  const gone = verifiedRow({ deviceName: null, deviceId: "deleted-77" });
  const h = await harness({ audit: payload([gone]), audPage: page({ totalItems: 1 }) });
  h.api.renderAudit();
  const html = h.el("audlist").innerHTML;
  assert.match(html, /deleted-77/);
  assert.match(html, /outlives the device record/);
  // No open-device button for an id that cannot resolve.
  assert.ok(!/data-auddev="deleted-77"/.test(html));
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The vocabulary is the database's, not a retyped copy
// ─────────────────────────────────────────────────────────────────────────────

test("the console explains exactly the outcomes the database CHECKs", async () => {
  const h = await harness({});
  const rendered = h.api.AUD_OUTCOMES.map((o) => o[0]).sort();
  assert.deepEqual(rendered, [...DEVICE_ACTION_OUTCOMES].sort(),
    "an outcome with no explanation in the UI is an outcome a reader cannot act on");
  for (const [key, dot, why] of h.api.AUD_OUTCOMES) {
    assert.ok(why.length > 20, `outcome "${key}" needs a meaning, not a label`);
    assert.ok(["grn", "blu", "amb", "red", "gry"].includes(dot),
      `outcome "${key}" uses dot class "${dot}", which the stylesheet does not define`);
  }
});

test('"needs attention" is the writes that went wrong, and excludes refusals', async () => {
  const h = await harness({});
  for (const o of h.api.AUD_ATTENTION) {
    assert.ok((DEVICE_ACTION_OUTCOMES as readonly string[]).includes(o),
      `"${o}" is not in the endpoint's closed vocabulary, so filtering by it 400s`);
  }
  assert.ok(!h.api.AUD_ATTENTION.includes("refused"),
    "a refusal never touched the panel; counting it as a failure overstates the damage");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The query the view actually sends
// ─────────────────────────────────────────────────────────────────────────────

test("the audit query sends filters the endpoint understands, and omits the rest", async () => {
  const h = await harness({});
  const plain = h.api.auditQuery();
  assert.match(plain, /(^|&)page=1(&|$)/);
  assert.match(plain, new RegExp(`(^|&)limit=${h.api.AUD_LIMIT}(&|$)`));
  assert.ok(!plain.includes("outcome="), '"all" is the absence of a filter, not a value to send');
  assert.ok(!plain.includes("action="));
  assert.ok(!plain.includes("deviceId="));
  assert.ok(h.api.AUD_LIMIT <= 200, "the endpoint clamps `limit` at 200 and rejects more");

  // "Everything that failed" is one request, comma-separated, as the endpoint
  // documents — not three requests stitched together in the client.
  const attention = h.api.auditQuery({ outcome: "attention" });
  assert.match(attention, /outcome=failed%2Crollback_failed%2Crolled_back|outcome=failed,rollback_failed,rolled_back/);

  const scoped = h.api.auditQuery({ deviceId: "canvas 1", actor: "api:sj", action: "brightness_write", page: 3 });
  assert.match(scoped, /deviceId=canvas%201/, "a device id must be encoded, not concatenated raw");
  assert.match(scoped, /actor=api%3Asj/);
  assert.match(scoped, /action=brightness_write/);
  assert.match(scoped, /page=3/);
  // An override must not leak into the fleet view's own filters.
  assert.deepEqual(
    (h.S as { aud: Record<string, unknown> }).aud,
    { page: 1, outcome: "all", action: "all", actor: null, deviceId: null },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The device drawer's slice
// ─────────────────────────────────────────────────────────────────────────────

test("the drawer never renders a failed audit read as an empty history", async () => {
  const h = await harness({
    dev: { id: "canvas-1", name: "Lobby VQ Left", _audit: { data: null, page: null, error: "timeout" } },
  });
  const html = h.api.tabAudit({ id: "canvas-1", name: "Lobby VQ Left" });
  assert.match(html, /could not be read/i);
  assert.match(html, /timeout/);
  assert.ok(!/No rows for this device/.test(html),
    "an unasked question must not be answered with 'nothing happened'");
});

test("the drawer's device history counts its own rows and says how many exist", async () => {
  const rows = [verifiedRow(), unreadableRow()];
  const h = await harness({
    dev: {
      id: "canvas-1", name: "Lobby VQ Left",
      _audit: { data: payload(rows), page: page({ totalItems: 61, totalPages: 2 }), error: null },
    },
  });
  const html = h.api.tabAudit({ id: "canvas-1", name: "Lobby VQ Left" });
  assert.match(html, /\(2 shown\)/);
  assert.match(html, /2 of 61 logged action\(s\) for this device/);
  assert.match(html, /page 1 of 2<\/b>, so this is not the whole history/);
  assert.equal((html.match(/<td class="n">/g) || []).length, 2);
});

test("a device with nothing logged against it says why, and offers the full log", async () => {
  const h = await harness({
    dev: {
      id: "canvas-1", name: "Lobby VQ Left",
      _audit: {
        data: payload([], { emptyReason: "No logged action matches these filters." }),
        page: page({ totalItems: 0 }), error: null,
      },
    },
  });
  const html = h.api.tabAudit({ id: "canvas-1", name: "Lobby VQ Left" });
  assert.match(html, /No logged action matches these filters/);
  assert.match(html, /id="audall"/, "the handover to the full log must exist even when empty");
});
