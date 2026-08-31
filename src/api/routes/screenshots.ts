/**
 * Device screenshots — retrieved, at last.
 *
 * This corrects the most consequential wrong finding in the project. We had
 * concluded screenshots were unreachable, and the evidence was real as far as it
 * went: `POST /canvas/v1/players/storage/{deviceId}` returns `verb: put`, a GET
 * against that presigned URL is 403, and no capture command exists among the 28.
 * All true. The mistake was inferring "no read path exists" from "this read path
 * is closed" — we only ever probed api.go.videri.com.
 *
 * The images are served from a public CloudFront mirror of the same bucket:
 *
 *   https://cdn.go.videri.com/videri-production-canvas-service/screenshots/{SERIAL}.jpg
 *
 * Two details that make or break it:
 *
 *   1. The key is the device's HARDWARE SERIAL (`serial_no`), not the numeric
 *      canvas id. The numeric id returns 403, which is exactly the sort of thing
 *      that reads as "no access" rather than "wrong key".
 *   2. Availability is total but freshness is not. Measured over 60 devices:
 *      every one had an image, p50 age 45 DAYS, p90 250 days. Only 5 of 60 were
 *      under a day old.
 *
 * So this is an archive, not a live feed, and the age is as important as the
 * pixels. Every response carries the age and an explicit staleness verdict, and
 * the UI is expected to label or withhold rather than present a months-old frame
 * as current evidence.
 */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../server.js";
import { envelope } from "../freshness.js";
import { pollEvidenceCapture } from "../../pipeline/pollers/evidence.js";

const CDN_BASE =
  "https://cdn.go.videri.com/videri-production-canvas-service/screenshots";

/**
 * Beyond this, a frame is history rather than evidence.
 *
 * Tightened from an hour to ten minutes because captures are now DRIVEN: the
 * evidence sweep asks online devices to capture on demand (a stale frame becomes
 * seconds old within ~5 s), so anything older than a few minutes means the
 * device did not answer the last request, not that this is the best we can do.
 * A ten-minute-old frame is worthless to an operator watching a live estate.
 */
const FRESH_WITHIN_SECONDS = 600;

/**
 * The sweep asks a batch of online devices to capture. It issues one device
 * command each (`get_screenshot:=true`), so it is rate-limited server-side: a
 * client cannot trigger captures faster than this, however often it calls.
 */
const MIN_SWEEP_INTERVAL_MS = 25_000;
let lastSweepAt = 0;

/**
 * Per-device capture cursor for the drawer's on-demand button. Same budget as
 * the sweep, but keyed by device so one operator hammering a single drawer
 * cannot out-pace the fleet, while two operators looking at two devices are not
 * throttled against each other. Bounded by fleet size; never pruned because a
 * stale entry is a single timestamp and the map is at most one row per device.
 */
const lastCaptureByDevice = new Map<string, number>();

export interface CaptureThrottleDecision {
  allowed: boolean;
  /** How long the caller must wait; 0 when allowed. */
  retryAfterMs: number;
}

/**
 * Pure throttle decision, extracted so the rate-limit rule is unit-tested
 * without a server or a clock. `lastAt` is undefined for a device never asked.
 */
export function decideCaptureThrottle(
  lastAt: number | undefined,
  now: number,
  minIntervalMs: number,
): CaptureThrottleDecision {
  if (lastAt === undefined) return { allowed: true, retryAfterMs: 0 };
  const sinceLast = now - lastAt;
  return sinceLast < minIntervalMs
    ? { allowed: false, retryAfterMs: minIntervalMs - sinceLast }
    : { allowed: true, retryAfterMs: 0 };
}

const screenshotUrl = (serial: string): string =>
  `${CDN_BASE}/${encodeURIComponent(serial)}.jpg`;

export interface ScreenshotMeta {
  deviceId: string;
  available: boolean;
  /** Only ever our own proxy path — the CDN key is a serial we do not publish. */
  url: string | null;
  lastModified: string | null;
  ageSeconds: number | null;
  /** true when the frame is too old to describe the screen now. */
  stale: boolean;
  bytes: number | null;
  reason?: string;
}

