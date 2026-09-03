/**
 * Device intent, inferred from the device's own NAME — US-8.2.7.
 *
 * THE PROBLEM THIS SOLVES
 * The live auto-safe queue offered a HIGH-severity brightness restore at 0.9
 * confidence on `SparkBridge (EoL)`. The device's own name says End of Life. We
 * were about to one-click a write onto a decommissioned asset, and 42 of 250
 * active devices carry the same kind of statement in their names (`(EoL)`,
 * `[RMA]`, `Lab TCL`, `Not Product`, `Travel Case Unit`,
 * `stephen.jenkins@videri.com-6`). 39 of them hold 22% of the open alert queue.
 *
 * WHAT THIS IS — AND EMPHATICALLY IS NOT
 * This is a SIGNAL, never a verdict. A device name is a free-text field a human
 * typed, on a customer's estate, and we do not own it. So:
 *
 *   - it NEVER suppresses, resolves, hides or deletes anything. Its only effect
 *     is to DEMOTE a recommendation out of `auto-safe` into `manual` — the
 *     recommendation still appears, at its original severity, with the reason
 *     for the demotion in its rationale. A false positive therefore costs an
 *     operator one extra click and nothing else, which is why a heuristic is
 *     admissible here and would not be admissible as a suppressor.
 *   - it is ALWAYS attributed to the heuristic (`source: "device-name"`), never
 *     presented as a recorded fact, and it carries the exact substring it
 *     matched so an operator can see for themselves whether we are right.
 *   - a REAL suppression — an operator's recorded conclusion, with actor, reason
 *     and expiry (alerting/suppression.ts) — always outranks it. `resolveIntent`
 *     below takes the recorded decision first and only falls back to the name.
 *     A recorded `none` is how an operator tells us the name is lying.
 *
 * MATCHING, AND WHY IT IS TWO-STRENGTH
 * Intent on this fleet is written two ways, and they do not deserve equal
 * credence:
 *
 *   STRONG — the intent sits in its own bracketed segment (`SparkBridge (EoL)`,
 *   `SparkQ [RMA]`), or the name IS the intent (`Test`, `Not Product`), or it is
 *   the auto-provisioned internal-account form (`name@videri.com-4`). A human
 *   deliberately annotated the asset; coincidence is implausible.
 *
 *   WEAK — the token appears as a bare word among others (`Lab TCL`,
 *   `Harbor Unit Repair 1`, `Lowes 3D Test`). Usually right on this fleet, but
 *   `Repairs Desk Menu Board` is a perfectly good name for a production screen
 *   in a phone-repair shop, and we would be wrong about it.
 *
 * Both strengths demote, because demotion is safe in either direction. The
 * strength is what the surface reports and what a reviewer triages by.
 *
 * FALSE POSITIVES ARE GUARDED, NOT WISHED AWAY
 * Every token matches on WORD BOUNDARIES only — never as a substring. Substring
 * matching on this vocabulary is catastrophic and quietly so: `eol` is inside
 * `Seoul`, `test` is inside `Latest` and `Contest`, `lab` is inside `Label` and
 * `Labrador`, `QA` is inside this fleet's real `QAreception05-sq-16`. All four
 * are asserted as non-matches in the tests. Multi-word tokens (`Not Product`,
 * `Travel Case`) tolerate any run of whitespace but nothing else.
 *
 * Pure. No I/O, no dates, no configuration.
 */

/**
 * What we think the asset is FOR. Ordered by consequence in `KIND_RANK`, not
 * alphabetically — when a name matches two kinds the more consequential wins.
 *
 * `none` is not inferable; it exists only as an operator's explicit override
 * ("this device is production, ignore its name") and is why the type is shared
 * with the suppression record rather than being private to this module.
 */
export type DeviceIntentKind =
  | "eol"
  | "not-product"
  | "repair"
  | "prototype"
  | "lab"
  | "test"
  | "demo-unit"
  | "internal-account"
  | "none";

/** How much credence the match itself deserves. See the header. */
export type IntentStrength = "strong" | "weak";

