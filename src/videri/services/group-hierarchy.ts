/**
 * Group hierarchy → site dimension (Epic 2, US-2.1 rewire).
 *
 * The tenant's location metafield is unusable: CITY is "LONDON" on 99.6% of the
 * estate (tenant demo data, not our bug), so clustering by it can only invent one
 * meaningless mega-venue. But `rpm /v1/groups` returns `parentUuid` on every
 * group, and those 94 groups form a 5-level tree rooted at "Videri Prod".
 * Rolling a device up to its **depth-1 ancestor** — the child of the root, i.e.
 * the top-level org unit — produces ten clean site buckets covering 234 of 250
 * devices with zero unresolved:
 *
 *   Videri Sales 78, Techops 56, Montreal Office 31, NYC Office 31,
 *   Product Team 11, Avery 9, Shaun's Home Base 8, Omar Barake Home Office 8,
 *   Sara's Office 1, testing 1.
 *
 * That is the dimension venue correlation now clusters on.
 *
 * Everything here is PURE: `RawGroup[]` in, an index and resolutions out. The IO
 * (reading the group list) belongs to AggregatorService; the caching wrapper that
 * keeps correlation from refetching 94 groups per request is `GroupSiteCache` at
 * the bottom of this file, and it is the only part that touches the network.
 *
 * The join key is **`group_id`, never `group_name`**: device 1000015 comes back
 * with a populated `group_id` and an EMPTY `group_name`, while the hierarchy names
 * that group correctly ("Product Team"). Fleet-wide, group_id covers 234 devices
 * and group_name only 233 — and a name is not an identity in a tree where two
 * siblings may share a display name.
 */

import type { RawGroup } from "./aggregator.js";
import type { DeviceView } from "../../intelligence/remediation.js";
import type { VideriHttp } from "../http.js";
import { AggregatorService } from "./aggregator.js";

/** One resolved site bucket: the depth-1 ancestor of a device's group. */
export interface SiteRef {
  uuid: string;
  /** The group's display name, or null when the platform sets none. */
  name: string | null;
}

interface GroupNode {
  uuid: string;
  name: string | null;
  parentUuid: string | null;
}

/** An immutable lookup over the group tree, keyed by uuid. */
export type GroupIndex = ReadonlyMap<string, GroupNode>;

/**
 * Pure: index the flat group list by uuid.
 *
 * Groups without a uuid are dropped (they cannot be joined to anything); an empty
 * `parentUuid` string is normalised to null so "" never looks like a real parent.
 */
export function buildGroupIndex(groups: readonly RawGroup[]): GroupIndex {
  const index = new Map<string, GroupNode>();
  for (const group of groups) {
    if (!group?.uuid) continue;
    const parent = group.parentUuid?.trim();
    index.set(group.uuid, {
      uuid: group.uuid,
      name: group.displayName?.trim() ? group.displayName.trim() : null,
      parentUuid: parent ? parent : null,
    });
  }
  return index;
}

/**
 * Pure: the chain from a group up to the topmost ancestor we can see, root LAST.
 *
 * A `parentUuid` pointing at a group not in the index terminates the walk — the
 * deepest ancestor we actually hold acts as the root, which is the honest answer
 * when the list we were given is partial. A cycle terminates it too (guarded by
 * the visited set) rather than looping forever.
 */
export function ancestorChain(index: GroupIndex, groupId: string): GroupNode[] {
  const chain: GroupNode[] = [];
  const visited = new Set<string>();
  let cursor: string | null = groupId;
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor);
    const node = index.get(cursor);
    if (!node) break;
    chain.push(node);
    cursor = node.parentUuid;
  }
  return chain;
}

/**
 * Pure: a device's site = the DEPTH-1 ancestor of its group (the child of the
 * tree root), or null when there isn't one.
 *
 * Null in three honest cases, all of which must stay distinguishable from "site
 * with no failures":
 *   - the device carries no `group_id` (16 of 250 on this tenant);
 *   - the group_id is not in the group list we read (unresolvable, 0 today);
 *   - the group IS the root, so there is no site level beneath the tenant.
 */