async function headScreenshot(deviceId: string, serial: string | null): Promise<ScreenshotMeta> {
  const base: ScreenshotMeta = {
    deviceId, available: false, url: null, lastModified: null,
    ageSeconds: null, stale: true, bytes: null,
  };
  if (!serial) {
    return { ...base, reason: "device has no hardware serial, which is the CDN key" };
  }
  try {
    const res = await fetch(screenshotUrl(serial), {
      method: "HEAD",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { ...base, reason: `CDN returned ${res.status} for this serial` };
    }
    const lm = res.headers.get("last-modified");
    const when = lm ? new Date(lm) : null;
    const ageSeconds = when && !Number.isNaN(when.getTime())
      ? Math.max(0, Math.round((Date.now() - when.getTime()) / 1000))
      : null;
    const len = Number(res.headers.get("content-length"));
    return {
      deviceId,
      available: true,
      url: `/api/devices/${encodeURIComponent(deviceId)}/screenshot`,
      lastModified: when ? when.toISOString() : null,
      ageSeconds,
      // No Last-Modified means we cannot date the frame, so it cannot be trusted
      // as current — absence of an age is not freshness.
      stale: ageSeconds === null ? true : ageSeconds > FRESH_WITHIN_SECONDS,
      bytes: Number.isFinite(len) ? len : null,
    };
  } catch (error) {
    return { ...base, reason: `CDN unreachable: ${(error as Error).message}` };
  }
}

const BatchQuery = z.object({
  limit: z.coerce.number().int().min(1).max(60).default(24),
  /** "online" restricts to devices we have seen recently — the ones worth showing. */
  scope: z.enum(["online", "all"]).default("online"),
  /**
   * Hide frames older than this many minutes. Default 10 — with driven captures
   * anything older means the device did not answer, not that it is the best
   * available. 0 disables the gate (show whatever is on file).
   */
  maxAgeMinutes: z.coerce.number().int().min(0).max(20160).default(10),
});

export async function registerScreenshotRoutes(
  app: FastifyInstance,
  ctx: ApiContext,
): Promise<void> {
  /** Metadata for one device: is there a frame, how old, is it usable. */
  app.get<{ Params: { id: string } }>(
    "/api/devices/:id/screenshot/meta",
    async (request, reply) => {
      const device = await ctx.queries.device(request.params.id);
      if (!device) {
        return reply.code(404).send({ error: "not_found", message: "No such device." });
      }
      const serial = (device as { serialNo?: string | null }).serialNo ?? null;
      const [meta, freshness] = await Promise.all([
        headScreenshot(device.id, serial),
        ctx.freshness(),
      ]);
      return envelope(meta, freshness);
    },
  );

  /**
   * The bytes, proxied.
   *
   * Proxied rather than linked so the browser never learns the CDN key pattern,
   * the age check happens server-side, and a stale frame still carries its age
   * on the response instead of arriving as an undated image.
   */
  app.get<{ Params: { id: string } }>(
    "/api/devices/:id/screenshot",
    async (request, reply) => {
      const device = await ctx.queries.device(request.params.id);
      if (!device) {
        return reply.code(404).send({ error: "not_found", message: "No such device." });
      }
      const serial = (device as { serialNo?: string | null }).serialNo ?? null;
      if (!serial) {
        return reply.code(409).send({
          error: "no_serial",
          message: "This device has no hardware serial, which is the CDN key.",
        });
      }
      try {
        const res = await fetch(screenshotUrl(serial), {
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) {
          return reply.code(404).send({
            error: "no_screenshot",
            message: `The CDN returned ${res.status} for this device's serial.`,
          });
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const lm = res.headers.get("last-modified");
        const when = lm ? new Date(lm) : null;
        const ageSeconds = when && !Number.isNaN(when.getTime())
          ? Math.max(0, Math.round((Date.now() - when.getTime()) / 1000))
          : null;

        // The upstream serves application/octet-stream; the bytes are JPEG.
        return reply
          .header("content-type", "image/jpeg")
          .header("cache-control", "private, max-age=60")
          .header("x-screenshot-age-seconds", ageSeconds === null ? "unknown" : String(ageSeconds))
          .header("x-screenshot-stale",
            String(ageSeconds === null ? true : ageSeconds > FRESH_WITHIN_SECONDS))
          .header("x-screenshot-last-modified", when ? when.toISOString() : "unknown")
          .send(buf);
      } catch (error) {
        return reply.code(502).send({
          error: "cdn_unreachable",
          message: (error as Error).message,
        });
      }
    },
  );

  /**
   * A wall of frames for the Overview.
   *
   * Fanned out concurrently because each entry is one HEAD; capped so a large
   * fleet cannot turn a dashboard render into 250 outbound requests.
   */
  app.get("/api/screenshots", async (request, reply) => {
    const parsed = BatchQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const { limit, scope } = parsed.data;
    // Pull a wider candidate set than we return: we head-check the CDN and keep
    // only the fresh ones, so we need slack to still fill the wall after the
    // stale majority is dropped.
    const targets = await ctx.repo.screenshotTargets(scope === "online", Math.min(60, limit * 4));
    const metas = await Promise.all(
      targets.map(async (t) => ({
        ...(await headScreenshot(t.id, t.serialNo)),
        name: t.name,
        deviceClass: t.deviceClass,
        online: t.online,
        // Content-state, so the wall can flag black / logo frames.
        isBlackScreen: t.isBlackScreen,
        showingLogo: t.showingLogo,
        anomaly: t.isBlackScreen === true ? "black" : t.showingLogo === true ? "logo" : null,
      })),
    );

    // Default: HIDE stale entirely — a 2-day-old frame is worthless to someone
    // watching a live estate. `maxAgeMinutes=0` opts back into showing everything
    // (for a "what do we have on file" view).
    const maxAge = parsed.data.maxAgeMinutes;
    const gated =
      maxAge === 0
        ? metas.filter((m) => m.available)
        : metas.filter((m) => m.available && m.ageSeconds !== null && m.ageSeconds <= maxAge * 60);

    // Anomalies first (black, then logo), then freshest. What needs attention leads.
    const rank = (m: (typeof gated)[number]): number =>
      m.anomaly === "black" ? 0 : m.anomaly === "logo" ? 1 : 2;
    gated.sort((a, b) => rank(a) - rank(b) || (a.ageSeconds ?? Infinity) - (b.ageSeconds ?? Infinity));

    const freshness = await ctx.freshness();
    return envelope(
      {
        freshWithinSeconds: FRESH_WITHIN_SECONDS,
        maxAgeMinutes: maxAge,
        candidatesChecked: metas.length,
        available: metas.filter((m) => m.available).length,
        shown: Math.min(gated.length, limit),
        anomalies: gated.filter((m) => m.anomaly).length,
        screenshots: gated.slice(0, limit),
      },
      freshness,
    );
  });

  /**
   * Drive ONE fresh capture, for the device drawer.
   *
   * The drawer shows the last CDN frame and its age; this lets an operator ask
   * that one device to upload a current frame (`get_screenshot:=true` — a
   * capture, no device-state change, the same benign verb the sweep issues) and
   * then reads the fresh frame's age straight back so the client can show it
   * without inferring freshness. Rate-limited PER DEVICE, so repeated clicks on
   * one drawer cannot out-pace the fleet.
   */
  app.post<{ Params: { id: string } }>(
    "/api/devices/:id/screenshot/capture",
    async (request, reply) => {
      if (!ctx.videri) {
        return reply.code(503).send({
          error: "capture_unavailable",
          message: "This server has no Videri credentials, so it cannot ask a device to capture.",
        });
      }
      const device = await ctx.queries.device(request.params.id);
      if (!device) {
        return reply.code(404).send({ error: "not_found", message: "No such device." });
      }
      const serial = (device as { serialNo?: string | null }).serialNo ?? null;

      const target = await ctx.repo.evidenceCaptureTarget(device.id);
      if (!target) {
        // Null means we cannot honestly complete a capture. We know the serial
        // from the detail lookup, so say WHICH identifier is missing: no serial
        // means no CDN key to read the frame back from; a serial-but-null target
        // means no routable JID to send the capture command to. Never a 500.
        return reply.code(409).send(
          serial
            ? {
                error: "not_addressable",
                message: "This device has no routable JID, so a capture command cannot reach it.",
              }
            : {
                error: "no_serial",
                message: "This device has no hardware serial, which is the CDN key its frame is stored under.",
              },
        );
      }

      const now = Date.now();
      const decision = decideCaptureThrottle(
        lastCaptureByDevice.get(device.id), now, MIN_SWEEP_INTERVAL_MS,
      );
      if (!decision.allowed) {
        return reply.code(429).send({
          error: "capturing_too_fast",
          retryAfterMs: decision.retryAfterMs,
          message: "This device was asked to capture moments ago. Captures are rate-limited to protect the fleet.",
        });
      }
      lastCaptureByDevice.set(device.id, now);

      const result = await pollEvidenceCapture(ctx.videri, ctx.repo, [target], { batchSize: 1 });
      // Read the fresh frame's age straight back (HEAD only, the meta path) so
      // the client gets the new age without a second round-trip. A device that
      // timed out leaves the old frame in place — meta then still carries its
      // real age, so the UI stays honest rather than implying a refresh.
      const [meta, freshness] = await Promise.all([
        headScreenshot(device.id, serial),
        ctx.freshness(),
      ]);
      return envelope(
        {
          accepted: result.batchesOk,
          failed: result.batchesFailed,
          note: result.errors.slice(0, 3),
          meta,
        },
        freshness,
      );
    },
  );

  /**
   * Drive a batch of fresh captures across the online estate.
   *
   * The UI calls this on an interval WHILE SOMEONE IS WATCHING, so device
   * captures only happen when a person is actually looking at the wall — not as a
   * standing background job hammering the fleet. Rotation is by
   * `screenshot_requested_at`, so successive calls cover the whole online estate
   * and then loop. Rate-limited so it cannot be called faster than one batch per
   * ~25 s regardless of client behaviour.
   */
  app.post("/api/screenshots/sweep", async (_request, reply) => {
    if (!ctx.videri) {
      return reply.code(503).send({
        error: "capture_unavailable",
        message: "This server has no Videri credentials, so it cannot ask a device to capture.",
      });
    }
    const now = Date.now();
    const sinceLast = now - lastSweepAt;
    if (sinceLast < MIN_SWEEP_INTERVAL_MS) {
      return reply.code(429).send({
        error: "sweeping_too_fast",
        retryAfterMs: MIN_SWEEP_INTERVAL_MS - sinceLast,
        message: "A capture sweep ran moments ago. Captures are rate-limited to protect the fleet.",
      });
    }
    lastSweepAt = now;

    const targets = await ctx.repo.evidenceCaptureTargets(12);
    const result = await pollEvidenceCapture(ctx.videri, ctx.repo, targets, { batchSize: 12 });
    const freshness = await ctx.freshness();
    return envelope(
      {
        asked: result.devicesTargeted,
        accepted: result.batchesOk,
        failed: result.batchesFailed,
        note: result.errors.slice(0, 3),
      },
      freshness,
    );
  });
}
