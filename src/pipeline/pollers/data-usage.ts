/**
 * Data usage poller — daily, and slow by necessity.
 *
 * `GET /data_usage/{deviceId}` has **no batch variant**, so this is one call per
 * device. At fleet scale that is the most expensive poller we have, which is why
 * it runs daily rather than on a short interval.
 *
 * Worth noting for the API-readiness question: this endpoint returns
 * `daily_aggregation[{date, rx, tx}]` — genuine structured history, and the only
 * real time series the platform exposes. It is also the shape every other metric
 * would need. That the pattern exists here but nowhere else is the clearest
 * evidence that fleet-wide metric history is a platform gap rather than a
 * technical impossibility.
 */

import type { VideriHttp } from "../../videri/http.js";
import type { Repository, PollTarget } from "../../db/repository.js";
import type { DataUsageDay } from "../../domain/types.js";
import { mapSettled } from "../batching.js";
import { type PollerResult, emptyResult } from "./types.js";

interface RawDataUsage {
  device_id?: string | null;
  daily_aggregation?: Array<{ date?: string | null; rx?: number | null; tx?: number | null }> | null;
}

export interface DataUsagePollOptions {
  concurrency?: number;
  /** Cap devices per run so a daily sweep cannot run away. */
  maxDevices?: number;
  log?: (message: string) => void;
}

export async function pollDataUsage(
  http: VideriHttp,
  repo: Repository,
  targets: PollTarget[],
  { concurrency = 6, maxDevices = 2_000, log = () => {} }: DataUsagePollOptions = {},
): Promise<PollerResult> {
  const startedAt = new Date();
  const result = emptyResult("data-usage", startedAt);

  const selected = targets.slice(0, maxDevices);
  result.devicesTargeted = selected.length;
  if (selected.length === 0) {
    result.durationMs = Date.now() - startedAt.getTime();
    return result;
  }

  const { ok, failures } = await mapSettled(selected, concurrency, async (target) => {
    const raw = await http.request<RawDataUsage>(
      "canvasStatus",
      `/data_usage/${encodeURIComponent(target.deviceId)}`,
      { tenantHeaderStyle: "x-tenant_id" },
    );

    const days: DataUsageDay[] = [];
    for (const entry of raw.daily_aggregation ?? []) {
      if (!entry?.date) continue;
      const date = entry.date.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      days.push({
        deviceId: target.id,
        date,
        rxBytes: Math.max(0, Math.round(entry.rx ?? 0)),
        txBytes: Math.max(0, Math.round(entry.tx ?? 0)),
      });
    }
    return days;
  });

  result.batchesOk = ok.length;
  result.batchesFailed = failures.length;
  // One error line per distinct message, not per device — 400 identical 404s
  // is one finding, and flooding the log obscures the real failures.
  const seen = new Map<string, number>();
  for (const f of failures) seen.set(f.error.message, (seen.get(f.error.message) ?? 0) + 1);
  for (const [message, count] of seen) {
    result.errors.push(count > 1 ? `${message} (×${count})` : message);
  }

  const days = ok.flat();
  if (days.length > 0) {
    try {
      result.rowsWritten = await repo.upsertDataUsage(days);
    } catch (error) {
      result.errors.push(`upsertDataUsage failed: ${(error as Error).message}`);
    }
  }

  log(
    `  data-usage: ${days.length} day-row(s) from ${ok.length}/${selected.length} device(s), ` +
      `${result.rowsWritten} written`,
  );

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
