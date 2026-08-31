import type { FastifyInstance } from "fastify";
import { envelope } from "../freshness.js";
import {
  BASIS,
  assemblePersistedProofOfPlay,
  detectGaps,
  normalizeEvents,
  scheduledNow,
  type PopDevice,
  type ScheduledEvent,
} from "../../intelligence/proof-of-play.js";
import type { ApiContext } from "../server.js";

/**
 * How many devices we read a schedule for in one request. The route fans out one
 * publisher call per device (v1 events are per-canvas), so this is a hard cap on
 * outbound calls — kept modest and, crucially, reported in the payload so a
 * larger fleet reads as "the freshest N considered", never as a silent truncation.
 */
const DEVICE_CAP = 40;

/** Outbound concurrency for the per-device schedule fan-out. */
const FETCH_CONCURRENCY = 8;

/** Run `fn` over `items` with a bounded number of in-flight calls. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function registerProofOfPlayRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  /**
   * Scheduled proof-of-play + screen-state gap detection (Epic 3/4, docs/19).
   *
   * PREFERS the fleet-wide PERSISTED schedules (US-4.5). The schedule slow lane
   * (`schedule-slowlane`) stores a per-canvas "scheduled now" snapshot in
   * `device_schedule`, so gap detection can run over the WHOLE fleet from our own
   * tables — one query, no outbound calls, no cap — joined against the latest
   * screen-state we hold. Coverage is reported honestly (how many of the fleet
   * have a snapshot yet) and every snapshot carries its `fetchedAt` age, so a
   * partial or stale sweep never reads as fabricated liveness.
   *
   * FALLS BACK to the original bounded LIVE sample when the table is still empty
   * (before the poller's first sweep), so the endpoint works pre-poll: it reads
   * the publisher v1 events per device for a capped batch and joins the same way.
   *
   * HONESTY, load-bearing in both paths:
   *   - "Scheduled, not confirmed." No render log is readable, so a schedule is
   *     never presented as playback. `BASIS` states this in the payload.
   *   - A gap requires a definitive bad screen signal (off / black / logo) while
   *     content is scheduled. An unread panel is reported as unknown, never a gap.
   *   - Coverage/truncation is always in the payload: no silent drop, no
   *     fabricated coverage.
   *
   * GET reads only — this endpoint never writes to a device. Carries the standard
   * freshness envelope, since a schedule/screen join is only as live as the data
   * behind it.
   */
  app.get("/api/proof-of-play", async (_request, reply) => {
    const [persisted, freshness] = await Promise.all([
      ctx.queries.popPersistedSchedules(),
      ctx.freshness(),
    ]);

    // Today's date for the per-canvas events lookup (UTC; the schedules on this
    // tenant are always-on so the date boundary never bites — noted, not hidden).
    const date = new Date().toISOString().slice(0, 10);

    // ── Preferred path: fleet-wide persisted schedules ──
    // Present iff the slow lane has written at least one snapshot. Reads only our
    // own tables, so it covers every device with a snapshot with no cap.
    if (persisted.devices.length > 0) {
      const { devices, coverage, staleness } = assemblePersistedProofOfPlay(
        persisted.devices,
        persisted.fleetDevices,
      );
      const report = detectGaps(devices);
      return reply.send(
        envelope(
          {
            date,
            basis: BASIS,
            source: "persisted fleet-wide (device_schedule slow lane)",
            mode: "persisted",
            controlPlane: true,
            devices: report.devices,
            summary: report.summary,
            coverage,
            staleness,
          },
          freshness,
        ),
      );
    }

    // ── Fallback path: bounded live sample (pre-poll) ──
    // The table is empty, so read the publisher live for a capped batch of the
    // freshest-screen-state devices — the endpoint's original behaviour.
    const batch = await ctx.queries.popScreenState(DEVICE_CAP);

    // No control plane configured → we can read screen-state but not schedules.
    // Return an honest empty report rather than pretending, or 500ing.
    if (!ctx.videri) {
      return reply.send(
        envelope(
          {
            date,
            basis: BASIS,
            source: "publisher v1 per-device (bounded batch)",
            mode: "live-sample",
            controlPlane: false,
            note: "No Videri credentials configured, so schedules cannot be read; screen-state is unjoined.",
            devices: [],
            summary: {
              devicesWithSchedule: 0,
              gaps: 0,
              byReason: { "screen off": 0, "screen black": 0, "screen logo": 0 },
              screenStateUnknown: 0,
            },
            batch: {
              cap: DEVICE_CAP,
              eligibleDevices: batch.eligibleTotal,
              considered: 0,
              truncated: batch.eligibleTotal > DEVICE_CAP,
              schedulesUnreadable: 0,
            },
          },
          freshness,
        ),
      );
    }

    const at = new Date();
    let schedulesUnreadable = 0;

    const perDevice: PopDevice[] = await mapWithConcurrency(
      batch.devices,
      FETCH_CONCURRENCY,
      async (d): Promise<PopDevice> => {
        let scheduled: ScheduledEvent[] = [];
        try {
          const raw = await ctx.videri!.request<unknown>(
            "publisher",
            `/api/v1/canvases/${encodeURIComponent(d.id)}/events/${date}`,
          );
          scheduled = scheduledNow(normalizeEvents(raw), at);
        } catch {
          // A schedule we could not read is unknown, not empty. We surface the
          // count and leave this device's schedule empty, so it is never counted
          // as "with schedule" and can never produce a false gap.
          schedulesUnreadable += 1;
        }
        return {
          deviceId: d.id,
          deviceLabel: d.name ?? d.id,
          scheduled,
          screen: {
            isScreenOn: d.isScreenOn,
            isBlackScreen: d.isBlackScreen,
            showingLogo: d.showingLogo,
          },
        };
      },
    );

    const report = detectGaps(perDevice);

    return reply.send(
      envelope(
        {
          date,
          basis: BASIS,
          source: "publisher v1 per-device (bounded batch)",
          mode: "live-sample",
          controlPlane: true,
          devices: report.devices,
          summary: report.summary,
          batch: {
            cap: DEVICE_CAP,
            eligibleDevices: batch.eligibleTotal,
            considered: batch.devices.length,
            truncated: batch.eligibleTotal > batch.devices.length,
            schedulesUnreadable,
          },
        },
        freshness,
      ),
    );
  });
}
