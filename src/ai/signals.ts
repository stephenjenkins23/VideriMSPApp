/**
 * Deterministic device-id resolution for the AI surfaces.
 *
 * THE BUG THIS REMOVES. The action plan's best item on the live tenant is
 * "Investigate site-level fault at Videri Sales, 39 devices" — and it shipped
 * `deviceIds: []` with five devices named in prose, while the correlation finding
 * it cites carried all 39 ids. So the product's single most valuable output was a
 * paragraph a technician could not enumerate and the console could not build a
 * drilldown from. The brief had the same bug in a nastier form: its `device` field
 * is free text, the client resolved it BY NAME, and 13 names are shared by 30
 * devices — so "open the broken device" opened a healthy twin.
 *
 * THE FIX IS A JOIN, NOT A PROMPT. We stopped asking the model for ids at all.
 * Every item is already required to name the signal it is built on; we give each
 * signal a short stable `ref`, constrain the model to cite refs it was actually
 * shown (a Zod enum, so an invented ref cannot be generated), and resolve the ids
 * ourselves afterwards from the engine output that produced the signal. A model
 * re-typing 39 uuids is a worse design than a join in three ways: it costs output
 * tokens, it can transcribe one wrong, and — as observed — it can decline.
 *
 * The ids are deliberately NOT in the payload the model sees (`describeSignals`
 * carries refs and counts only). Sending 39 uuids per finding would cost more
 * input tokens than the whole rest of the plan input and buy nothing.
 *
 * TWO TRUST LEVELS, BOTH LABELLED.
 *   - `cited-refs`: the item named the refs. The ids are a join; authoritative.
 *   - `inferred-from-source`: the item predates `sourceRefs` and only has prose.
 *     We match the prose against each signal's identity tokens, and we REFUSE on
 *     any ambiguity — a wrong cohort is the "healthy twin" bug again, one level up.
 * And when neither works, the item says so with a reason. An empty `deviceIds`
 * with no reason reads as "no devices affected", which is the lie we started with.
 *
 * Pure throughout: no IO, no clock, no database.
 */

/** One citable signal, with the device set behind it. */
export interface PlanSignal {
  /** The stable ref an item cites. The model copies this verbatim. */
  ref: string;
  /** One line, so the model can choose the right ref. Goes in the payload. */
  describes: string;
  /**
   * The device set this signal names — or `null` when the signal genuinely
   * cannot name devices (the aggregator rollups are CANVAS counts read from the
   * platform's group metrics; they carry no device ids of ours).
   *
   * `null`, never `[]`: the whole point of this module is that "we cannot list
   * them" and "there are none" stop looking the same.
   */
  deviceIds: string[] | null;
  /** Why the ids are unavailable. Non-null exactly when `deviceIds` is null. */
  reason: string | null;
  /**
   * Identity tokens used ONLY by the legacy prose path — a site name, a firmware
   * version, a bucket key. Never consulted when an item cites refs.
   */
  matchKeys: string[];
}

/**
 * What the MODEL is shown. Refs and counts, no ids.
 *
 * `deviceCount` is here on purpose: it is the enumerable size of the set, so an
 * item that cites a ref has the right `affectedCount` in front of it and never
 * has to estimate one.
 */
export interface SignalDescriptor {
  ref: string;
  describes: string;
  /** How many devices citing this ref enumerates. Null = this signal names none. */
  deviceCount: number | null;
  /** False = citing this ref cannot produce a device list, and why. */
  deviceIdsAvailable: boolean;
  reason?: string;
}

export function describeSignals(signals: readonly PlanSignal[]): SignalDescriptor[] {
  return signals.map((s) => ({
    ref: s.ref,
    describes: s.describes,
    deviceCount: s.deviceIds?.length ?? null,
    deviceIdsAvailable: s.deviceIds !== null,
    ...(s.reason ? { reason: s.reason } : {}),
  }));
}

/** The refs a generated item is allowed to cite, for the dynamic enum. */
export function signalRefs(signals: readonly PlanSignal[]): string[] {
  return signals.map((s) => s.ref);
}

export interface DeviceIdResolution {
  /** How the ids were obtained, or null when they could not be. */
  basis: "cited-refs" | "inferred-from-source" | null;
  /** The signal refs the ids were joined from. */
  refs: string[];
  /**
   * Why the list is empty. Non-null EXACTLY when `deviceIds` is empty — an empty
   * array with no reason is the failure this module exists to prevent.
   */
  reason: string | null;
  /**
   * Set only when the item's own `affectedCount` disagreed with the resolved set.
   * Names which figure is authoritative rather than leaving a reader to guess.
   */
  countNote: string | null;
}

