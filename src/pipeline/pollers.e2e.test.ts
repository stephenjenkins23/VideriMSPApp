/**
 * Poller end-to-end tests — `node --test dist/pipeline/pollers.e2e.test.js`
 *
 * Drives the real pollers against a stubbed Videri API and a stubbed database,
 * so the whole chain is exercised: pagination → adapter → key discovery →
 * repository writes → failure isolation → run accounting.
 *
 * Typechecking proves the pieces fit. This proves they actually work together,
 * which is the part that would otherwise stay unverified until a credential
 * arrives.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { VideriHttp } from "../videri/http.js";
import { CanvasService } from "../videri/services/canvas.js";
import { Repository } from "../db/repository.js";
import { pollDevices } from "./pollers/devices.js";
import { pollStatus } from "./pollers/status.js";
import { pollMetrics } from "./pollers/metrics.js";

const DEVICE_COUNT = 250;
/** Every 25th device has no XMPP JID, so it cannot be polled for status. */
const UNPOLLABLE = Math.ceil(DEVICE_COUNT / 25);

function fakeCanvases() {
  return Array.from({ length: DEVICE_COUNT }, (_, i) => ({
    id: `canvas-${i}`,
    device_id: `dev-${i}`,
    xmpp_jid: i % 25 === 0 ? null : `dev-${i}@canvas.videri.internal`,
    name: `Screen ${i}`,
    product_name: i % 3 === 0 ? "TCL 55 Enterprise" : "Videri Canvas V4",
    location: "New York, NY",
    geo: { coordinates: { latitude: 40.75, longitude: -73.98 } },
    core_services_versions: { current: i % 4 === 0 ? "3.3.8" : "3.4.1", latest: "3.4.1" },
    tags: [] as string[],
  }));
}

interface Stubs {
  http: VideriHttp;
  pool: Pool;
  repo: Repository;
  canvas: CanvasService;
  store: {
    devices: Set<string>;
    health: Array<{ deviceId: string; source: string; ram: unknown; temp: unknown; wifi: unknown }>;
    keys: Map<string, unknown>;
    raw: unknown[];
  };
  calls: { status: number; metrics: number };
}

