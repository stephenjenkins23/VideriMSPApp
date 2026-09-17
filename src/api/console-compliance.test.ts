/**
 * The compliance queue's invariants (EPIC 8.5 / US-8.5.5, GAP-10).
 *
 * The Compliance tab shipped with ZERO controls over 117 rows, so this epic
 * gave it search, a per-check filter, band chips, seven sorts and paging. Every
 * one of those is a new chance to reproduce the bug that has already shipped
 * THREE times in public/console.html: a count printed beside a list it is not
 * counting. The alert queue has console-invariants.test.ts guarding that; this
 * file is the same guard for the compliance queue, and it works the same way —
 * it lifts the real declarations out of console.html by source text and runs
 * them against a hand-written element stub. No jsdom, no new dependency.
 *
 * What is asserted here, and why each one is here:
 *
 *  1. The badge equals the rows drawn, for every filter combination. The badge
 *     counts `pageRows`; the rows come from `pageRows`; a divergence is the
 *     shipped bug.
 *  2. Chips sum to the set they filter within, and each chip equals what
 *     pressing it renders. An option that promises 52 and delivers 5 is worse
 *     than no option.
 *  3. Nothing that cannot be known renders as 0. A mean over nothing is `null`,
 *     an empty filter result says which filter emptied it and how many devices
 *     are scored in total, and a device with no config age says so in words.
 *  4. The scoring caveat is computed over every scored row and does not move
 *     when the filters do — it is a statement about the model, and a caveat
 *     that shrank when you filtered would read as a fixed problem.
 *  5. The sort vocabulary in urlReadParams() is exactly SORTS_C's. Those two
 *     lists are duplicated on purpose (the URL parser is lifted in isolation by
 *     console-url-state.test.ts and cannot reference a top-level constant), so
 *     something has to hold them together.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─── loading the console's own source ────────────────────────────────────────

const consoleScript = async (): Promise<string> => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(join(here, "..", "..", "public", "console.html"), "utf8");
  const open = src.lastIndexOf("<script>");
  const close = src.lastIndexOf("</script>");
  assert.ok(open > 0 && close > open, "console.html must contain a trailing <script> block");
  return src.slice(open + "<script>".length, close);
};

/** Lift one named top-level declaration by source text, delimited by
 *  parseability rather than by brace counting — the console-invariants
 *  approach, and it cannot stop early on an unclosed template literal. */
const declarationOf = (script: string, name: string): string => {
  const lines = script.split("\n");
  const start = new RegExp(`^(?:async\\s+)?(?:function|const|let)\\s+${name}\\b`);
  const i = lines.findIndex((l) => start.test(l));
  assert.notEqual(
    i, -1,
    `console.html no longer declares a top-level "${name}". This test lifts it by name; ` +
    `if it moved or was renamed, follow it — do not delete the check.`,
  );
  for (let k = 1; k <= 300 && i + k <= lines.length; k++) {
    const text = lines.slice(i, i + k).join("\n");
    try {
      new Function(text);
    } catch {
      continue;
    }
    return text;
  }
  throw new assert.AssertionError({
    message: `could not delimit the declaration of "${name}" within 300 lines`,
  });
};

// ─── the element stub ────────────────────────────────────────────────────────

class El {
  innerHTML = "";
  textContent = "";
  className = "";
  title = "";
  value = "";
  readonly children: El[] = [];
  readonly attrs: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(): void {}
  querySelectorAll(): El[] {
    return [];
  }
}

// ─── fixtures ────────────────────────────────────────────────────────────────
//
// Shaped like the real corpus at 1/10 scale, including the property the epic is
// about: one check ("power-schedule-enabled") flags nearly every device, so the
// flag count cannot discriminate, while a second check flags a handful.

type Drift = { kind: string; field: string; label: string; checkId: string; expected: string; actual: string };
type Row = {
  deviceId: string; name: string; deviceClass: string; templateId: string;
  score: number; band: string; checksTotal: number; checksPassed: number;
  checksNotApplicable: number; settingsAgeSeconds: number | null; drift: Drift[];
};

