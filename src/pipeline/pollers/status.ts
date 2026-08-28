/**
 * Status poller — the fast loop.
 *
 * Uses `POST /status/fetch_all`, which takes a list of devices. That batch
 * endpoint is why covering 1,247 devices every 60 seconds costs ~13 calls rather
 * than 1,247, and it is the single reason polling this fleet is viable at all.
 *
 * Writes rows tagged `source = 'status'`. These carry presence and screen state
 * but no hardware telemetry, which is exactly why the source column exists.
 */

import type { CanvasService } from "../../videri/services/canvas.js";
import type { Repository, PollTarget } from "../../db/repository.js";
import type { HealthSample } from "../../domain/types.js";
import { chunk, mapSettled } from "../batching.js";
import { type PollerResult, emptyResult } from "./types.js";

export interface StatusPollOptions {
  batchSize?: number;
  concurrency?: number;
  log?: (message: string) => void;
}

export async function pollStatus(
  canvas: CanvasService,
  repo: Repository,
  targets: PollTarget[],
  { batchSize = 100, concurrency = 4, log = () => {} }: StatusPollOptions = {},
): Promise<PollerResult> {
  const startedAt = new Date();
  const result = emptyResult("status", startedAt);

  // status/fetch_all routes on device_jid; a device without one is unpollable.
  const pollable = targets.filter((t) => t.deviceJid);
  const skipped = targets.length - pollable.length;
  result.devicesTargeted = pollable.length;

  if (skipped > 0) {
    result.errors.push(
      `${skipped} device(s) have no xmpp_jid and cannot be polled for status.`,
    );
  }
  if (pollable.length === 0) {
    result.durationMs = Date.now() - startedAt.getTime();
    return result;
  }

  const byDeviceId = new Map(pollable.map((t) => [t.deviceId, t.id]));
  const batches = chunk(pollable, batchSize);

  const { ok, failures } = await mapSettled(batches, concurrency, async (batch) => {
    const raw = await canvas.fetchStatusBatch(
      batch.map((t) => ({ deviceId: t.deviceId, deviceJid: t.deviceJid })),
    );

    const samples: HealthSample[] = [];
    for (const payload of raw) {
      const canvasId = payload.device_id ? byDeviceId.get(payload.device_id) : undefined;
      // A response for a device we did not ask about is a routing bug upstream;
      // dropping it is safer than attributing telemetry to the wrong screen.
      if (!canvasId) continue;
      samples.push(canvas.toHealthSample(canvasId, payload));
    }
    return samples;
  });

  result.batchesOk = ok.length;
  result.batchesFailed = failures.length;
  for (const f of failures) result.errors.push(`batch ${f.index}: ${f.error.message}`);

  const samples = ok.flat();
  if (samples.length > 0) {
    try {
      result.rowsWritten = await repo.insertHealthSamples(samples, "status");
    } catch (error) {
      result.errors.push(`insert failed: ${(error as Error).message}`);
    }
  }

  log(
    `  status: ${samples.length} sample(s) from ${ok.length}/${batches.length} batch(es), ` +
      `${result.rowsWritten} row(s) written`,
  );

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