export interface DeviceIntent {
  kind: DeviceIntentKind;
  strength: IntentStrength;
  /**
   * Where the conclusion came from. `device-name` is a heuristic and must be
   * rendered as one; `operator` is a recorded decision with an audit row behind
   * it. Nothing else may ever be added here without an audit trail to match.
   */
  source: "device-name" | "operator";
  /** The exact text we matched, verbatim from the name. Empty for `operator`. */
  matchedText: string;
  /** One sentence, for a human, saying what we saw and how sure we are. */
  rationale: string;
  /**
   * Other kinds the same name matched, most consequential first. Published so a
   * name like `Lab NEWISH Sparkbridge (EoL)` does not silently lose half its
   * evidence to the winner.
   */
  alsoMatched: DeviceIntentKind[];
}

/**
 * One token vocabulary entry.
 *
 * `pattern` is built once at module load with `\b` anchors on both ends. Tokens
 * containing a space accept any whitespace run, so `Not  Product` and
 * `Not\nProduct` match and `NotProduct` does not — a name with no separator is
 * a different word, not a sloppy version of this one.
 */
interface Token {
  kind: DeviceIntentKind;
  literal: string;
  pattern: RegExp;
}

const KIND_RANK: Record<DeviceIntentKind, number> = {
  eol: 0,
  "not-product": 1,
  repair: 2,
  prototype: 3,
  lab: 4,
  test: 5,
  "demo-unit": 6,
  "internal-account": 7,
  // Never inferred, never competes. Present so the record is exhaustive.
  none: 99,
};

/**
 * The vocabulary, kind by kind. Deliberately small: every token here was read
 * off a real name on this fleet or is the unambiguous spelling variant of one.
 * Speculative additions are how a heuristic starts flagging production screens.
 *
 * Notably ABSENT, on purpose:
 *   - `Dev`  — `\bDev\b` does not match `Dev07-v3-j2d01` anyway (digit follows a
 *              word character, so there is no boundary), and where it would match
 *              it catches "Development Office" and "Devon".
 *   - `Old`  — `old spark 2 griff` is probably a spare, but "old" is an adjective
 *              about hardware, not a statement of purpose.
 *   - `Support` — `Support R58` reads as a support-desk screen as easily as a
 *              support-team spare.
 * Each of those is a judgement an operator should record explicitly, not one we
 * should guess.
 */
const TOKEN_LITERALS: ReadonlyArray<{ kind: DeviceIntentKind; literals: readonly string[] }> = [
  { kind: "eol", literals: ["EoL", "EOL", "End of Life", "End-of-Life", "Decom", "Decommissioned", "Retired"] },
  { kind: "not-product", literals: ["Not Product", "Not a Product", "Non Product"] },
  { kind: "repair", literals: ["Repair", "Repairs", "RMA", "Broken", "Faulty"] },
  { kind: "prototype", literals: ["Proto", "Prototype", "EVT", "DVT", "PVT"] },
  { kind: "lab", literals: ["Lab", "Labs"] },
  { kind: "test", literals: ["Test", "Tests", "Testing", "Testbed", "Test Bed", "QA"] },
  { kind: "demo-unit", literals: ["Travel Case", "Demo Unit", "Roadshow", "Loaner"] },
];

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TOKENS: readonly Token[] = TOKEN_LITERALS.flatMap(({ kind, literals }) =>
  literals.map((literal) => ({
    kind,
    literal,
    // `\b` on both ends is the whole false-positive defence — see the header.
    // The `i` flag is safe here because every token is a word, not an acronym
    // that means something else in lower case.
    pattern: new RegExp(`\\b${escape(literal).replace(/ /g, "\\s+")}\\b`, "i"),
  })),
);