const drift = (checkId: string, label: string, kind: string): Drift =>
  ({ kind, field: checkId.replace(/-/g, "_"), label, checkId, expected: "true", actual: "false" });

const SCHEDULE = (): Drift => drift("power-schedule-enabled", "Power schedule enabled", "policy");
const REBOOT = (): Drift => drift("daily-reboot-enabled", "Nightly reboot enabled", "policy");
const BRIGHT = (): Drift => drift("brightness-nonzero", "Brightness above minimum", "calibrated");

const row = (
  n: number, score: number, band: string, drifts: Drift[], extra: Partial<Row> = {},
): Row => ({
  deviceId: `dev-${n}`, name: `Canvas ${n}`, deviceClass: "canvas",
  templateId: "retail-standard", score, band,
  checksTotal: 14, checksPassed: 14 - drifts.length, checksNotApplicable: 0,
  settingsAgeSeconds: 3600 * n, drift: drifts, ...extra,
});

/** 12 rows: 10 flagged by the dominant check, 4 by nightly reboot, 1 by
 *  brightness, and one device with nothing flagged at all. */
const CORPUS: Row[] = [
  row(1, 65, "non-compliant", [SCHEDULE(), REBOOT(), BRIGHT()]),
  row(2, 70, "non-compliant", [SCHEDULE(), REBOOT()]),
  row(3, 78, "minor-drift", [SCHEDULE(), REBOOT()]),
  row(4, 82, "minor-drift", [SCHEDULE(), REBOOT()]),
  row(5, 88, "minor-drift", [SCHEDULE()]),
  row(6, 90, "minor-drift", [SCHEDULE()]),
  row(7, 92, "compliant", [SCHEDULE()]),
  row(8, 94, "compliant", [SCHEDULE()]),
  row(9, 96, "compliant", [SCHEDULE()]),
  row(10, 98, "compliant", [SCHEDULE()]),
  row(11, 99, "compliant", [], { name: "Spark bridge 11", deviceClass: "spark-bridge", settingsAgeSeconds: null }),
  row(12, 100, "compliant", [], { name: "Shelf 12", templateId: "shelf-edge" }),
];

// ─── the sandbox ─────────────────────────────────────────────────────────────

type CompQueue = {
  all: Row[]; matched: Row[]; rows: Row[]; pageRows: Row[];
  page: number; pages: number; first: number; perPage: number;
  checks: [string, string, number][];
  bands: [string, string, number][];
  sorts: [string, string][];
  catalogue: { id: string; label: string; kind: string; flags: number }[];
  dominant: { id: string; label: string; flags: number }[];
  flaggedAtAll: number;
  mean: number | null;
  dominantThreshold: number;
  active: { q: string; check: string; band: string; sort: string };
  filtered: boolean;
  mark: string;
};

type CompApi = {
  complianceRows: () => CompQueue;
  renderComplianceFilters: () => void;
  renderCompliance: () => void;
};

/** Source order: consts and functions share one scope, and the consts must
 *  precede the first CALL, which only happens inside the renderers. */
const COMP_DECLS = [
  "esc", "dur", "truncMark", "complianceRows", "renderComplianceFilters", "renderCompliance",
] as const;

