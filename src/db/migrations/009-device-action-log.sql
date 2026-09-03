-- 009 — device action log (the audit trail of what WE did)
--
-- The schema had 21 tables and not one of them recorded our own writes. We fire
-- real device commands — a brightness write with a preflight → verify → rollback
-- cycle, an on-demand screenshot capture — and the only trace was a transient
-- banner in the console drawer, gone on the next render. "What did we change on
-- this screen last week, and who asked for it?" was unanswerable.
--
-- For an MSP acting on a customer's estate that is a trust and dispute problem,
-- not a missing nicety, and it is deliberately built BEFORE the bulk-write work
-- so the write surface never grows unlogged.
--
-- WHAT A ROW IS: one attempted action on one device. Append-only. It is written
-- whatever the outcome — a rollback and a refusal are exactly the events an
-- audit needs, so a write that never touched the panel still lands here with the
-- reason. Nothing in this table is ever UPDATEd.
--
-- NO FOREIGN KEY to devices, unlike every other per-device table here. Two
-- reasons, both deliberate:
--   1. an audit row must outlive its subject. `ON DELETE CASCADE` would make the
--      record of what we did to a device deletable as a side effect of removing
--      the device — the one deletion path an audit trail must not have. (Devices
--      are soft-deleted today, so the cascade would rarely fire; "rarely" is not
--      the standard for this table.)
--   2. we must be able to log an action against an id we cannot resolve. A write
--      refused *because* the device was unknown is itself an auditable event.
CREATE TABLE IF NOT EXISTS device_action_log (
  id             bigserial   PRIMARY KEY,

  /* WHAT was attempted, at two levels of detail:
     `action` is the operation in our vocabulary ('brightness_write',
     'device_command', 'screenshot_capture') and is what a human filters on;
     `verb` is what actually went on the wire ('set_brightness', 'demo_command',
     'get_screenshot'), which is what you need when arguing with the vendor. */
  action         text        NOT NULL,
  verb           text,

  device_id      text        NOT NULL,

  /* The requested value and the value READ BACK afterwards, as text so one
     column serves a brightness percent, a mode string and a future setting
     alike. NULL means "not applicable, or could not be read" — never 0. An
     unreadable read-back is the whole reason the rollback cycle exists, so
     rendering it as a zero would erase the finding. */
  requested_value text,
  observed_value  text,

  /* Exact payload sent, and the structured detail of the cycle (original value,
     internal state name, device response code). Kept whole because the argument
     "we sent X and the device answered Y" needs the literal X and Y. */
  params         jsonb       NOT NULL DEFAULT '{}',
  detail         jsonb       NOT NULL DEFAULT '{}',

  /* The outcome, in a CLOSED vocabulary:
       applied         — the device accepted the write, and we did NOT run the
                         full verify cycle: either read back without a rollback
                         guard (the live slider path) or not read back at all
                         (the generic command endpoint). `observed_value` says
                         which — a NULL there means accepted, unconfirmed.
       verified        — written and confirmed by read-back
       no_change       — already at the requested value; nothing was written
       rolled_back     — did not verify; the original value was restored
       rollback_failed — did not verify AND the restore could not be confirmed.
                         The one outcome a human must be paged about.
       refused        — WE declined to act (no confirmation, unreadable
                         preflight, unaddressable device, command not allowed).
                         The device was never touched.
       failed          — attempted and failed (device rejected it, or transport
                         error).
     The CHECK is here on purpose. This column is a filter on the audit
     endpoint, and a free-text outcome means "everything that failed" silently
     misses rows whose spelling drifted — a quietly incomplete audit answer is
     worse than a loud insert error. Writers go through one tested mapper
     (`auditOutcomeForBrightness` in src/api/routes/audit.ts) so an unmapped
     string cannot originate in the app. */
  outcome        text        NOT NULL,
  CONSTRAINT device_action_log_outcome_check CHECK (outcome IN (
    'applied', 'verified', 'no_change', 'rolled_back', 'rollback_failed',
    'refused', 'failed'
  )),

  /* WHO or WHAT initiated it. There is no user model yet (auth is a single
     shared bearer token — see src/api/auth.ts), so this is deliberately a plain
     string rather than a fabricated user id: 'api:token' / 'api:anonymous' for a
     caller, 'api:<name>' when a caller identifies itself via X-VFI-Actor, and
     'poller:<lane>' for anything we initiate ourselves. When Cognito identity
     arrives the resolver changes and the column does not. */
  actor          text        NOT NULL,
  /* The caller's address, when there was one. The only other identifying fact we
     hold today, and the difference between "someone with the token" and "someone
     with the token, from the office" in a dispute. */
  actor_ip       text,

  started_at     timestamptz NOT NULL,
  finished_at    timestamptz NOT NULL DEFAULT now(),
  duration_ms    integer,

  /* Non-null only when something went wrong. Prose, for a human. */
  error          text
);

-- The four questions this table exists to answer, one index each. Every one is
-- newest-first because that is the only order an audit is ever read in.
--   "everything we did to device X"
CREATE INDEX IF NOT EXISTS device_action_log_device_idx
  ON device_action_log (device_id, started_at DESC);
--   "everything we did in this window"
CREATE INDEX IF NOT EXISTS device_action_log_time_idx
  ON device_action_log (started_at DESC);
--   "everything that failed"
CREATE INDEX IF NOT EXISTS device_action_log_outcome_idx
  ON device_action_log (outcome, started_at DESC);
--   "everything a given actor did"
CREATE INDEX IF NOT EXISTS device_action_log_actor_idx
  ON device_action_log (actor, started_at DESC);