/** What an item looks like to the resolver. Structural, so brief and plan share it. */
export interface ResolvableItem {
  /** The prose trace. Always present; the only trace legacy items have. */
  source: string;
  /** Refs cited by the model. Absent on items generated before this existed. */
  sourceRefs?: readonly string[] | undefined;
  /** The model's own count, when the surface has one. */
  affectedCount?: number | undefined;
}

export interface ResolvedIds {
  deviceIds: string[];
  /**
   * The count to display. Equal to `deviceIds.length` whenever ids resolved —
   * they can never disagree, because one is derived from the other.
   */
  affectedCount: number | undefined;
  resolution: DeviceIdResolution;
}

const NO_SIGNALS_REASON =
  "No citable signals were assembled for this run, so no item's device set could be " +
  "enumerated. This is an assembly gap, not a fleet with no affected devices.";

/**
 * Resolve one item's device set.
 *
 * Union across the cited refs, not intersection: an item that legitimately
 * collapses two signals — a firmware cohort plus the brightness restores inside
 * it — is about every device in either, and a technician needs the whole
 * worklist. Deduped, order-stable.
 *
 * `sourceRefs` is SCOPE, not evidence: the prompt tells the model to cite only
 * refs whose devices it is telling the operator to act on. That distinction is
 * what stops "11 brightness restores, corroborated by 22 scheduling gaps" from
 * resolving to 33 devices.
 */
export function resolveDeviceIds(
  item: ResolvableItem,
  signals: readonly PlanSignal[],
): ResolvedIds {
  const byRef = new Map(signals.map((s) => [s.ref, s]));

  const cited = item.sourceRefs ?? [];
  const matched: Match =
    cited.length > 0
      ? {
          basis: "cited-refs",
          signals: cited.map((r) => byRef.get(r)).filter(isSignal),
          unknown: cited.filter((r) => !byRef.has(r)),
        }
      : corroborate(item, inferFromSource(item.source, signals));

  const ids = union(matched.signals);
  const refs = matched.signals.map((s) => s.ref);

  if (ids.length > 0) {
    // The join is authoritative for the LIST, therefore for the COUNT: they are
    // the same fact, and a count that disagrees with the list it summarises is
    // exactly the disagreement this is meant to make impossible.
    const countNote =
      item.affectedCount !== undefined && item.affectedCount !== ids.length
        ? `The item text says ${item.affectedCount} device(s); the set resolved from ` +
          `${refs.join(", ")} holds ${ids.length}. THE RESOLVED SET IS AUTHORITATIVE — it is ` +
          `the list a technician can open — and affectedCount has been set to match it.`
        : null;
    return {
      deviceIds: ids,
      affectedCount: ids.length,
      resolution: { basis: matched.basis, refs, reason: null, countNote },
    };
  }

  return {
    deviceIds: [],
    // Nothing resolved, so the item's own figure is all we have. It stays, and
    // the reason below is what stops an empty list reading as "no devices".
    affectedCount: item.affectedCount,
    resolution: {
      basis: null,
      refs,
      reason: unresolvedReason(item, matched, signals),
      countNote: null,
    },
  };
}

const union = (signals: readonly PlanSignal[]): string[] =>
  unionIds(signals.map((s) => s.deviceIds ?? []));