type Harness = {
  api: CompApi;
  S: Record<string, unknown>;
  el: (id: string) => El;
  /** The band chips as rendered, keyed by band. */
  chips: () => Record<string, number>;
  /** The <tr> rows the table actually drew. */
  drawnRows: () => number;
  /** The number in the header badge. */
  badge: () => string;
};

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
  const document = { querySelector: (sel: string): El => el(sel), createElement: (): El => new El() };
  const S: Record<string, unknown> = {
    compliance: [], devices: [], trunc: {},
    cq: "", ccheck: "all", cband: "all", csort: "score", cpage: 1, ...state,
  };
  const body =
    `"use strict";\nconst { document, S, openDevice, urlSync } = ctx;\n` +
    `const $ = (s) => document.querySelector(s);\n` +
    COMP_DECLS.map((n) => declarationOf(script, n)).join("\n") +
    `\nreturn { complianceRows, renderComplianceFilters, renderCompliance };`;
  const api = new Function("ctx", body)({
    document, S, openDevice: (): void => {}, urlSync: (): void => {},
  }) as CompApi;
  const chips = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const c of el("cfp").children) {
      const m = /<b>(\d+)<\/b>\s*([a-z-]+)/.exec(c.innerHTML);
      assert.ok(m, `a band chip did not render "<b>N</b> band": ${c.innerHTML}`);
      out[m[2] as string] = Number(m[1]);
    }
    return out;
  };
  return {
    api, S, el, chips,
    drawnRows: () => (el("comptable").innerHTML.match(/<tr class="r"/g) || []).length,
    badge: () => el("ccount").textContent,
  };
};

const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

// ─────────────────────────────────────────────────────────────────────────────
// 0. The harness is really running the console's code
// ─────────────────────────────────────────────────────────────────────────────

