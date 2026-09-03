-- 010 — the technician's work surface (Epic 8.2, GAP-2 + GAP-3, both P0)
--
-- WHAT WAS MISSING
-- VFI decided a great deal about what is by design — dormancy bands, schedule
-- windows, blank-cause classification — and gave the operator nowhere to record
-- a single conclusion of their own. Measured on the live fleet:
--
--   * `POST /api/alerts/:id/acknowledge` existed and the console never called
--     it. Two technicians could not share a 110-item queue without colliding,
--     and there was no record that anyone had even looked at an alert.
--   * 42 of 250 active devices carry their purpose in their own NAME
--     (`SparkBridge (EoL)`, `SparkQ [RMA]`, `Lab TCL`, `Not Product`,
--     `Travel Case Unit`, `stephen.jenkins@videri.com-6`). 39 of them hold
--     22% of the open alerts. Every shift re-triaged them from scratch.
--
-- This migration adds the two tables that fix that, and nothing else. Both are
-- additive; no existing column or index changes. `alerts.acknowledged_at` /
-- `acknowledged_by` already existed and are reused as-is.
--
-- ── alert_suppressions ──────────────────────────────────────────────────────
-- "This is meant to be like this, stop telling me" — durable, attributable,
-- reversible, and never destructive. The alert stays OPEN; what changes is which
-- BAND it is counted in. This is the dormant band's pattern (src/alerting/
-- hygiene.ts), which the MSP QA pass rates as the thing in this product that
-- works: moved out of the queue, never deleted, count always visible, criticals
-- never absorbed.
--
-- Four properties are enforced HERE rather than in the application, because a
-- constraint in TypeScript is a convention and a constraint in Postgres is a
-- guarantee — and the whole value of this table is that a row in it can be
-- trusted six weeks later by someone who did not write it.
CREATE TABLE IF NOT EXISTS alert_suppressions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  /* SCOPE. Both scopes exist because both statements get made:
       rule_id IS NULL  — the WHOLE DEVICE. Blunt, and exactly right for the
                          case that dominates the data: "this unit lives in the
                          lab" is a statement about the ASSET, and making a tech
                          mute five rules on it guarantees an incomplete mute
                          that re-fires the day a sixth rule opens.
       rule_id SET      — that rule on that device only. The only safe scope for
                          a live production device: "the brightness drift on the
                          lobby screen is deliberate" must not also silence that
                          screen going offline.
     On match the NARROWER record wins, so the operator reads the most specific
     reason that was recorded rather than the broadest. */
  device_id       text        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  rule_id         text,

  /* REASON — mandatory, with a floor. A suppression with no reason is
     indistinguishable from a bug six weeks later, and the person who has to tell
     them apart is not the person who created it. The floor is low enough not to
     be a form to fight and high enough to stop "." and "x". Kept as a CHECK
     because the API is not the only thing that will ever write here. */
  reason          text        NOT NULL,
  CONSTRAINT alert_suppressions_reason_check
    CHECK (char_length(btrim(reason)) >= 8),

  /* The operator's recorded purpose for the ASSET, when they gave one. NULL is a
     plain snooze ("expected this week") with no claim about purpose.
     'none' is the load-bearing value: it is how an operator says "the NAME is
     lying, this is production", which is what makes the name-derived intent
     heuristic (src/intelligence/device-intent.ts) overridable. A recorded intent
     ALWAYS outranks an inferred one, and 'none' suppresses nothing — it only
     silences the heuristic. Closed vocabulary, CHECKed, for the same reason
     device_action_log.outcome is: a free-text facet means "show me every EoL
     device" silently misses the rows whose spelling drifted. */
  intent          text,
  CONSTRAINT alert_suppressions_intent_check CHECK (intent IS NULL OR intent IN (
    'eol', 'not-product', 'repair', 'prototype', 'lab', 'test', 'demo-unit',
    'internal-account', 'none'
  )),

  /* CRITICAL AND HIGH, and the reason this is a CHECK and not a policy.
     A WHOLE-DEVICE suppression may never absorb a critical or high alert — not
     by default, not with a flag. If a rule fires CRITICAL on a device we believe
     is a lab spare, that is news: the device spoke. Burying it is the exact
     failure this table exists to prevent, and it mirrors NEVER_ABSORBED in
     src/alerting/hygiene.ts.
     A RULE-SCOPED suppression may absorb them, and only when this flag is set
     explicitly on that record. Admissible because naming the rule names the
     alert class: the operator has said "the offline-30d critical on THIS device
     is expected", which is a specific claim about a specific known alert rather
     than a blanket. Every such record is named in the surface's own notes. */
  include_critical_high boolean NOT NULL DEFAULT false,
  CONSTRAINT alert_suppressions_no_blanket_critical
    CHECK (include_critical_high = false OR rule_id IS NOT NULL),

  /* ATTRIBUTION. No user model exists yet (auth is a single shared bearer token,
     src/api/auth.ts), so this is the same honest plain string the audit log
     uses — 'api:<X-VFI-Actor>' / 'api:token' / 'api:anonymous' — rather than a
     fabricated user id. When real identity arrives the resolver changes and this
     column does not. */
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  /* EXPIRY — finite by default, infinite only when asked for in as many words.
     "Muted forever" is how monitoring systems rot, so the API defaults to 30
     days (the same horizon as the offline-30d dormancy rule, so a suppression
     that has outlived its reason resurfaces on the cadence the estate is already
     reviewed on) and caps a finite expiry at 365 days — a five-year expiry is
     "forever" wearing a disguise.
     A genuinely retired asset does need a permanent record, so expires_at NULL
     is legal, but ONLY together with never_expires = true. The CHECK makes that
     choice deliberate and auditable: an unset expiry can no longer be mistaken
     for a considered one, which is the failure mode of every mute-forever
     feature ever shipped. */
  expires_at      timestamptz,
  never_expires   boolean     NOT NULL DEFAULT false,
  CONSTRAINT alert_suppressions_expiry_explicit CHECK (
    (never_expires AND expires_at IS NULL) OR (NOT never_expires AND expires_at IS NOT NULL)
  ),

  /* REVERSIBILITY. Un-suppression is an UPDATE of these three columns and NEVER
     a DELETE: "who un-muted the EoL device the week it caught fire, and why"
     must have an answer. A revoked row stays queryable forever and is reported
     in the surface's `lapsed` block alongside the alerts that came back. */
  revoked_at      timestamptz,
  revoked_by      text,
  revoked_reason  text,
  CONSTRAINT alert_suppressions_revocation_attributed
    CHECK (revoked_at IS NULL OR revoked_by IS NOT NULL)
);