function makeStubs({ failEveryThirdMetricsBatch = false } = {}): Stubs {
  const canvases = fakeCanvases();
  const calls = { status: 0, metrics: 0 };
  const store: Stubs["store"] = {
    devices: new Set(),
    health: [],
    keys: new Map(),
    raw: [],
  };

  const http = {
    async request(_service: string, path: string, opts: { body?: unknown } = {}) {
      // The two batch endpoints take DIFFERENT body shapes on the live API:
      //   status/fetch_all  → { players: [{ device_id, device_jid }] }
      //   metrics/fetch_all → [ "deviceId", ... ]   (bare array of strings)
      // Modelled faithfully here — assuming they matched was a real bug that
      // silently returned 400 for every metrics batch in production.
      if (path === "/status/fetch_all") {
        calls.status += 1;
        const players = (opts.body as { players?: Array<{ device_id: string }> })?.players ?? [];
        if (players.length === 0) throw new Error("status/fetch_all requires a players envelope");
        return players.map((p) => ({
          device_id: p.device_id, presence: "online",
          is_screen_on: "true", is_black_screen: "false", showing_logo: "false",
          ping_quality: "no", playback_quality: "unavailable",
        }));
      }
      if (path === "/metrics/fetch_all") {
        calls.metrics += 1;
        const ids = opts.body;
        if (!Array.isArray(ids)) {
          throw new Error("metrics/fetch_all requires a bare array of device ids");
        }
        if (failEveryThirdMetricsBatch && calls.metrics % 3 === 0) {
          throw new Error("simulated 503 from gateway");
        }
        return (ids as string[]).map((id) => ({
          device_id: id, presence: "online", timestamp: "2026-08-25T10:00:00Z",
          status: { network: { rssi: 58 } },
          super_props: {
            system: { mem_usage: 64.5 }, thermal: { soc_temp: 52_000 },
            time: { ntp_sync_rate: 96 }, build: { channel: "stable" },
          },
        }));
      }
      throw new Error(`unexpected path ${path}`);
    },
    async *springPages(
      _service: string,
      _path: string,
      { size = 200, query }: { size?: number; query?: Record<string, unknown> } = {},
    ) {
      // The real endpoint splits the fleet: assigned_to_group=true and =false
      // return disjoint sets and neither is "all". Model that here so the
      // both-sweeps behaviour is genuinely exercised.
      if (query?.["assigned_to_group"] === false) return;
      for (let i = 0; i < canvases.length; i += size) yield canvases.slice(i, i + size);
    },
  } as unknown as VideriHttp;

  /**
   * Parse the column list straight out of the INSERT statement.
   *
   * Hard-coding a column count made these tests break every time the schema
   * grew a field — and worse, break with a confusing fractional row count rather
   * than a clear message. Reading the real column names also lets assertions
   * address fields by name instead of by brittle offset.
   */
  const parseColumns = (sql: string): string[] => {
    const match = /INSERT INTO \w+ \(([^)]+)\)/.exec(sql);
    if (!match?.[1]) throw new Error(`could not parse columns from: ${sql.slice(0, 80)}`);
    return match[1].split(",").map((c) => c.trim());
  };

  const rowsFrom = (sql: string, values: unknown[]): Array<Record<string, unknown>> => {
    const cols = parseColumns(sql);
    const out: Array<Record<string, unknown>> = [];
    for (let r = 0; r < values.length / cols.length; r++) {
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = values[r * cols.length + i]; });
      out.push(row);
    }
    return out;
  };

  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith("INSERT INTO devices")) {
        const rows = rowsFrom(sql, values);
        for (const row of rows) store.devices.add(String(row["id"]));
        return { rows: [], rowCount: rows.length };
      }
      if (sql.startsWith("INSERT INTO health_samples")) {
        const rows = rowsFrom(sql, values);
        for (const row of rows) {
          store.health.push({
            deviceId: String(row["device_id"]),
            source: String(row["source"]),
            ram: row["ram_percent"],
            temp: row["temperature_c"],
            wifi: row["wifi_signal_dbm"],
          });
        }
        return { rows: [], rowCount: rows.length };
      }
      if (sql.startsWith("INSERT INTO discovered_keys")) {
        store.keys.set(`${values[0]}.${values[1]}`, values[2]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO raw_payloads")) {
        store.raw.push(...values);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM devices") && sql.includes("device_id IS NOT NULL")) {
        return {
          rows: canvases.map((c) => ({ id: c.id, device_id: c.device_id, device_jid: c.xmpp_jid })),
          rowCount: canvases.length,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;

  return { http, pool, repo: new Repository(pool), canvas: new CanvasService(http), store, calls };
}

test("device discovery paginates and upserts the whole fleet", async () => {
  const { canvas, repo, store } = makeStubs();
  const result = await pollDevices(canvas, repo);

  assert.equal(result.devicesTargeted, DEVICE_COUNT);
  assert.equal(result.rowsWritten, DEVICE_COUNT);
  assert.equal(store.devices.size, DEVICE_COUNT);
  assert.equal(result.batchesFailed, 0);
  // 250 devices at page size 200 is two pages.
  assert.equal(result.batchesOk, 2);
});

test("status poll batches the fleet and skips devices with no JID", async () => {
  const { canvas, repo, store, calls } = makeStubs();
  const targets = await repo.listPollTargets();
  const result = await pollStatus(canvas, repo, targets, { batchSize: 100 });

  assert.equal(result.devicesTargeted, DEVICE_COUNT - UNPOLLABLE);
  assert.equal(result.rowsWritten, DEVICE_COUNT - UNPOLLABLE);
  assert.ok(result.errors.some((e) => e.includes("no xmpp_jid")));

  // The batch endpoint is the whole reason this is viable: 240 devices in 3
  // calls, not 240. A regression here would be a 100x cost increase.
  assert.equal(calls.status, 3);

  const statusRows = store.health.filter((h) => h.source === "status");
  assert.equal(statusRows.length, DEVICE_COUNT - UNPOLLABLE);
  // Status rows must carry no hardware telemetry — that is why `source` exists.
  assert.ok(statusRows.every((r) => r.ram === null && r.temp === null));
});

test("metrics poll resolves telemetry, records vocabulary, and isolates failures", async () => {
  const { canvas, repo, store } = makeStubs({ failEveryThirdMetricsBatch: true });
  const targets = await repo.listPollTargets();
  const result = await pollMetrics(canvas, repo, targets, { batchSize: 100, rawSampleRate: 1 });

  // 3 batches, the third fails — the other two must still land.
  assert.equal(result.batchesOk, 2);
  assert.equal(result.batchesFailed, 1);
  assert.equal(result.rowsWritten, 200);
  assert.ok(result.errors.some((e) => e.includes("simulated 503")));

  const metricRows = store.health.filter((h) => h.source === "metrics");
  assert.equal(metricRows.length, 200);
  // Unit coercion end-to-end: milli-°C → °C, positive RSSI → negative dBm.
  assert.ok(metricRows.every((r) => r.ram === 64.5 && r.temp === 52 && r.wifi === -58));

  assert.equal(result.telemetryYield, 1);

  // The discovery mechanism must capture keys we do NOT map, since those are
  // exactly the ones that tell us what the undocumented payload really contains.
  assert.equal(store.keys.size, 5);
  assert.ok(store.keys.has("super_props.build.channel"));
  assert.ok(store.raw.length > 0, "raw payloads retained for reprocessing");
});

test("telemetry yield of zero is reported as an explicit error", async () => {
  const { repo, http } = makeStubs();
  // A payload with containers present but no recognisable metric keys — the
  // shape we would see if Videri renamed everything.
  const blindHttp = {
    ...http,
    async request(_s: string, path: string, opts: { body?: unknown } = {}) {
      if (path !== "/metrics/fetch_all") throw new Error("unexpected");
      const ids = Array.isArray(opts.body) ? (opts.body as string[]) : [];
      return ids.map((id) => ({
        device_id: id,
        status: {},
        // Containers present but no recognisable metric key — the real shape.
        super_props: { totally: { unrecognised: 1 } },
      }));
    },
  } as unknown as VideriHttp;

  const result = await pollMetrics(
    new CanvasService(blindHttp),
    repo,
    (await repo.listPollTargets()).slice(0, 10),
    { batchSize: 10 },
  );

  assert.equal(result.telemetryYield, 0);
  assert.ok(
    result.errors.some((e) => e.includes("Telemetry yield is 0%")),
    "a zero yield is the signal that the payload changed — it must be loud",
  );
});

test("a poll with no targets is a no-op, not an error", async () => {
  const { canvas, repo } = makeStubs();
  const status = await pollStatus(canvas, repo, [], { batchSize: 100 });
  const metrics = await pollMetrics(canvas, repo, [], { batchSize: 100 });

  assert.equal(status.rowsWritten, 0);
  assert.equal(status.batchesFailed, 0);
  assert.equal(metrics.rowsWritten, 0);
  assert.equal(metrics.batchesFailed, 0);
});