/**
 * The auto-provisioned internal-account form: `first.last@videri.com-4`,
 * sometimes prefixed (`Montreal Office-hugues.oliver@videri.com-1`).
 *
 * These are not customer assets at all — they are the platform's own per-user
 * scratch canvases. Anchored to `@videri.com-<digits>` and to the END of the
 * name, and deliberately NOT generalised to any `<email>-<n>`: this fleet also
 * carries `hunter@screenfeed.com-1`, which belongs to a partner. Treating a
 * partner's device as ours would demote recommendations on somebody's real
 * screen, which is the direction of error that actually costs a customer money.
 *
 * The local part excludes `-` so that a PREFIXED name reports the account it
 * actually found: `Montreal Office-hugues.oliver@videri.com-1` matches
 * `hugues.oliver@videri.com-1`, not `Office-hugues.oliver@videri.com-1`. A local
 * part that genuinely contains a hyphen still matches from after it — the
 * `@videri.com-<n>` suffix is the whole signal, and `matchedText` is shown to an
 * operator, so it must not be a substring that looks like a parsing bug.
 */
const INTERNAL_ACCOUNT = /[a-z0-9._+]+@videri\.com-\d+\s*$/i;

/** Bracketed segments: `(EoL)`, `[RMA]`, `{Marc}`. Content only, brackets dropped. */
const BRACKETED = /[([{]([^)\]}]*)[)\]}]/g;

/**
 * A bracketed segment counts as a deliberate annotation only when it is SHORT —
 * the token plus at most a two-word qualifier (`(EoL 2025)`, `[RMA pending]`).
 * `(this unit was sent for repair by Dave in March)` is prose that happens to be
 * in brackets, and treating prose as an annotation would inflate `strong`.
 */
const MAX_ANNOTATION_WORDS = 3;

/**
 * Words that carry no identity, so a name that is ONLY a token plus these is
 * still "the name IS the intent": `Travel Case Unit`, `Test Device 2`.
 *
 * Kept tiny on purpose. Every word added here promotes more names from `weak`
 * to `strong`, and `strong` is the claim we are asserting most confidently — so
 * the list may only contain words that genuinely cannot distinguish one asset
 * from another.
 */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  "unit", "units", "device", "devices", "canvas", "screen", "panel", "display", "the", "a",
]);

/**
 * Does this token account for the WHOLE name?
 *
 * Removes the matched text and asks whether anything identifying is left. Pure
 * digits, punctuation and `FILLER_WORDS` are not identifying; anything else is,
 * and its presence means the name is "<something> Test", not "Test" — a bare
 * word among others, which is the WEAK case.
 */
function tokenIsWholeName(name: string, matched: string): boolean {
  const remainder = name.replace(matched, " ");
  return remainder
    .split(/[\s\-_/.]+/)
    .filter((word) => word !== "")
    .every((word) => /^\d+$/.test(word) || FILLER_WORDS.has(word.toLowerCase()));
}

/**
 * Infer intent from a device name. `null` means "nothing in this name says
 * anything about purpose", which is the answer for ~90% of the fleet and is NOT
 * a statement that the device is production.
 */