test("the compliance harness lifts and runs the real console source", async () => {
  const script = await consoleScript();
  const src = declarationOf(script, "complianceRows");
  assert.match(src, /^function complianceRows\(\)/,
    "complianceRows must still be a top-level function");
  assert.ok(src.trimEnd().endsWith("}"), "the lifted complianceRows must be a complete body");
  assert.ok(src.includes("SORTS_C"), "the lifted function must be the one that owns the sorts");

  const h = await harness({ compliance: CORPUS });
  h.api.renderComplianceFilters();
  h.api.renderCompliance();
  assert.notEqual(h.el("comptable").innerHTML, "", "the lifted renderer must actually draw rows");
  assert.ok(h.drawnRows() > 0, "and those rows must be table rows");
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Count the thing you filter
// ─────────────────────────────────────────────────────────────────────────────

test("the compliance badge counts the rows drawn, for every filter combination", async () => {
  // The shipped bug, three times over in this file: a header counting a wider
  // set than the list beneath it. Swept rather than spot-checked.
  const checks = ["all", "power-schedule-enabled", "daily-reboot-enabled", "brightness-nonzero"];
  const bands = ["all", "compliant", "minor-drift", "non-compliant"];
  const searches = ["", "canvas", "reboot", "shelf", "zzz"];
  for (const ccheck of checks) {
    for (const cband of bands) {
      for (const cq of searches) {
        const h = await harness({ compliance: CORPUS, ccheck, cband, cq });
        h.api.renderComplianceFilters();
        h.api.renderCompliance();
        const q = h.api.complianceRows();
        assert.equal(
          h.badge(), String(q.pageRows.length),
          `check=${ccheck} band=${cband} q="${cq}": badge ${h.badge()} over ${q.pageRows.length} page rows`,
        );
        assert.equal(
          h.drawnRows(), q.pageRows.length,
          `check=${ccheck} band=${cband} q="${cq}": drew ${h.drawnRows()} rows for ${q.pageRows.length}`,
        );
        // And the badge is never larger than the set the rows were sliced from.
        assert.ok(Number(h.badge() || "0") <= q.rows.length,
          `check=${ccheck} band=${cband} q="${cq}": badge exceeds the matching set`);
      }
    }
  }
});

test("the band chips sum to the set they filter within, not to the whole estate", async () => {
  // The chips filter `matched` (after search and check), so they must count it.
  // Counting `all` would put 12 above a list of 4.
  const h = await harness({ compliance: CORPUS, ccheck: "daily-reboot-enabled" });
  h.api.renderComplianceFilters();
  const q = h.api.complianceRows();
  assert.equal(q.matched.length, 4, "the fixture must exercise a real narrowing");
  assert.equal(sum(h.chips()), q.matched.length,
    "the band chips must sum to the searched-and-checked set they filter");
  assert.notEqual(q.matched.length, q.all.length, "…and that set must not be the whole estate");
});

test("each band chip equals the rows that pressing it renders", async () => {
  const base = await harness({ compliance: CORPUS });
  base.api.renderComplianceFilters();
  const promised = base.chips();
  for (const [band, n] of Object.entries(promised)) {
    const h = await harness({ compliance: CORPUS, cband: band });
    h.api.renderCompliance();
    assert.equal(h.drawnRows(), n, `the "${band}" chip promised ${n} rows and rendered ${h.drawnRows()}`);
  }
});

test("each check option equals the rows that choosing it renders", async () => {
  const base = await harness({ compliance: CORPUS });
  const q = base.api.complianceRows();
  for (const [key, , promised] of q.checks) {
    const h = await harness({ compliance: CORPUS, ccheck: key });
    h.api.renderCompliance();
    assert.equal(h.drawnRows(), promised,
      `check option "${key}" promised ${promised} rows and rendered ${h.drawnRows()}`);
  }
});

test("a page is a page: the badge follows the slice, and the subtitle states the whole", async () => {
  // 120 rows over a 50-row page. The badge must read 50 and the subtitle must
  // say which 50 of how many — the pattern the incident queue already uses.
  const many = Array.from({ length: 120 }, (_, i) => row(i + 1, 50 + (i % 50), "minor-drift", [SCHEDULE()]));
  const h = await harness({ compliance: many, cpage: 2 });
  h.api.renderCompliance();
  const q = h.api.complianceRows();
  assert.equal(q.perPage, 50);
  assert.equal(q.pages, 3);
  assert.equal(h.badge(), "50");
  assert.equal(h.drawnRows(), 50);
  assert.match(h.el("compsub").textContent, /rows 51–100 of 120 matching/,
    "the subtitle must name the slice AND the matching total");
  assert.match(h.el("cpager").innerHTML, /Showing <b>50<\/b> of\s*<b>120/,
    "the pager must state both numbers too");
});

test("an out-of-range page is clamped rather than rendering an empty table", async () => {
  // A filter change can shrink the set under a page number that was valid a
  // moment ago; an empty table then reads as an estate with nothing in it.
  const h = await harness({ compliance: CORPUS, cpage: 99 });
  h.api.renderCompliance();
  const q = h.api.complianceRows();
  assert.equal(q.page, 1, "the page must be clamped to what exists");
  assert.equal(h.drawnRows(), CORPUS.length);
  assert.equal(h.badge(), String(CORPUS.length));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Never a fabricated zero
// ─────────────────────────────────────────────────────────────────────────────

test("a mean over nothing is null, and no score is printed for an unscored estate", async () => {
  const h = await harness({ compliance: [], devices: [{ id: "d1" }] });
  const q = h.api.complianceRows();
  assert.equal(q.mean, null, "the mean drift score must be null, never 0, when nothing is scored");
  h.api.renderCompliance();
  assert.equal(h.el("cscore").innerHTML, "",
    "no score block at all is honest; a 0% mean over zero devices is not");
  assert.match(h.el("comptable").innerHTML, /No device has returned a config snapshot/);
  assert.ok(!/0%/.test(h.el("cscore").innerHTML + h.el("compsub").textContent),
    "nothing on the screen may read as a 0% score");
});

test("an empty filter result says which filter emptied it and how many are scored", async () => {
  // "Nothing to show" over a filtered table is the kind of false that ends with
  // a technician telling a customer the estate is configured.
  const h = await harness({ compliance: CORPUS, cq: "no-such-device" });
  h.api.renderCompliance();
  const html = h.el("comptable").innerHTML;
  assert.match(html, /No scored device matches these filters/);
  assert.match(html, new RegExp(`${CORPUS.length} device\\(s\\) are scored in total`),
    "the estate total must appear beside the empty result");
  assert.equal(h.badge(), "0", "zero rows drawn IS zero — what must not happen is 0 standing for unknown");
  assert.match(h.el("compsub").textContent, /no row matches .*search "no-such-device"/,
    "and the subtitle must name the filter that did it");
});

test("a device with no config read says so in words rather than reading as fresh", async () => {
  const h = await harness({ compliance: [CORPUS[10] as Row] });
  h.api.renderCompliance();
  assert.match(h.el("comptable").innerHTML, /no config read recorded/,
    "a null settingsAgeSeconds must render its reason, not a dash that reads as 0 seconds");
});

test("a device with nothing flagged says so rather than rendering an empty cell", async () => {
  const h = await harness({ compliance: [CORPUS[11] as Row] });
  h.api.renderCompliance();
  assert.match(h.el("comptable").innerHTML, /nothing flagged on this device/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The scoring caveat (US-8.5.5)
// ─────────────────────────────────────────────────────────────────────────────

test("a check that flags nearly the whole estate is named beside the score", async () => {
  // The footer used to concede "flags 118 of 118" and leave it there. A check
  // firing on 83% of the estate is a policy default, not 118 faults.
  const h = await harness({ compliance: CORPUS });
  const q = h.api.complianceRows();
  assert.deepEqual(q.dominant.map((d) => d.id), ["power-schedule-enabled"],
    "the dominant check must be identified from the data");
  h.api.renderCompliance();
  const html = h.el("cscore").innerHTML;
  assert.match(html, /Power schedule enabled<\/b> flags 10 of 12/,
    "the caveat must NAME the check and state its share");
  assert.match(html, /scoring problem, not 10 separate faults/,
    "and it must say what that does to the flag count");
  assert.match(html, /data-conly="power-schedule-enabled"/,
    "and it must be one click from the rows it is about");
});

test("the scoring caveat does not move when the filters do", async () => {
  // It is a statement about the MODEL. A caveat that shrank under a filter
  // would read as a problem that had been fixed by looking away from it.
  const wide = await harness({ compliance: CORPUS });
  const narrow = await harness({ compliance: CORPUS, cband: "non-compliant", cq: "canvas" });
  const a = wide.api.complianceRows();
  const b = narrow.api.complianceRows();
  assert.ok(b.rows.length < a.rows.length, "the fixture must actually narrow");
  assert.deepEqual(b.dominant, a.dominant);
  assert.equal(b.flaggedAtAll, a.flaggedAtAll);
  assert.equal(b.mean, a.mean);
});

test("with no dominant check the surface says the flag count discriminates", async () => {
  // The opposite case must also be stated, or a silent caveat block would be
  // indistinguishable from a caveat that failed to render.
  const spread: Row[] = [
    row(1, 70, "non-compliant", [REBOOT()]),
    row(2, 80, "minor-drift", [BRIGHT()]),
    row(3, 90, "compliant", []),
    row(4, 95, "compliant", []),
  ];
  const h = await harness({ compliance: spread });
  assert.deepEqual(h.api.complianceRows().dominant, []);
  h.api.renderCompliance();
  assert.match(h.el("cscore").innerHTML, /No single check flags/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The sorts, and the copy of them the URL parser has to keep
// ─────────────────────────────────────────────────────────────────────────────

test("the compliance sort keys in the URL parser are exactly the ones SORTS_C offers", async () => {
  // Duplicated on purpose: urlReadParams() is lifted in isolation by
  // console-url-state.test.ts against a fixed declaration list, so it cannot
  // reference a top-level constant — a shared list there is undefined and
  // fails every parser test at once (observed, not theorised). So the two
  // copies are pinned to each other here instead.
  const script = await consoleScript();
  const queue = declarationOf(script, "complianceRows");
  const table = /const SORTS_C = \{([\s\S]*?)\n  \};/.exec(queue);
  assert.ok(table, "complianceRows() must still declare SORTS_C — this test pins the URL copy to it");
  const keys = [...(table[1] as string).matchAll(/^\s{4}([a-z]+):/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 5, `expected several compliance sorts, found ${keys.join(", ")}`);

  const parser = declarationOf(script, "urlReadParams");
  const inline = /patch\.csort = pick\("csort", \[([^\]]*)\]/.exec(parser);
  assert.ok(inline, "urlReadParams() must still validate csort against an inline list");
  const urlKeys = [...(inline[1] as string).matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...urlKeys].sort(), [...keys].sort(),
    "the URL's csort vocabulary has drifted from SORTS_C");
});

test("every sort is total, and none of them loses or invents a row", async () => {
  const h = await harness({ compliance: CORPUS });
  const keys = h.api.complianceRows().sorts.map(([k]) => k);
  for (const csort of keys) {
    const s = await harness({ compliance: CORPUS, csort });
    const q = s.api.complianceRows();
    assert.equal(q.rows.length, CORPUS.length, `sort "${csort}" changed the row count`);
    assert.equal(new Set(q.rows.map((r) => r.deviceId)).size, CORPUS.length,
      `sort "${csort}" duplicated or dropped a device`);
    s.api.renderCompliance();
    assert.equal(s.drawnRows(), CORPUS.length);
  }
});

test("the default sort is still worst score first", async () => {
  // docs/25 credits the existing order explicitly, so it stays the default.
  const h = await harness({ compliance: CORPUS });
  const q = h.api.complianceRows();
  assert.equal(q.active.sort, "score");
  assert.deepEqual(q.rows.map((r) => r.score), [...CORPUS].map((r) => r.score).sort((a, b) => a - b));
});

test("a config with no age recorded sorts after one that was read a second ago", async () => {
  /* The distinction only shows against an age that genuinely IS zero. A first
     version of this test asserted only "the null row is last", and a mutation
     replacing the -1 sentinel with 0 survived it: with every other age above
     zero, -1 and 0 order identically. So the fixture now holds a device read
     seconds ago, and the unread one carries the LOWER score — which is the
     tie-break, so a 0 sentinel would sort it ahead of the fresh row. */
  const fixture: Row[] = [
    row(1, 99, "compliant", [SCHEDULE()], { settingsAgeSeconds: 0, name: "Just read" }),
    row(2, 40, "non-compliant", [SCHEDULE()], { settingsAgeSeconds: null, name: "Never read" }),
    row(3, 80, "minor-drift", [SCHEDULE()], { settingsAgeSeconds: 7200 }),
  ];
  const h = await harness({ compliance: fixture, csort: "age" });
  const q = h.api.complianceRows();
  assert.equal(q.rows[q.rows.length - 1]?.name, "Never read",
    "a config that was never read must sort behind one read a second ago, not with it");
  assert.equal(q.rows[q.rows.length - 2]?.name, "Just read");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The search
// ─────────────────────────────────────────────────────────────────────────────

test("searching a check label finds the devices failing that check", async () => {
  // The story this epic names: "show me every device missing nightly reboot".
  const h = await harness({ compliance: CORPUS, cq: "nightly reboot" });
  const q = h.api.complianceRows();
  assert.equal(q.rows.length, 4);
  for (const r of q.rows) {
    assert.ok(r.drift.some((d) => d.checkId === "daily-reboot-enabled"),
      `${r.deviceId} matched a search for "nightly reboot" without failing it`);
  }
});

test("the search does not match on a device's numbers", async () => {
  // Searching "65" must not return the device whose score is 65: a score is not
  // an identifier, and matching it makes the box unpredictable.
  const h = await harness({ compliance: CORPUS, cq: "65" });
  assert.equal(h.api.complianceRows().rows.length, 0);
});

test("the truncation mark rides every compliance count, or none of them", async () => {
  // A count over a collection apiAll could not walk in full is a LOWER BOUND,
  // and one surface claiming it while another does not is worse than neither.
  const h = await harness({ compliance: CORPUS, trunc: { compliance: { loaded: 12, total: 99 } } });
  assert.equal(h.api.complianceRows().mark, "+");
  h.api.renderCompliance();
  assert.match(h.el("compsub").textContent, /of 12\+ matching/);
  assert.match(h.el("cscore").innerHTML, /12\+ scored device/);
});