export function resolveSite(index: GroupIndex, groupId: string | null | undefined): SiteRef | null {
  if (!groupId) return null;
  const chain = ancestorChain(index, groupId);
  // chain = [self, parent, …, root]; depth-1 is the second-from-last entry.
  if (chain.length < 2) return null;
  const site = chain[chain.length - 2]!;
  return { uuid: site.uuid, name: site.name };
}

/** How much of the fleet the site dimension actually covers. Honest denominators. */
export interface SiteCoverage {
  devices: number;
  /** Devices we resolved to a depth-1 site. */
  resolved: number;
  /** Devices carrying no group_id at all — nothing to resolve. */
  withoutGroupId: number;
  /** Devices whose group_id is not in the group list, or sits at the root. */
  unresolved: number;
  /** Distinct site buckets found. */
  sites: number;
}

/**
 * Pure: attach the resolved site to each device.
 *
 * Returns new objects — the caller's array is untouched, so a cached DeviceView
 * list can be enriched per request without accumulating state.
 */
export function withSites(
  devices: readonly DeviceView[],
  index: GroupIndex,
): { devices: DeviceView[]; coverage: SiteCoverage } {
  const seenSites = new Set<string>();
  let resolved = 0;
  let withoutGroupId = 0;
  let unresolved = 0;

  const enriched = devices.map((device) => {
    const site = resolveSite(index, device.groupId);
    if (site) {
      resolved += 1;
      seenSites.add(site.uuid);
    } else if (!device.groupId) {
      withoutGroupId += 1;
    } else {
      unresolved += 1;
    }
    return { ...device, site };
  });

  return {
    devices: enriched,
    coverage: {
      devices: devices.length,
      resolved,
      withoutGroupId,
      unresolved,
      sites: seenSites.size,
    },
  };
}

// ── the one IO-touching part ─────────────────────────────────────────────────

/**
 * TTL cache over the group tree.
 *
 * Reading the hierarchy costs one `rpm /v1/groups` walk (one call at today's 94
 * groups), and `GET /api/correlation` is a dashboard poll — refetching per request
 * would be 94 groups' worth of control-plane traffic for a tree that changes when
 * someone provisions a group. So: in-memory, TTL'd, and NOT persisted. Chosen over
 * a DB table because the mapping is derived data with a single consumer, and a
 * stale table would need its own freshness plumbing; the cache carries `ageSeconds`
 * instead so the endpoint can say how old the mapping is.
 *
 * A failed fetch is not cached — `index` comes back null and the caller falls back
 * to the honest city note rather than reasoning over a tree it could not read.
 */
const SITE_CACHE_TTL_MS = 30 * 60 * 1000;

export class GroupSiteCache {
  #cache: { index: GroupIndex; loadedAt: number } | null = null;

  constructor(
    private readonly http: VideriHttp,
    private readonly ttlMs: number = SITE_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The group index, from cache when fresh.
   *
   * `index: null` means we could not read the tree (no control plane, or the call
   * failed) — never an empty index, which would silently look like "a tenant with
   * no groups" and resolve every device to no site.
   */
  async get(): Promise<{
    index: GroupIndex | null;
    ageSeconds: number | null;
    groupsRead: number;
    groupsTotal: number | null;
    truncated: boolean;
    reason: string | null;
  }> {
    const now = this.now();
    if (this.#cache && now - this.#cache.loadedAt <= this.ttlMs) {
      return {
        index: this.#cache.index,
        ageSeconds: Math.round((now - this.#cache.loadedAt) / 1000),
        groupsRead: this.#cache.index.size,
        groupsTotal: null,
        truncated: false,
        reason: null,
      };
    }

    try {
      const listing = await new AggregatorService(this.http).listGroupsPaged();
      const index = buildGroupIndex(listing.groups);
      this.#cache = { index, loadedAt: now };
      return {
        index,
        ageSeconds: 0,
        groupsRead: listing.groups.length,
        groupsTotal: listing.groupsTotal,
        truncated: listing.truncated,
        reason: listing.truncated
          ? `Group list was truncated at ${listing.groups.length} of ` +
            `${listing.groupsTotal ?? "unknown"} groups, so some devices may not resolve to a site.`
          : null,
      };
    } catch (error) {
      return {
        index: null,
        ageSeconds: null,
        groupsRead: 0,
        groupsTotal: null,
        truncated: false,
        reason: `Group hierarchy could not be read (${(error as Error).message}).`,
      };
    }
  }
}
