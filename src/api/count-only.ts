/**
 * `limit=0` — a total without the rows.
 *
 * WHY THIS EXISTS. The console pages collections 200 rows at a time and stops at
 * 2,000. It discloses that truncation honestly now (a red banner, `2000+`
 * badges), but the CAUSE was never the cap: it was that a nav badge needs a
 * TOTAL and the only way to get one was to walk every page. At ~1.25 alerts per
 * device the alerts collection hits 2,000 at roughly 1,600 devices — a wall well
 * inside the "thousands of screens" target — and every badge refresh paid ten
 * round trips to learn one integer.
 *
 * WHY `limit=0` AND NOT A DEDICATED `/count` ENDPOINT. The requirement that
 * actually bites is "the count must honour the same filters as the list it
 * counts" — and the codebase has already been burned by exactly this: the alerts
 * COUNT query selects from `alerts` alone with NO devices join, so a predicate
 * written against a `d.` alias compiles in the list query and raises
 * `missing FROM-clause entry` in the count. That shape 500'd a live endpoint
 * while stub tests passed (see the NOT EXISTS note in queries.alerts).
 *
 * A separate endpoint means a SECOND filter parser and a SECOND WHERE builder,
 * which is a second chance to diverge — and divergence here is silent, because a
 * wrong count looks exactly like a right one. `limit=0` reuses the list's own
 * Zod schema, its own site resolution, its own `queries.*` call and its own
 * COUNT statement, then throws the rows away. The count cannot disagree with the
 * list because it IS the list's count, computed from the same params.
 *
 * WHY IT IS GENUINELY CHEAP. Both `queries.devices()` and `queries.alerts()`
 * already issue their COUNT and their page in parallel, so `limit=0` costs one
 * `COUNT(*)` plus one row query that Postgres answers without touching its
 * child: a `Limit` node with a zero count returns end-of-scan immediately, so
 * there is no sort, no lateral fan-out and no heap access for the page half. It
 * is a count, not a walk.
 *
 * Adopting it on another collection is two lines: `.min(0)` on the limit, and
 * `countOnlyPage()` instead of the hand-rolled page block.
 */

/** The sentinel. A caller asking for zero rows is asking for the total. */
export const COUNT_ONLY_LIMIT = 0;

export const isCountOnly = (limit: number): boolean => limit === COUNT_ONLY_LIMIT;

export interface PageMeta {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
}

/**
 * The `meta.page` block, for both modes.
 *
 * `totalPages: 0` for a count-only request is the literal truth — at a page size
 * of zero there are no pages to fetch — and it keeps the field a number rather
 * than the `Infinity` that `ceil(n/0)` serialises to as `null`. `meta.countOnly`
 * (below) is what tells a client which mode it got, so nothing has to infer it
 * from a zero.
 */
export function pageMeta(page: number, limit: number, totalItems: number): PageMeta {
  return isCountOnly(limit)
    ? { page: 1, limit, totalItems, totalPages: 0 }
    : { page, limit, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / limit)) };
}

/**
 * The disclosure block. A response with no rows in it must say whether that is
 * "nothing matched" or "you asked for the count only" — those are different
 * facts and a bare empty array conflates them.
 */
export function countOnlyMeta(limit: number): { countOnly: true; note: string } | null {
  if (!isCountOnly(limit)) return null;
  return {
    countOnly: true,
    note:
      "limit=0: this response carries no rows by request. meta.page.totalItems is the " +
      "COUNT over exactly the filters you sent, computed by the same statement that " +
      "totals the list — re-issue with a limit to page the rows themselves.",
  };
}
