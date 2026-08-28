/**
 * Evidence capture sweep — keep screen screenshots fresh by rotating through the
 * online estate in small batches.
 *
 * The Videri screenshot CDN is stale by default: a device only uploads a new
 * frame when something asks it to, so the mirror holds images that are, on this
 * fleet, a median of 45 days old. A months-old screenshot is worthless as
 * evidence of what is on screen now.
 *
 * But a device WILL capture on demand: `demo_command get_screenshot:=true`
 * uploads a fresh frame to the CDN within a few seconds (verified: a 3-month-old
 * image became 4 seconds old). So instead of showing whatever the CDN happens to
 * hold, we drive it: every tick, take the N online devices we have asked least
 * recently, ask each to capture, and stamp the request time. Ordering by
 * `screenshot_requested_at ASC NULLS FIRST` makes this a natural round-robin — a
 * full sweep of the online estate completes in (online / batch) ticks and then
 * loops, so nothing ages past roughly one sweep cycle.
 *
 * This is intentionally gentle: a small batch per tick, online devices only
 * (an offline device cannot capture), and it never blocks the fast lane.
 *
 * `get_screenshot:=true` uploads a screenshot and changes no device state or
 * content — it is a capture, not a control command — so it is safe to run
 * continuously. It is the one non-read demo verb this product issues, and only
 * this narrow, fixed form of it.
 */

import type { VideriHttp } from "../../videri/http.js";
import type { Repository } from "../../db/repository.js";
import { mapSettled } from "../batching.js";
import { type PollerResult, emptyResult } from "./types.js";

export interface EvidenceTarget {
  id: string;
  deviceId: string;
  deviceJid: string | null;
  playerId: string | null;
}

export interface EvidencePollOptions {
  batchSize?: number;
  concurrency?: number;
  log?: (message: string) => void;
}

const responseCode = (r: {
  response_code?: string;
  responses?: Array<{ params?: { response_code?: string } }>;
}): string =>
  (r.response_code ?? r.responses?.[0]?.params?.response_code ?? "UNKNOWN").toUpperCase();

export async function pollEvidenceCapture(
  http: VideriHttp,
  repo: Repository,
  targets: EvidenceTarget[],
  { batchSize = 12, concurrency = 4, log = () => {} }: EvidencePollOptions = {},
): Promise<PollerResult> {
  const startedAt = new Date();
  const result = emptyResult("evidence-capture", startedAt);

  const batch = targets.filter((t) => t.deviceJid).slice(0, batchSize);
  result.devicesTargeted = batch.length;
  if (batch.length === 0) {
    result.durationMs = Date.now() - startedAt.getTime();
    return result;
  }

  const captured: string[] = [];
  const { ok, failures } = await mapSettled(batch, concurrency, async (t) => {
    const response = await http.request<{
      response_code?: string;
      responses?: Array<{ params?: { response_code?: string } }>;
    }>("messaging", "/messaging/sync_command", {
      method: "POST",
      body: {
        device_id: t.deviceId,
        device_jid: t.deviceJid,
        player_id: t.playerId ?? t.deviceId,
        command_name: "demo_command",
        command_params: { arg: "get_screenshot:=true" },
        message_id: crypto.randomUUID(),
      },
    });
    const code = responseCode(response);
    if (code !== "SUCCESS") {
      // TIME_OUT / DEVICE_OFFLINE are unremarkable at fleet scale.
      throw new Error(`${t.id}: ${code}`);
    }
    return t.id;
  });

  captured.push(...ok);
  result.batchesOk = ok.length;
  result.batchesFailed = failures.length;

  // Stamp EVERY device we attempted, success or not: a device that keeps timing
  // out must still rotate to the back of the queue, or it would monopolise the
  // sweep and starve the rest of the estate.
  await repo.markScreenshotRequested(batch.map((t) => t.id));

  // Collapse repeated outcomes.
  const reasons = new Map<string, number>();
  for (const f of failures) {
    const key = /TIME_OUT|DEVICE_OFFLINE/.exec(f.error.message)?.[0] ?? f.error.message.slice(0, 40);
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  for (const [reason, count] of reasons) {
    result.errors.push(count > 1 ? `${reason} (×${count})` : reason);
  }

  result.telemetryYield = batch.length === 0 ? null : ok.length / batch.length;
  log(
    `  evidence: asked ${batch.length} device(s) to capture, ${ok.length} accepted` +
      (failures.length ? ` (${failures.length} timed out/offline)` : ""),
  );
  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
