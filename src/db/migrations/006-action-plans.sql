-- Generated AI action plans (US-5.2).
--
-- A separate table from `briefs` rather than a row-type inside it: the two have
-- different payloads (a plan stores the structured intelligence it was built
-- from, not a fleet bundle), and `latestBrief` serves "the most recent row" —
-- mixing a second row-type into that table would make the brief endpoint start
-- returning plans. Two tables, two "latest" queries, no shared failure mode.
--
-- Like the brief, the read API serves the most recent plan rather than
-- generating one per request: generation costs a model call and takes seconds,
-- and every viewer should be working the same plan anyway.
CREATE TABLE IF NOT EXISTS action_plans (
  id            bigserial   PRIMARY KEY,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  window_hours  integer     NOT NULL,
  plan          jsonb       NOT NULL,
  /* Snapshot of the structured intelligence the plan was generated from, so any
     claim in an item can be traced back to what was true at the time. */
  input         jsonb,
  model         text,
  input_tokens  integer,
  output_tokens integer
);

CREATE INDEX IF NOT EXISTS action_plans_generated_idx ON action_plans (generated_at DESC);
