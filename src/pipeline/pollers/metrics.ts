/**
 * Metrics poller — the one that matters most, and the one most likely to break.
 *
 * `POST /metrics/fetch_all` is where the untyped `super_props` / `status` payload
 * arrives. Three things happen here that happen nowhere else:
 *
 *   1. Every unseen telemetry key is recorded to `discovered_keys`. Run this for
 *      a day and that table becomes the schema documentation the API does not
 *      ship.
 *   2. Raw payloads are retained, so if a mapping in adapter.ts turns out to be
 *      wrong we reprocess history instead of losing it.
 *   3. We compute a **telemetry yield** — the share of devices where at least one
 *      inferred metric resolved. Yield trending toward zero is the signal that
 *      Videri changed the payload under us, and it is the number to alert on.
 */

import type { CanvasService } from "../../videri/services/canvas.js";
import type { Repository, PollTarget } from "../../db/repository.js";
import type { HealthSample } from "../../domain/types.js";
import type { DiscoveredKey } from "../../videri/adapter.js";
import { chunk, mapSettled } from "../batching.js";
import { type PollerResult, emptyResult } from "./types.js";

export interface MetricsPollOptions {
  batchSize?: number;
  concurrency?: number;
  /** Store the untransformed payload for this share of devices, 0–1. */
  rawSampleRate?: number;
  log?: (message: string) => void;
}

/** True when at least one undocumented metric resolved for this sample. */
function hasInferredValue(sample: HealthSample): boolean {
  return Object.values(sample).some(
    (v) =>
      v &&
      typeof v === "object" &&
      "provenance" in v &&
      (v as { provenance: { kind: string } }).provenance.kind === "inferred" &&
      (v as { value: unknown }).value !== null,
  );
}

export async function pollMetrics(
  canvas: CanvasService,
  repo: Repository,
  targets: PollTarget[],
  {
    batchSize = 100,
    concurrency = 4,
    rawSampleRate = 0.02,
    log = () => {},
  }: MetricsPollOptions = {},
): Promise<PollerResult> {
  const startedAt = new Date();
  const result = emptyResult("metrics", startedAt);
  result.devicesTargeted = targets.length;

  if (targets.length === 0) {
    result.durationMs = Date.now() - startedAt.getTime();
    return result;
  }

  // The adapter reports each unseen key once per instance, so we collect across
  // the whole tick and write the union at the end.
  const discovered: DiscoveredKey[] = [];
  const collectingCanvas = canvas.withKeySink((key) => discovered.push(key));

  const byDeviceId = new Map(targets.map((t) => [t.deviceId, t.id]));
  const batches = chunk(targets, batchSize);

  const { ok, failures } = await mapSettled(batches, concurrency, async (batch) => {
    const raw = await collectingCanvas.fetchMetricsBatch(
      batch.map((t) => ({ deviceId: t.deviceId, deviceJid: t.deviceJid })),
    );

    const samples: HealthSample[] = [];
    const rawToStore: Array<{ deviceId: string; source: string; payload: unknown }> = [];

    for (const payload of raw) {
      const canvasId = payload.device_id ? byDeviceId.get(payload.device_id) : undefined;
      if (!canvasId) continue;

      samples.push(collectingCanvas.toHealthSample(canvasId, payload));

      // Sample rather than store everything — full retention of 1,247 payloads
      // every five minutes would dwarf the health table for little extra value.
      if (Math.random() < rawSampleRate) {
        rawToStore.push({ deviceId: canvasId, source: "metrics_fetch", payload });
      }
    }
    return { samples, rawToStore };
  });

  result.batchesOk = ok.length;
  result.batchesFailed = failures.length;
  for (const f of failures) result.errors.push(`batch ${f.index}: ${f.error.message}`);

  const samples = ok.flatMap((o) => o.samples);
  const rawToStore = ok.flatMap((o) => o.rawToStore);

  if (samples.length > 0) {
    try {
      result.rowsWritten = await repo.insertHealthSamples(samples, "metrics");
    } catch (error) {
      result.errors.push(`insert health_samples failed: ${(error as Error).message}`);
    }
    result.telemetryYield = samples.filter(hasInferredValue).length / samples.length;
  }

  if (rawToStore.length > 0) {
    try {
      await repo.storeRawPayloads(rawToStore);
    } catch (error) {
      // Non-fatal: raw retention is a debugging aid, not the product.
      result.errors.push(`storeRawPayloads failed: ${(error as Error).message}`);
    }
  }

  if (discovered.length > 0) {
    try {
      await repo.recordDiscoveredKeys(discovered);
      log(`  metrics: ${discovered.length} new telemetry key(s) recorded`);
    } catch (error) {
      result.errors.push(`recordDiscoveredKeys failed: ${(error as Error).message}`);
    }
  }

  const yieldPct = result.telemetryYield === null ? "n/a" : `${(result.telemetryYield * 100).toFixed(0)}%`;
  log(
    `  metrics: ${samples.length} sample(s) from ${ok.length}/${batches.length} batch(es), ` +
      `${result.rowsWritten} row(s), telemetry yield ${yieldPct}`,
  );

  if (result.telemetryYield === 0 && samples.length > 0) {
    result.errors.push(
      "Telemetry yield is 0% — no candidate key matched any metric on any device. " +
        "Either this hardware reports nothing in super_props/status, or the payload " +
        "vocabulary differs from every guess in adapter.ts. Run `npm run discover`.",
    );
  }

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