-- At most ONE suppression in force per scope, so "mute it again" updates the
-- operator's intent instead of stacking five records whose reasons disagree.
-- Partial on `revoked_at IS NULL` because the history must stay: a revoked
-- record for the same scope is not a conflict, it is the previous decision.
-- Two indexes rather than one because Postgres treats NULL as distinct in a
-- unique index, so `(device_id, rule_id)` would happily accept ten whole-device
-- suppressions — the exact stacking this is meant to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS alert_suppressions_device_scope_unique
  ON alert_suppressions (device_id) WHERE revoked_at IS NULL AND rule_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS alert_suppressions_rule_scope_unique
  ON alert_suppressions (device_id, rule_id) WHERE revoked_at IS NULL AND rule_id IS NOT NULL;

-- "What is in force right now", which is on the hot path of every alert read.
CREATE INDEX IF NOT EXISTS alert_suppressions_active_idx
  ON alert_suppressions (device_id, rule_id) WHERE revoked_at IS NULL;
-- "What lapses next", for the expiry sweep and the console's countdown.
CREATE INDEX IF NOT EXISTS alert_suppressions_expiry_idx
  ON alert_suppressions (expires_at) WHERE revoked_at IS NULL AND expires_at IS NOT NULL;

-- ── alert_events ────────────────────────────────────────────────────────────
-- The alert's own lifecycle log: claimed, released, annotated, suppressed.
--
-- APPEND-ONLY, and that is the whole point. An editable note destroys the audit
-- value of the thing it is recording — the next shift needs to know what the
-- last shift ACTUALLY wrote, not the tidied version. There is no UPDATE and no
-- DELETE path to this table anywhere in the application.
--
-- One table rather than a notes table plus an assignment table plus an
-- acknowledgement table, because the console needs them interleaved: "claimed by
-- X 12 minutes ago, then noted Y, then released" is one ordered read, and three
-- tables would need a merge in the client to produce it.
--
-- NO FOREIGN KEY to alerts, for the same reason device_action_log has none to
-- devices: the record of what a human concluded must outlive its subject. Alerts
-- are cascade-deleted with their device, and losing a technician's notes as a
-- side effect of a device disappearing upstream is the one deletion path this
-- table must not have.
CREATE TABLE IF NOT EXISTS alert_events (
  id          bigserial   PRIMARY KEY,
  alert_id    uuid        NOT NULL,
  /* Denormalised so the log survives its alert and can still be grouped by
     device. Also lets "everything a tech concluded about this screen" answer
     without joining a row that may be gone. */
  device_id   text        NOT NULL,

  /* Closed vocabulary, CHECKed. Same argument as device_action_log.outcome: this
     column is a filter, and a drifted spelling means a quietly incomplete
     answer, which is worse than a loud insert error.
       acknowledge   — a human claimed it (also sets alerts.acknowledged_*)
       unacknowledge — a human RELEASED it. A tech who claims the wrong alert
                       must be able to hand it back, and the release must be as
                       visible as the claim.
       note          — free text, the only kind with a required body
       suppress      — a suppression was created covering this alert
       unsuppress    — that suppression was revoked */
  kind        text        NOT NULL,
  CONSTRAINT alert_events_kind_check CHECK (kind IN (
    'acknowledge', 'unacknowledge', 'note', 'suppress', 'unsuppress'
  )),

  /* Prose, for a human. Required and non-trivial on a note (a blank note is not
     a note); optional on the lifecycle kinds, where it carries the release
     reason or the suppression reason. */
  body        text,
  CONSTRAINT alert_events_note_has_body
    CHECK (kind <> 'note' OR char_length(btrim(coalesce(body, ''))) >= 1),

  /* The suppression this event refers to, on 'suppress'/'unsuppress'. No FK:
     see above — the event outlives everything. */
  suppression_id uuid,

  actor       text        NOT NULL,
  actor_ip    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- "The whole story of this alert", oldest-first — the only order a lifecycle
-- reads in, and the opposite of the audit log's newest-first.
CREATE INDEX IF NOT EXISTS alert_events_alert_idx
  ON alert_events (alert_id, created_at, id);
-- "Everything a tech concluded about this screen", across alerts.
CREATE INDEX IF NOT EXISTS alert_events_device_idx
  ON alert_events (device_id, created_at DESC);
-- "What has this shift done", for the handover.
CREATE INDEX IF NOT EXISTS alert_events_actor_idx
  ON alert_events (actor, created_at DESC);
