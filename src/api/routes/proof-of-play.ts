import type { FastifyInstance } from "fastify";
import { envelope } from "../freshness.js";
import {
  BASIS,
  detectGaps,
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

/**
 * The publisher's per-canvas events endpoint returns the day's schedule. Its
 * envelope is not pinned by a published spec, so we accept the three shapes the
 * platform's services use (bare array / NestJS `data` / Spring `content`) and
 * normalise to honest nulls. An unrecognised shape yields `[]`, which the engine
 * reads as "no schedule", not a gap.
 */
function normalizeEvents(raw: unknown): ScheduledEvent[] {
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown })?.data)
      ? ((raw as { data: unknown[] }).data)
      : Array.isArray((raw as { content?: unknown })?.content)
        ? ((raw as { content: unknown[] }).content)
        : [];

  return arr.map((e): ScheduledEvent => {
    const o = (e ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim() !== "" ? v : null;
    const numOrNull = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      assetUuid: str(o["assetUuid"]),
      assetType: str(o["assetType"]),
      durationMs: numOrNull(o["durationMs"]),
      startTime: str(o["startTime"]),
      endTime: str(o["endTime"]),
      priority: numOrNull(o["priority"]),
      frequency: str(o["frequency"]),
    };
  });
}

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
   * Scheduled proof-of-play + screen-state gap detection (Epic 3, docs/19).
   *
   * Reads the platform SCHEDULE (publisher v1 events, per canvas, for today) for
   * a bounded batch of devices that have a recent screen-state, joins it against
   * the latest screen-state we hold, and runs the pure gap detector.
   *
   * HONESTY, load-bearing:
   *   - "Scheduled, not confirmed." No render log is readable, so a schedule is
   *     never presented as playback. `BASIS` states this in the payload.
   *   - A gap requires a definitive bad screen signal (off / black / logo) while
   *     content is scheduled. An unread panel is reported as unknown, never a gap.
   *   - The batch is capped and the cap + eligible total + unreadable count are
   *     all in the payload: no silent truncation, no fabricated coverage.
   *
   * GET reads only — this endpoint never writes to a device. Carries the standard
   * freshness envelope, since a schedule/screen join is only as live as the
   * screen-state behind it.
   */
  app.get("/api/proof-of-play", async (_request, reply) => {
    const [batch, freshness] = await Promise.all([
      ctx.queries.popScreenState(DEVICE_CAP),
      ctx.freshness(),
    ]);

    // Today's date for the per-canvas events lookup (UTC; the schedules on this
    // tenant are always-on so the date boundary never bites — noted, not hidden).
    const date = new Date().toISOString().slice(0, 10);

    // No control plane configured → we can read screen-state but not schedules.
    // Return an honest empty report rather than pretending, or 500ing.
    if (!ctx.videri) {
      return reply.send(
        envelope(
          {
            date,
            basis: BASIS,
            source: "publisher v1 per-device (bounded batch)",
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
