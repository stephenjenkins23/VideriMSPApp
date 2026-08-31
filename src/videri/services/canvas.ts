import type { VideriHttp } from "../http.js";
import { MetricsAdapter, toDevice, type KeySink, type RawCanvas, type RawMetricsPayload } from "../adapter.js";
import type { Device, HealthSample } from "../../domain/types.js";

/**
 * canvas-service + canvas-status.
 *
 * These two together are the device system of record and its live state. Note
 * the batch endpoints — `status/fetch_all` and `metrics/fetch_all` take a list
 * of devices, which is why polling 1,247 devices costs tens of calls rather than
 * thousands. Fleet-scale reads were designed for; this is the platform at its
 * best.
 */
/** One page of a device sweep, tagged with its leg and that leg's completion. */
export interface DeviceSweepPage {
  /** Which `assigned_to_group` value produced this page. */
  assignedToGroup: boolean;
  devices: Device[];
  /** True on the single final yield per leg: that leg paginated to exhaustion. */
  legComplete: boolean;
}

export class CanvasService {
  readonly #adapter: MetricsAdapter;

  constructor(
    private readonly http: VideriHttp,
    private readonly onKeyDiscovered: KeySink = () => {},
  ) {
    this.#adapter = new MetricsAdapter(onKeyDiscovered);
  }

  /**
   * A sibling service that reports discovered telemetry keys to a different sink.
   *
   * The adapter reports each unseen key only once per instance, so a long-lived
   * CanvasService would go quiet after the first poll tick. The metrics poller
   * takes a fresh instance per run to collect that tick's full key set.
   */
  withKeySink(sink: KeySink): CanvasService {
    return new CanvasService(this.http, sink);
  }

  /**
   * Every canvas in the tenant, page by page, tagged with which sweep leg it came
   * from and whether that leg ran to exhaustion.
   *
   * `assigned_to_group` is a REQUIRED query parameter, and — the trap —
   * neither value means "all". On VIDERISALES, `true` returns 233 devices and
   * `false` returns 16. A client that only ever passes `true` silently
   * undercounts the fleet by 15% (docs/05-LIVE-API-FINDINGS.md §6), so we sweep
   * both and yield the union.
   *
   * `legComplete` exists because "did this sweep see the whole fleet?" cannot be
   * inferred from the pages alone: a leg that returned NOTHING is indistinguishable
   * from a leg that was never run. Device retirement (pollers/devices.ts) may only
   * act on a sweep where BOTH legs completed, so the completion of each leg is
   * reported explicitly — as a final empty page per leg — rather than guessed at.
   */
  async *sweepDevices(pageSize = 200): AsyncGenerator<DeviceSweepPage> {
    const seen = new Set<string>();
    for (const assigned of [true, false]) {
      for await (const page of this.http.springPages<RawCanvas>("canvasService", "/canvases", {
        size: pageSize,
        query: { assigned_to_group: assigned, with_status: true },
      })) {
        const devices = page
          .map(toDevice)
          .filter((d): d is Device => d !== null && !seen.has(d.id));
        for (const d of devices) seen.add(d.id);
        if (devices.length > 0) {
          yield { assignedToGroup: assigned, devices, legComplete: false };
        }
      }
      // The leg paginated to exhaustion without throwing. An exception anywhere
      // above propagates instead, and this marker is never emitted — which is
      // exactly how a partial sweep stays visible to the caller.
      yield { assignedToGroup: assigned, devices: [], legComplete: true };
    }
  }

  /** Devices only, for callers that do not care about sweep completeness. */
  async *listDevices(pageSize = 200): AsyncGenerator<Device[]> {
    for await (const page of this.sweepDevices(pageSize)) {
      if (page.devices.length > 0) yield page.devices;
    }
  }

  /**
   * Batch live status. `status/fetch_all` wants `{players: [{device_id, device_jid}]}`
   * — both identifiers, because device_id alone will not route.
   */
  async fetchStatusBatch(
    players: Array<{ deviceId: string; deviceJid: string | null }>,
  ): Promise<RawMetricsPayload[]> {
    const body = {
      players: players
        .filter((p) => p.deviceJid)
        .map((p) => ({ device_id: p.deviceId, device_jid: p.deviceJid })),
    };
    if (body.players.length === 0) return [];

    return this.http.request<RawMetricsPayload[]>("canvasStatus", "/status/fetch_all", {
      method: "POST",
      body,
      // canvas-status is the one service using x-tenant_id rather than x-tenant.
      tenantHeaderStyle: "x-tenant_id",
    });
  }

  /**
   * Batch metrics — where the `super_props` payload arrives.
   *
   * NOTE the body shape: `metrics/fetch_all` takes a **bare array of device-id
   * strings**, NOT the `{players:[{device_id, device_jid}]}` envelope that
   * `status/fetch_all` requires. The two sibling batch endpoints on the same
   * service disagree, and sending the status shape here returns a bodiless 400.
   * Verified live 2026-08-25.
   */
  async fetchMetricsBatch(
    players: Array<{ deviceId: string; deviceJid: string | null }>,
  ): Promise<RawMetricsPayload[]> {
    const deviceIds = players.map((p) => p.deviceId).filter(Boolean);
    if (deviceIds.length === 0) return [];
    return this.http.request<RawMetricsPayload[]>("canvasStatus", "/metrics/fetch_all", {
      method: "POST",
      body: deviceIds,
      tenantHeaderStyle: "x-tenant_id",
    });
  }

  /** Single-device metrics. Mostly for probing and the discovery script. */
  async fetchMetrics(deviceId: string): Promise<RawMetricsPayload> {
    return this.http.request<RawMetricsPayload>("canvasStatus", `/metrics/fetch/${encodeURIComponent(deviceId)}`, {
      tenantHeaderStyle: "x-tenant_id",
    });
  }

  toHealthSample(canvasId: string, raw: RawMetricsPayload): HealthSample {
    return this.#adapter.toHealthSample(canvasId, raw);
  }
}
