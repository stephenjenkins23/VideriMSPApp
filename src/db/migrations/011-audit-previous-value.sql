-- 011 — the audit log gets a first-class "value before the write"
--
-- WHAT WAS MISSING
-- `device_action_log` recorded `requested_value` and `observed_value` but never
-- the value the panel was at BEFORE we touched it, so the one sentence an audit
-- row exists to produce — "it went from 39% to 70%, at 10:04, because Stephen
-- asked" — could not be assembled from the row. The from→to pair existed for
-- exactly one action type, by accident: `detail.originalRaw` on a brightness
-- write, on the device's raw 0-255 scale, while `requested_value` next to it is
-- a PERCENTAGE. So the audit view either showed nothing or showed 100 → 70%,
-- which is worse than nothing.
--
-- WHAT THIS ADDS
-- One nullable text column, in the SAME normalised unit as `requested_value`
-- ('39%' against '70%', never 100 against '70%'). Text for the same reason
-- `requested_value` is text: one column serves a brightness percent, a mode
-- string and a future setting alike.
--
-- NULL IS NOT ZERO AND NOT "NO CHANGE". A null here means we do not know what
-- the panel was at, and the reason is in `detail.previousValueBasis`
-- (`preflight_read` | `preflight_unreadable` | `not_read` | `not_attempted`),
-- written by the same call site that writes this column. /api/audit turns the
-- pair into "unknown, and here is why" — never a 0 (which on the brightness
-- scale is a display-off panel) and never a dash, which a reader would take for
-- "unchanged".
--
-- NO BACKFILL, DELIBERATELY. Existing rows keep a NULL and NO basis, and that
-- combination is what the reader renders as "this row predates the column".
-- A backfilled previous value would be a guess, and a guess in an audit table is
-- invented history — the one thing this table may not contain. (Today that is
-- moot: the log holds 0 rows, because the write path is wired and no device
-- write has ever been fired at this database. It will not stay moot.)
--
-- NO INDEX. This column is READ with its row and never filtered on — from→to is
-- a rendering of a row you already selected by device, actor, window or outcome,
-- each of which has its own index (009). An index here would cost every insert
-- on the write path and serve no query.
--
-- Additive and idempotent: safe to re-run, and a deploy that has not yet
-- restarted the app keeps working because every writer treats it as optional.
ALTER TABLE device_action_log ADD COLUMN IF NOT EXISTS previous_value text;

COMMENT ON COLUMN device_action_log.previous_value IS
  'The value this device was at BEFORE the action, normalised to the same unit as '
  'requested_value (e.g. ''39%''). NULL = unknown, never 0 and never "unchanged"; '
  'detail.previousValueBasis says why it is unknown. Never backfilled.';
