/**
 * The slow lane — reading device configuration via `ops_get_settings`.
 *
 * This is architecturally different from every other poller, and the differences
 * are the whole design:
 *
 *  - **Per-device, not batched.** `sync_command` addresses one device and blocks
 *    until it answers or times out (~10s). There is no bulk settings read.
 *  - **Only online devices.** An offline device burns the full timeout to return
 *    nothing. With 110 of 250 online, skipping the rest saves ~23 minutes a cycle.
 *  - **Slow cadence, cached results.** Hourly at most. Compliance views are served
 *    from `device_settings`, never by calling out on a page load.
 *  - **Modest concurrency.** No rate limit is documented anywhere in the Videri
 *    API and no operation declares a 429, so we stay deliberately gentle rather
 *    than discovering the ceiling in production.
 *
 * Read-only: `ops_get_settings` reads configuration. It writes nothing.
 */

import type { VideriHttp } from "../videri/http.js";
import type { Repository } from "../db/repository.js";
import { mapSettled } from "../pipeline/batching.js";
import { type PollerResult, emptyResult } from "../pipeline/pollers/types.js";

export interface SettingsTarget {
  id: string;
  deviceId: string;
  deviceJid: string | null;
  /** Cached numeric player id, if we have learned it. */
  playerId: string | null;
  deviceClass: string;
}

interface CommandResponse {
  message_id?: string;
  player_id?: string;
  response_code?: string;
  others?: Record<string, unknown>;
}

export interface SettingsPollOptions {
  concurrency?: number;
  /** Cap devices per cycle so one run cannot sprawl unbounded. */
  maxDevices?: number;
  log?: (message: string) => void;
}

/**
 * `player_id` is a REQUIRED command field and is a separate numeric identifier
 * (e.g. 1015642) returned in the response — not the device id. Passing the
 * device id is accepted on the first call, and we cache the real value from the
 * response so later calls address the device properly.
 */
export async function pollDeviceSettings(
  http: VideriHttp,
  repo: Repository,
  targets: SettingsTarget[],
  { concurrency = 4, maxDevices = 400, log = () => {} }: SettingsPollOptions = {},
): Promise<PollerResult> {
  const startedAt = new Date();
  const result = emptyResult("device-settings", startedAt);

  const pollable = targets.filter((t) => t.deviceJid).slice(0, maxDevices);
  result.devicesTargeted = pollable.length;
  if (pollable.length === 0) {
    result.durationMs = Date.now() - startedAt.getTime();
    return result;
  }

  const learnedPlayerIds: Array<{ deviceId: string; playerId: string }> = [];
  const settings: Array<{ deviceId: string; deviceClass: string; settings: unknown }> = [];

  const { ok, failures } = await mapSettled(pollable, concurrency, async (target) => {
    const response = await http.request<CommandResponse>("messaging", "/messaging/sync_command", {
      method: "POST",
      body: {
        device_id: target.deviceId,
        device_jid: target.deviceJid,
        // Use the cached numeric id when known, else the device id (accepted).
        player_id: target.playerId ?? target.deviceId,
        command_name: "ops_get_settings",
        command_params: {},
        message_id: crypto.randomUUID(),
      },
    });

    if (response.response_code !== "SUCCESS") {
      // TIME_OUT and DEVICE_OFFLINE are expected and unremarkable at fleet
      // scale — surfaced as a counted outcome, not an error per device.
      throw new Error(`${target.deviceId}: ${response.response_code ?? "no response_code"}`);
    }

    const props = response.others?.["system_properties"];
    if (!props || typeof props !== "object") {
      throw new Error(`${target.deviceId}: SUCCESS but no system_properties`);
    }

    if (response.player_id && response.player_id !== target.playerId) {
      learnedPlayerIds.push({ deviceId: target.id, playerId: response.player_id });
    }
    return { deviceId: target.id, deviceClass: target.deviceClass, settings: props };
  });

  settings.push(...ok);
  result.batchesOk = ok.length;
  result.batchesFailed = failures.length;

  // Collapse repeated outcomes — 140 identical TIME_OUTs is one finding.
  const reasons = new Map<string, number>();
  for (const f of failures) {
    const key = /TIME_OUT|DEVICE_OFFLINE|no response_code/.exec(f.error.message)?.[0]
      ?? f.error.message.slice(0, 60);
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  for (const [reason, count] of reasons) {
    result.errors.push(count > 1 ? `${reason} (×${count})` : reason);
  }

  if (settings.length > 0) {
    try {
      result.rowsWritten = await repo.insertDeviceSettings(settings);
    } catch (error) {
      result.errors.push(`insertDeviceSettings failed: ${(error as Error).message}`);
    }
  }

  if (learnedPlayerIds.length > 0) {
    try {
      await repo.updatePlayerIds(learnedPlayerIds);
      log(`  settings: learned ${learnedPlayerIds.length} player id(s)`);
    } catch (error) {
      result.errors.push(`updatePlayerIds failed: ${(error as Error).message}`);
    }
  }

  const rate = pollable.length === 0 ? 0 : Math.round((ok.length / pollable.length) * 100);
  result.telemetryYield = pollable.length === 0 ? null : ok.length / pollable.length;
  log(
    `  settings: ${ok.length}/${pollable.length} device(s) answered (${rate}%), ` +
      `${result.rowsWritten} snapshot(s) stored`,
  );

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
