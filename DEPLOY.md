# Deploying VFI

VFI is two long-running processes over one Postgres database, from one image:

| Process | Entrypoint | What it does |
|---|---|---|
| Read API | `node dist/api/run-server.js` | serves `/api/*` and the console in `public/` |
| Poller daemon | `node dist/pipeline/run-poller.js` | 15 scheduled lanes: device/status/metrics polling, the three slow lanes, alerting, compliance, snapshots, retention |

Both read configuration from the **environment**. Neither needs a `.env` file —
that is a local-development convenience, and the npm scripts' `--env-file=.env`
is why the container entrypoints call `node` directly instead.

## 1. Database

Apply the base schema, then every migration **in order**:

```bash
psql "$DATABASE_URL" -f src/db/schema.sql
for m in src/db/migrations/0*.sql; do psql "$DATABASE_URL" -f "$m"; done
```

Migrations run 002 → 008 (001 is the base `schema.sql`). They are additive; 007
adds `retired_at` (soft device retirement) and 008 adds `device_screen_verdict`.

## 2. Configuration

Copy `.env.example` and fill it in. It documents every variable the code reads.
The four secrets — `VIDERI_PASSWORD`, `VIDERI_API_KEY`, `VFI_API_TOKEN`,
`ANTHROPIC_API_KEY` — belong in your platform's secret store, never in an image
layer or a committed file.

**Required:** `VIDERI_TENANT`, `VIDERI_USERNAME`, `VIDERI_PASSWORD`,
`VIDERI_API_KEY`, `DATABASE_URL`, and `VFI_API_TOKEN` (≥16 chars).

## 3. Auth — fail-closed by design

The API refuses to start on a missing or short `VFI_API_TOKEN`. Verified
behaviour:

| Request | Result |
|---|---|
| no token | `401` |
| wrong token | `401` |
| correct bearer token | `200` |

**Never pass `--allow-anonymous` outside local development** — it disables auth
on the entire read API. The console handles auth itself: it stores the token in
`sessionStorage`, sends `Authorization: Bearer`, and prompts once on a `401`.

## 4. Opt-in lanes — each is a decision, not a default

Each lane issues per-device commands against real screens, so each is gated:

| Flag | Lane | Cadence |
|---|---|---|
| `ENABLE_TELEMETRY_SLOWLANE` | CPU/RAM/storage/RSSI/NTP per device | 15 min, batch 10 |
| `ENABLE_SCHEDULE_SLOWLANE` | publisher schedules → proof of play | 30 min, batch 20 |
| `ENABLE_SCREEN_VERIFY` | verifies black-screen claims against the panel | 15 min, batch 5 |
| `ENABLE_SETTINGS_POLL` | `ops_get_settings` | hourly, online-only |
| `ENABLE_DATA_USAGE_POLL` | daily rx/tx | daily (**on** unless set `false`) |
| `ENABLE_AI_JOBS` | AI brief (daily) + action plan (8h) | **PAID Claude calls** |

`ENABLE_AI_JOBS` is off by default on purpose: every run costs money. It also
needs `ANTHROPIC_API_KEY`. Leaving it off is safe — the artifacts simply go
stale, and both stamp their own age.

## 5. Verify the deploy by OUTPUT, not by "it started"

```bash
# fleet totals (expect your real device count, not 0)
curl -sH "Authorization: Bearer $VFI_API_TOKEN" $BASE/api/fleet/summary
# freshness — says how old each lane's data is and names any stalled lane
curl -sH "Authorization: Bearer $VFI_API_TOKEN" $BASE/api/freshness
```

A process that is up but polling nothing looks identical to a healthy one from
the outside. `/api/freshness` is the surface that tells them apart. Check the
poller's own log for `[scheduler] started N task(s)` and confirm the lanes you
enabled appear — a flag typo produces a silent skip, not an error.

## 6. Known gotchas, each of which has cost someone time

- **`VFI_API_HOST` defaults to `127.0.0.1`.** Inside a container that is
  unreachable from outside it. The image sets `0.0.0.0`; if you run the binary
  directly, set it yourself.
- **`public/` must ship with `dist/`.** Omit it and you get a working API that
  404s the dashboard.
- **Restart the daemon after deploying.** A running poller keeps executing the
  code already in memory — ours once ran three-day-old code for days.
- **`fleet_snapshots` is never pruned.** `pruneTimeSeries` covers samples (90d)
  and `poller_runs` (14d) but not snapshots, so that table grows without bound.
  Watch it, or add a retention bound before it matters.
- **Time zones are per device.** Schedule windows are evaluated in each device's
  own zone; the host's zone does not affect correctness but does affect logs.

## 7. Not covered here

Hosting choice, TLS termination, secret-store wiring, backups, and log shipping
are all site-specific and deliberately left out. Nothing above has been
`docker build`-tested — the build sequence (`npm ci` → `tsc` → the two
entrypoints, running with configuration from the environment and auth enforced)
is verified locally, but the container layers themselves are not.