export function inferDeviceIntent(name: string | null | undefined): DeviceIntent | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed === "") return null;

  const matches: Array<{ kind: DeviceIntentKind; strength: IntentStrength; matchedText: string; why: string }> = [];

  // ── 1. the internal-account form. Structural, so always strong. ──
  const account = INTERNAL_ACCOUNT.exec(trimmed);
  if (account) {
    matches.push({
      kind: "internal-account",
      strength: "strong",
      matchedText: account[0].trim(),
      why:
        `the name ends in the auto-provisioned internal-account form ` +
        `"${account[0].trim()}", so this is a Videri staff scratch canvas rather than ` +
        `a managed customer asset`,
    });
  }

  // ── 2. tokens inside a short bracketed segment, or standing alone. STRONG. ──
  const annotations: string[] = [];
  for (const segment of trimmed.matchAll(BRACKETED)) {
    const content = (segment[1] ?? "").trim();
    if (content !== "" && content.split(/\s+/).length <= MAX_ANNOTATION_WORDS) annotations.push(content);
  }
  for (const token of TOKENS) {
    const annotation = annotations.find((a) => token.pattern.test(a));
    if (annotation !== undefined) {
      matches.push({
        kind: token.kind,
        strength: "strong",
        matchedText: annotation,
        why:
          `the name carries "${annotation}" as a deliberate annotation in brackets, ` +
          `which on this fleet means the asset was tagged by hand`,
      });
      continue;
    }
    const bare = token.pattern.exec(trimmed);
    if (!bare) continue;

    // The whole name being the token is the same kind of deliberate statement as
    // a bracketed one: nobody names a production screen `Test` or `Not Product`.
    if (tokenIsWholeName(trimmed, bare[0])) {
      matches.push({
        kind: token.kind,
        strength: "strong",
        matchedText: bare[0],
        why:
          `the device's whole name is "${trimmed}" — that is a statement of purpose, ` +
          `not a location or an asset identifier`,
      });
      continue;
    }

    // ── 3. a bare word among others. WEAK: usually right, sometimes a real name. ──
    matches.push({
      kind: token.kind,
      strength: "weak",
      matchedText: bare[0],
      why:
        `the name contains the word "${bare[0]}", which usually marks a non-production ` +
        `unit — but a production screen can legitimately be named this, so treat it ` +
        `as a prompt to check rather than a fact`,
    });
  }

  if (matches.length === 0) return null;

  // Strong beats weak; among equals the more consequential kind wins. Stable, so
  // the same name always yields the same verdict across polls.
  matches.sort((a, b) => {
    if (a.strength !== b.strength) return a.strength === "strong" ? -1 : 1;
    return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  });

  const winner = matches[0]!;
  const alsoMatched = [...new Set(matches.map((m) => m.kind))]
    .filter((kind) => kind !== winner.kind)
    .sort((a, b) => KIND_RANK[a] - KIND_RANK[b]);

  return {
    kind: winner.kind,
    strength: winner.strength,
    source: "device-name",
    matchedText: winner.matchedText,
    rationale:
      `Inferred from the device NAME, not from a recorded decision: ${winner.why}. ` +
      `Name-based inference is a heuristic — rename the device or record an intent ` +
      `suppression to make this explicit either way.`,
    alsoMatched,
  };
}

/**
 * An operator's RECORDED intent decision, which outranks anything a name says.
 *
 * Shaped as the subset of a suppression record this module needs, so that
 * `alerting/suppression.ts` can hand one over without this module importing it
 * (and so the dependency runs one way only: intent knows nothing about alerts).
 */
export interface RecordedIntent {
  kind: DeviceIntentKind;
  reason: string;
  by: string;
  at: string;
}

/**
 * The one function callers should use: recorded decision first, name second.
 *
 * This is where "a real suppression always outranks inferred intent" is
 * actually enforced, in one place, rather than being re-derived by every caller:
 *
 *   - a recorded intent of anything other than `none` returns `source:
 *     "operator"` and the name is never consulted;
 *   - a recorded intent of `none` returns `null` even when the name screams
 *     `(EoL)`. This is the override that matters: an operator who has looked at
 *     `Repairs Desk Menu Board` and confirmed it is a production screen must be
 *     able to stop us demoting it, permanently, and be believed.
 */
export function resolveIntent(
  name: string | null | undefined,
  recorded: RecordedIntent | null | undefined,
): DeviceIntent | null {
  if (recorded) {
    if (recorded.kind === "none") return null;
    return {
      kind: recorded.kind,
      strength: "strong",
      source: "operator",
      matchedText: "",
      rationale:
        `Recorded by ${recorded.by} on ${recorded.at}: ${recorded.reason}. This is an ` +
        `operator's decision, not an inference from the device name.`,
      alsoMatched: [],
    };
  }
  return inferDeviceIntent(name);
}

/** Every kind that can be INFERRED, for surfaces that need to enumerate them. */
export const INFERABLE_INTENT_KINDS: readonly DeviceIntentKind[] = TOKEN_LITERALS.map((t) => t.kind)
  .concat("internal-account")
  .sort((a, b) => KIND_RANK[a] - KIND_RANK[b]);

/** Every kind an operator may RECORD, which adds the `none` override. */
export const RECORDABLE_INTENT_KINDS: readonly DeviceIntentKind[] = [
  ...INFERABLE_INTENT_KINDS,
  "none",
];