/** Deduped, order-stable union — the order is the first signal's, which ranks. */
function unionIds(sets: readonly (readonly string[])[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const set of sets) {
    for (const id of set) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * The legacy path's corroboration step — and the reason that path is safe to
 * have at all.
 *
 * Prose can name a signal it merely quotes a number from ("…byKind auto-safe =
 * 11 and proofOfPlay.summary.byReason 'screen off' = 22"), so the naive union
 * over-reaches: it would hand a technician 33 devices for an 11-device job. The
 * item's own count settles it. We accept a device set only when the numbers
 * corroborate — one matched signal of exactly that size, or a union of exactly
 * that size — and otherwise we refuse and say so. An uncorroborated guess at a
 * cohort is the same class of error as the brief opening a healthy twin.
 */
function corroborate(item: ResolvableItem, matched: Match): Match {
  const withIds = matched.signals.filter((s) => s.deviceIds !== null);
  if (matched.ambiguous || withIds.length === 0) return matched;

  if (item.affectedCount === undefined) {
    // No count to corroborate against (the brief has none). One unambiguous
    // signal is still safe; a choice between several is not.
    return withIds.length === 1
      ? { ...matched, signals: withIds }
      : { ...matched, signals: [], uncorroborated: `${withIds.length} signals matched the prose and there is no count to choose between them` };
  }

  const exact = withIds.filter((s) => s.deviceIds!.length === item.affectedCount);
  if (exact.length === 1) return { ...matched, signals: exact };
  if (union(withIds).length === item.affectedCount) return { ...matched, signals: withIds };

  return {
    ...matched,
    signals: [],
    uncorroborated:
      `the prose matched ${withIds.map((s) => `${s.ref} (${s.deviceIds!.length})`).join(", ")}, ` +
      `and neither one of those alone nor all of them together comes to the ` +
      `${item.affectedCount} the item claims`,
  };
}

const isSignal = (s: PlanSignal | undefined): s is PlanSignal => s !== undefined;

interface Match {
  basis: "cited-refs" | "inferred-from-source";
  signals: PlanSignal[];
  unknown: string[];
  /** Set by the legacy path when the prose matched ambiguously and we refused. */
  ambiguous?: string;
  /** Set when the prose matched, but the counts did not corroborate the match. */
  uncorroborated?: string;
}

/**
 * The legacy path: an item that carries only prose.
 *
 * Matches the item's `source` text against each signal's identity tokens — a
 * site name, a firmware version, a bucket key — as whole tokens, so "Avery" in
 * `source` does not match a signal keyed "Avery Lane". Then REFUSES if two
 * matched keys stand in a substring relation to each other, because that is the
 * case where we cannot tell which cohort was meant, and guessing is how the
 * brief used to open a healthy twin of a broken device.
 */
function inferFromSource(source: string, signals: readonly PlanSignal[]): Match {
  const hits: Array<{ signal: PlanSignal; key: string }> = [];
  for (const signal of signals) {
    const key = signal.matchKeys
      .filter((k) => k.trim().length > 0 && containsToken(source, k))
      // Longest first: a signal keyed by both its uuid and its display name
      // should report the more specific hit.
      .sort((a, b) => b.length - a.length)[0];
    if (key !== undefined) hits.push({ signal, key });
  }

  for (const a of hits) {
    for (const b of hits) {
      if (a.signal.ref === b.signal.ref || a.key === b.key) continue;
      if (a.key.includes(b.key)) {
        return {
          basis: "inferred-from-source",
          signals: [],
          unknown: [],
          ambiguous:
            `the prose names "${b.key}", which cannot be told apart from "${a.key}" ` +
            `(${b.signal.ref} vs ${a.signal.ref})`,
        };
      }
    }
  }

  return { basis: "inferred-from-source", signals: hits.map((h) => h.signal), unknown: [] };
}

/** Substring match on token boundaries — letters and digits either side disqualify. */
function containsToken(haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let from = 0;
  for (;;) {
    const at = h.indexOf(n, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : h[at - 1]!;
    const after = h[at + n.length] ?? "";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = at + 1;
  }
}

/**
 * Why an item has no device list. Every branch names a cause: this string is the
 * whole difference between an honest gap and an empty array that reads as "none".
 */
function unresolvedReason(
  item: ResolvableItem,
  matched: Match,
  signals: readonly PlanSignal[],
): string {
  if (signals.length === 0) return NO_SIGNALS_REASON;

  if (matched.basis === "cited-refs") {
    const idless = matched.signals.filter((s) => s.deviceIds === null);
    if (idless.length > 0) {
      return (
        `The signal(s) this item cites (${idless.map((s) => s.ref).join(", ")}) carry no device ` +
        `ids: ${idless.map((s) => s.reason).join(" ")} The count above is real; the device list ` +
        `is not available from this source.`
      );
    }
    if (matched.unknown.length > 0) {
      return (
        `This item cites ${matched.unknown.join(", ")}, which is not a signal supplied to this ` +
        `run, so its device set could not be resolved. Treat the item's scope as unverified.`
      );
    }
    return (
      `The signal(s) this item cites (${matched.signals.map((s) => s.ref).join(", ")}) resolved ` +
      `to no devices. The cohort behind them is empty, which contradicts the item — treat its ` +
      `scope as unverified.`
    );
  }

  if (matched.uncorroborated) {
    return (
      `This item records its basis only in prose, and the device sets that prose points at do ` +
      `not add up: ${matched.uncorroborated}. Rather than hand over a set we cannot corroborate, ` +
      `no device list is offered. Regenerate the plan so the item cites its signal refs.`
    );
  }

  if (matched.ambiguous) {
    return (
      `This item records its basis only in prose, and that prose matches more than one signal ` +
      `ambiguously — ${matched.ambiguous}. Rather than open the wrong cohort, no device list is ` +
      `offered. Regenerate the plan so the item cites its signal refs.`
    );
  }

  return (
    `This item records its basis only in prose ("${item.source}"), which does not name any of ` +
    `the ${signals.length} signals supplied to this run, so its device set could NOT be ` +
    `enumerated. The count above is the item's own figure. Regenerate the plan so items cite ` +
    `their signal refs.`
  );
}

// ── the catalog: one PlanSignal per citable engine output ────────────────────
//
// Every ref is minted from a STABLE id the engine already computes for the UI to
// key on (`Finding.id`, `Recommendation.id`, a group uuid), so the same cohort
// keeps the same ref across runs and a stored plan's refs still mean something.

/**
 * Site uuid → display name, read off the DeviceViews the engines ran over.
 *
 * Venue findings are keyed by uuid (a display name can be renamed or blank, and
 * is not an identity), but a legacy plan's prose names the SITE, so the legacy
 * path needs the name as a match key. Built here rather than in correlation.ts
 * so that engine stays untouched.
 */
export function siteNameIndex(
  devices: readonly { site: { uuid: string; name: string | null } | null }[],
): Map<string, string | null> {
  const names = new Map<string, string | null>();
  for (const d of devices) {
    if (d.site && !names.has(d.site.uuid)) names.set(d.site.uuid, d.site.name);
  }
  return names;
}

/** Findings already carry their device set — this is the join the model was doing badly. */
export function correlationSignals(
  findings: readonly {
    id: string;
    kind: string;
    affectedDeviceIds: string[];
    summary: string;
  }[],
  siteNames: Map<string, string | null> = new Map(),
): PlanSignal[] {
  return findings.map((f) => ({
    ref: `correlation/${f.id}`,
    describes: `${f.kind}: ${f.summary}`,
    deviceIds: f.affectedDeviceIds,
    reason: null,
    matchKeys: findingMatchKeys(f.id, siteNames),
  }));
}

/**
 * Identity tokens for the legacy prose path.
 *
 * Derived from the finding id, which encodes the cohort key: `venue::site::UUID`,
 * `firmware::VERSION`, `venue::city::CITY`. The uuid is useless in prose, so a
 * site also matches on its display name; everything else matches on its own id.
 */
function findingMatchKeys(id: string, siteNames: Map<string, string | null>): string[] {
  const site = /^venue::site::(.+)$/.exec(id);
  if (site) {
    const name = siteNames.get(site[1]!);
    return [site[1]!, ...(name && name.trim().length > 0 ? [name.trim()] : [])];
  }
  const firmware = /^firmware::(.+)$/.exec(id);
  if (firmware) return [firmware[1]!];
  const city = /^venue::city::(.+)$/.exec(id);
  if (city) return [city[1]!];
  return [id];
}

interface Rec {
  id: string;
  deviceIds: string[];
  deviceLabel: string;
  kind: string;
  category: string;
  symptom: string;
}

/**
 * Remediation, at the two granularities a plan item actually uses: the buckets
 * the summary reports (an item says "the 11 auto-safe restores") and the
 * individual ranked recommendations.
 *
 * Bucket refs are minted only for non-empty buckets, so a ref always resolves to
 * at least one device and `deviceIdsAvailable` never lies.
 */
export function remediationSignals(
  recs: readonly Rec[],
  /** The subset the model was shown. Only these get a per-recommendation ref. */
  top: readonly Rec[] = recs,
): PlanSignal[] {
  const signals: PlanSignal[] = [];

  const bucket = (
    field: "kind" | "category",
    key: string,
    members: readonly { deviceIds: string[] }[],
  ): void => {
    if (members.length === 0) return;
    const path = field === "kind" ? `byKind ${key}` : `byCategory ${key}`;
    signals.push({
      ref: `remediation/${field}::${key}`,
      describes: `every device under remediation.summary ${path} (${members.length} recommendation(s))`,
      deviceIds: unionIds(members.map((m) => m.deviceIds)),
      reason: null,
      matchKeys: [path],
    });
  };

  for (const kind of distinct(recs.map((r) => r.kind))) {
    bucket("kind", kind, recs.filter((r) => r.kind === kind));
  }
  for (const category of distinct(recs.map((r) => r.category))) {
    bucket("category", category, recs.filter((r) => r.category === category));
  }
  for (const rec of top) {
    signals.push({
      ref: `remediation/rec::${rec.id}`,
      describes: `one recommendation: ${rec.deviceLabel} — ${rec.symptom}`,
      deviceIds: rec.deviceIds,
      reason: null,
      matchKeys: [rec.id],
    });
  }
  return signals;
}

/**
 * Proof-of-play gaps.
 *
 * The plan carries only POP's COUNTS, but the persisted report behind them is
 * per-device, so the gap cohorts are enumerable — which is the whole reason this
 * module exists rather than a schema constraint.
 */
export function proofOfPlaySignals(
  gaps: readonly { deviceId: string; gap: boolean; reason: string | null }[],
): PlanSignal[] {
  const open = gaps.filter((g) => g.gap);
  if (open.length === 0) return [];

  const signals: PlanSignal[] = [
    {
      ref: "proof-of-play/gaps",
      describes: `every device with a scheduling-versus-screen-state gap (${open.length})`,
      deviceIds: open.map((g) => g.deviceId),
      reason: null,
      matchKeys: ["proofOfPlay.summary.gaps", "summary.gaps"],
    },
  ];
  for (const reason of distinct(open.map((g) => g.reason).filter((r): r is string => r !== null))) {
    const members = open.filter((g) => g.reason === reason);
    signals.push({
      ref: `proof-of-play/gaps::${reason}`,
      describes: `devices whose gap reason is "${reason}" (${members.length})`,
      deviceIds: members.map((g) => g.deviceId),
      reason: null,
      matchKeys: [`byReason '${reason}'`, `byReason ${reason}`],
    });
  }
  return signals;
}

/**
 * The aggregator rollups — the one block that HONESTLY cannot name devices.
 *
 * These are canvas counts read from the platform's own group metrics; they are
 * not our device rows and the two totals are not reconcilable (see the plan's
 * system prompt). So the signal exists — an item may legitimately be built on it
 * — and carries `deviceIds: null` WITH the reason, which is what makes "cannot
 * be listed" distinguishable from "nothing to list".
 */
export function rollupSignals(
  groups: readonly { uuid: string; name: string | null; offline30d: number; totalCanvases: number }[],
): PlanSignal[] {
  return groups.map((g) => ({
    ref: `rollups/group::${g.uuid}`,
    describes:
      `group rollup ${g.name ?? g.uuid}: ${g.offline30d} of ${g.totalCanvases} canvases offline 30d`,
    deviceIds: null,
    reason:
      "the aggregator rollups are CANVAS counts read from the platform's group metrics, not " +
      "our device rows, so they carry no device ids to enumerate.",
    matchKeys: [g.uuid, ...(g.name && g.name.trim().length > 0 ? [g.name.trim()] : [])],
  }));
}

/**
 * The brief's attention list: one ref per device, so a single-device item
 * resolves to that exact id.
 *
 * This is the brief's version of the bug, and the reason it was worse: `device`
 * is free text, the client resolved it BY NAME, and 13 names on this tenant are
 * shared by 30 devices with 17 more carrying stray whitespace — so a name lookup
 * opened a HEALTHY twin of the broken device. A ref is an id by construction.
 */
export function attentionSignals(
  devices: readonly { id: string; name: string | null; status: string; openAlertCount: number }[],
): PlanSignal[] {
  return devices.map((d) => ({
    ref: `attention/device::${d.id}`,
    describes:
      `${d.name?.trim() || "(unnamed)"} — ${d.status}, ${d.openAlertCount} open alert(s)`,
    deviceIds: [d.id],
    reason: null,
    // The id only. Matching a legacy brief item on the NAME is precisely the
    // healthy-twin bug, so the name is deliberately NOT a match key.
    matchKeys: [d.id],
  }));
}

const distinct = <T>(values: readonly T[]): T[] => [...new Set(values)];
