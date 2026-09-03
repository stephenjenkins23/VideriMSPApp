/**
 * Device commands — the control plane.
 *
 * Until now the console's control buttons were decoration: the read API had no
 * Videri client at all, so "Reboot" and "Read settings" were enabled elements
 * with no handler. An enabled control that does nothing is worse than a disabled
 * one, because the operator concludes the device is broken rather than the UI.
 *
 * Every command is classified, and the classification decides the gate:
 *
 *   read       — no device state changes. Runs freely.
 *   disruptive — documented, state-changing, recoverable. Requires an explicit
 *                `confirm` flag from the caller.
 *   unverified — the payload shape is NOT documented. `command_params` in the
 *                spec is `additionalProperties: {type: object}` whose only
 *                examples are asset operations, so the field names we would send
 *                for ops_set_settings are inferred from what ops_get_settings
 *                RETURNS. Plausible, unproven. Requires `confirm` AND echoes the
 *                exact payload back so a human can see what was sent.
 *
 * Anything not on the allowlist is refused. This is deliberately not a generic
 * command proxy: wipe_storage, disable_device, ops_uninstall_package and
 * firmware installs are all reachable through the same upstream endpoint, and
 * none of them belong behind a dashboard button.
 */

import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApiContext } from "../server.js";
import { envelope } from "../freshness.js";
import { applyBrightness, applyBrightnessLive, type CommandRunner } from "../../videri/brightness.js";
import {
  readDeviceTelemetry, readDeviceNetwork, readScreenState, commandMessage,
  type TelemetryRunner,
} from "../../videri/telemetry.js";
import { verifyBlackScreenClaim } from "../../intelligence/screen-verify.js";
import { auditOutcomeForBrightness, resolveActor } from "./audit.js";
import type { DeviceActionEntry } from "../../db/repository.js";

type Risk = "read" | "disruptive" | "unverified";

interface CommandSpec {
  risk: Risk;
  /** Human-readable, shown in the UI and in the audit line. */
  label: string;
  /** Builds command_params from the request. Throws to reject bad input. */
  params?: (input: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Brightness scale. Raw 0-255 on the wire; we expose 1-100 percent.
 *
 * Percent starts at 1, not 0, because raw 0 is the device's display-OFF state —
 * a brightness slider must not be able to blank a screen by accident.
 */
export const brightnessRawFromPercent = (pct: number): number => Math.round((pct / 100) * 255);
export const brightnessPercentFromRaw = (raw: number): number => Math.round((raw / 255) * 100);

export const COMMANDS: Record<string, CommandSpec> = {
  ops_get_settings: { risk: "read", label: "Read settings" },
  ops_get_firmware_info: { risk: "read", label: "Read firmware info" },
  ops_get_media_files: { risk: "read", label: "List media files" },
  ops_get_installed_packages: { risk: "read", label: "List installed packages" },

  /**
   * Brightness write — the real contract, and NOT what we had inferred.
   *
   * We had guessed `ops_set_settings {brightness: N}` from what
   * `ops_get_settings` returns. Wrong. The Videri Portal's own device-facing
   * command, confirmed against a connected fleet by a second implementation, is:
   *
   *   command_name: "demo_command"
   *   command_params: { arg: "set_brightness:=<0..255>" }
   *
   * A colon-equals string argument inside a generic `demo_command` — nothing
   * about the settings read surface would ever have suggested that shape, which
   * is exactly why guessing at an undocumented write was the wrong instinct.
   *
   * Still classed `unverified`: it is confirmed on the Spark fleet, not on every
   * class, and it remains undocumented by Videri.
   */
  demo_command: {
    risk: "unverified",
    label: "Set brightness",
    params: (input) => {
      const pct = Number(input["brightnessPercent"]);
      if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
        throw new Error(
          "brightnessPercent must be a whole number from 1 to 100. " +
            "0 is display-off and is deliberately not reachable from here.",
        );
      }
      return { arg: `set_brightness:=${brightnessRawFromPercent(pct)}` };
    },
  },

  /**
   * Both of these are ACCEPTED by the gateway and REFUSED by the hardware.
   * `get_presence` returned ERROR on a live V4 in our own testing, and an
   * independent implementation records both as "rejected_by_device" across the
   * Spark fleet. Kept on the allowlist so the failure is legible rather than
   * looking like a bug in us, but the UI does not offer them as working actions.
   */
  get_presence: { risk: "read", label: "Ping presence (device refuses)" },
  reboot_device: { risk: "disruptive", label: "Reboot device (device refuses)" },
};

const Body = z.object({
  command: z.string().min(1).max(64),
  /** Required for disruptive and unverified commands. */
  confirm: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const BrightnessBody = z.object({
  // 1-100. 0 is display-off and is deliberately not reachable via brightness.
  brightnessPercent: z.coerce.number().int().min(1).max(100),
  confirm: z.boolean().optional(),
  /**
   * "verify" (default): the safe fire-once cycle (preflight→verify→rollback).
   * "live": the fast drag path (set + read-back, no rollback) for a slider the
   * operator is moving continuously. Live still requires confirm — the caller
   * arms live control once, then streams values.
   */
  mode: z.enum(["verify", "live"]).default("verify"),
});

/**
 * Write one audit row for a device action, and NEVER let it affect the action.
 *
 * `recordDeviceAction` does not throw (see repository.ts); the failure comes
 * back as a string and is logged here, because an audit trail that silently
 * stops recording is worse than none — and a device write that 500s because the
 * logging failed would hide the outcome the operator actually needs.
 *
 * The actor is resolved per-request rather than stored: there is no user model
 * yet, so this is the caller's own claim plus what the transport tells us.
 */
function auditor(ctx: ApiContext) {
  return async (
    request: FastifyRequest,
    entry: Omit<DeviceActionEntry, "actor" | "actorIp">,
  ): Promise<void> => {
    const header = request.headers["x-vfi-actor"];
    // Belt AND braces: `recordDeviceAction` is contracted not to throw, and this
    // still catches. The guarantee "logging never breaks the write" must not
    // depend on a contract in another file staying true.
    let failure: string | null = null;
    try {
      failure = (await ctx.repo.recordDeviceAction({
        ...entry,
        actor: resolveActor({
          actorHeader: Array.isArray(header) ? header[0] : header,
          authorization: request.headers.authorization,
          allowAnonymous: ctx.allowAnonymous,
        }),
        actorIp: request.ip ?? null,
      })).error;
    } catch (error) {
      failure = (error as Error).message;
    }
    if (failure) {
      request.log.error(
        { auditError: failure, action: entry.action, deviceId: entry.deviceId, outcome: entry.outcome },
        "audit log write failed — the device action itself was unaffected",
      );
    }
  };
}

export async function registerCommandRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const audit = auditor(ctx);

  /** What the UI may offer, and what each will demand before it runs. */
  app.get("/api/commands", async () => {
    const freshness = await ctx.freshness();
    return envelope(
      Object.entries(COMMANDS).map(([name, spec]) => ({
        name,
        label: spec.label,
        risk: spec.risk,
        requiresConfirm: spec.risk !== "read",
        // The one writable dimension, expressed the way callers should send it.
        writableFields: name === "demo_command"
          ? { brightnessPercent: { min: 1, max: 100, label: "Brightness %" } }
          : null,
      })),
      freshness,
    );
  });

  app.post<{ Params: { id: string } }>("/api/devices/:id/command", async (request, reply) => {
    if (!ctx.videri) {
      return reply.code(503).send({
        error: "commands_unavailable",
        message:
          "This server was started without Videri credentials, so it can read our " +
          "datastore but cannot reach a device.",
      });
    }

    const parsed = Body.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const { command, confirm, params: raw } = parsed.data;

    const spec = COMMANDS[command];
    if (!spec) {
      // Logged even though nothing was sent, and logged for EVERY command rather
      // than only the write-risk ones: an attempt to run a verb that is not on
      // the allowlist (su_shell_cmd, android_factory_reset, a firmware install)
      // is the single most important thing this table can contain, and we cannot
      // classify the risk of a command we do not know.
      await audit(request, {
        action: "device_command", verb: command, deviceId: request.params.id,
        outcome: "refused", startedAt: new Date(), durationMs: 0,
        params: raw ?? {},
        detail: { reason: "command_not_allowed" },
        error: `"${command}" is not on the allowlist.`,
      });
      return reply.code(400).send({
        error: "command_not_allowed",
        message:
          `"${command}" is not on the allowlist. Permitted: ` +
          `${Object.keys(COMMANDS).join(", ")}.`,
      });
    }
    if (spec.risk !== "read" && confirm !== true) {
      // The confirm handshake is a normal two-step for the UI, but it is still a
      // caller asking us to change a device, so it is recorded — with its reason,
      // so a reader can tell a handshake apart from a real refusal to act.
      await audit(request, {
        action: "device_command", verb: command, deviceId: request.params.id,
        outcome: "refused", startedAt: new Date(), durationMs: 0,
        params: raw ?? {},
        detail: { reason: "confirmation_required", risk: spec.risk },
      });
      return reply.code(409).send({
        error: "confirmation_required",
        risk: spec.risk,
        message:
          spec.risk === "unverified"
            ? "This command's payload shape is inferred from what ops_get_settings " +
              "returns, not from documentation. Re-send with confirm:true to proceed."
            : "This command changes device state. Re-send with confirm:true to proceed.",
      });
    }

    /**
     * From here on the refusals are logged only for state-CHANGING commands.
     * A read command runs on every drawer open, and filling the audit trail with
     * "we tried to read settings from a device with no JID" would bury the writes
     * it exists to record. Reads change nothing, so they are not audit events.
     */
    const auditable = spec.risk !== "read";

    const device = await ctx.queries.device(request.params.id);
    if (!device) {
      if (auditable) {
        await audit(request, {
          action: "device_command", verb: command, deviceId: request.params.id,
          outcome: "refused", startedAt: new Date(), durationMs: 0,
          params: raw ?? {}, detail: { reason: "device_not_found" },
        });
      }
      return reply.code(404).send({ error: "not_found", message: "No such device." });
    }
    const target = await ctx.repo.commandTarget(request.params.id);
    if (!target || !target.deviceJid) {
      if (auditable) {
        await audit(request, {
          action: "device_command", verb: command, deviceId: request.params.id,
          outcome: "refused", startedAt: new Date(), durationMs: 0,
          params: raw ?? {}, detail: { reason: "not_addressable" },
        });
      }
      return reply.code(409).send({
        error: "not_addressable",
        message: "This device has no XMPP JID recorded, so sync_command cannot address it.",
      });
    }

    let commandParams: Record<string, unknown> = {};
    try {
      commandParams = spec.params ? spec.params(raw ?? {}) : {};
    } catch (error) {
      if (auditable) {
        await audit(request, {
          action: "device_command", verb: command, deviceId: device.id,
          outcome: "refused", startedAt: new Date(), durationMs: 0,
          params: raw ?? {}, detail: { reason: "bad_params" },
          error: (error as Error).message,
        });
      }
      return reply.code(400).send({ error: "bad_params", message: (error as Error).message });
    }

    const startedAt = Date.now();
    try {
      const response = await ctx.videri.request<{
        response_code?: string;
        player_id?: string;
        others?: Record<string, unknown>;
        responses?: Array<{ params?: { response_code?: string } }>;
      }>("messaging", "/messaging/sync_command", {
        method: "POST",
        body: {
          device_id: target.deviceId,
          device_jid: target.deviceJid,
          player_id: target.playerId ?? target.deviceId,
          command_name: command,
          command_params: commandParams,
          message_id: crypto.randomUUID(),
        },
      });

      // The device answering is not the device succeeding. TIME_OUT and
      // DEVICE_OFFLINE both come back as HTTP 200 with a response_code, so the
      // outcome has to be read from the body, never from the status line.
      // The envelope varies: some commands answer at the top level, others nest
      // the code under responses[0].params. Reading only the top level reports a
      // successful command as "NO_RESPONSE_CODE".
      const code =
        response.response_code
        ?? response.responses?.[0]?.params?.response_code
        ?? "NO_RESPONSE_CODE";
      const ok = code === "SUCCESS";

      // A successful settings read is fresh truth about the device — store it so
      // the drawer and compliance immediately reflect what we just learned.
      if (command === "ops_get_settings" && ok) {
        const props = response.others?.["system_properties"];
        if (props && typeof props === "object") {
          await ctx.repo.insertDeviceSettings([
            { deviceId: device.id, deviceClass: device.deviceClass, settings: props },
          ]);
        }
      }

      /**
       * The outcome of a state-changing command, whichever way it went.
       *
       * `observedValue` stays NULL here on purpose: this endpoint sends and
       * reports, it does not read back — only the brightness endpoint below runs
       * a verify cycle. So a SUCCESS is `applied` (the device accepted it) with
       * no observed value, and the audit row says exactly that rather than
       * implying we confirmed anything.
       */
      if (auditable) {
        await audit(request, {
          action: "device_command", verb: command, deviceId: device.id,
          outcome: ok ? "applied" : "failed",
          requestedValue: typeof commandParams["arg"] === "string" ? commandParams["arg"] : null,
          observedValue: null,
          params: commandParams,
          detail: { responseCode: code, risk: spec.risk, verified: false },
          startedAt: new Date(startedAt), durationMs: Date.now() - startedAt,
          error: ok ? null : `The device answered ${code}.`,
        });
      }

      const freshness = await ctx.freshness();
      return reply.code(ok ? 200 : 502).send(
        envelope(
          {
            command,
            risk: spec.risk,
            deviceId: device.id,
            responseCode: code,
            ok,
            durationMs: Date.now() - startedAt,
            /** Echoed so a human can see exactly what was sent. */
            sentParams: commandParams,
            result: response.others ?? null,
          },
          freshness,
        ),
      );
    } catch (error) {
      // A transport failure is still an attempt on a device, and "we tried and
      // could not reach it" is precisely the row a dispute needs.
      if (auditable) {
        await audit(request, {
          action: "device_command", verb: command, deviceId: device.id,
          outcome: "failed",
          requestedValue: typeof commandParams["arg"] === "string" ? commandParams["arg"] : null,
          params: commandParams, detail: { reason: "transport_error", risk: spec.risk },
          startedAt: new Date(startedAt), durationMs: Date.now() - startedAt,
          error: (error as Error).message,
        });
      }
      return reply.code(502).send({
        error: "command_failed",
        message: (error as Error).message,
        command,
        sentParams: commandParams,
        durationMs: Date.now() - startedAt,
      });
    }
  });

  /**
   * Brightness with preflight → write → verify → rollback.
   *
   * Distinct from the generic command endpoint because a brightness write is not
   * fire-and-forget: the device can accept the command (SUCCESS) and ignore it,
   * or half-apply it, and a naive send would report success either way. This
   * endpoint reads the current value first, writes, reads back, and — if the
   * read-back does not match — restores the original. It never leaves the panel
   * at a value nobody chose, and it reports exactly which of those happened.
   *
   * Pattern adopted from the reference integration (docs/13).
   */
  app.post<{ Params: { id: string } }>("/api/devices/:id/brightness", async (request, reply) => {
    if (!ctx.videri) {
      return reply.code(503).send({
        error: "commands_unavailable",
        message: "This server has no Videri credentials, so it cannot reach a device.",
      });
    }
    const body = BrightnessBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    // A write to hardware is deliberate: require an explicit confirm.
    if (body.data.confirm !== true) {
      await audit(request, {
        action: "brightness_write", verb: "set_brightness", deviceId: request.params.id,
        outcome: "refused",
        requestedValue: `${body.data.brightnessPercent}%`,
        detail: { reason: "confirmation_required", mode: body.data.mode },
        startedAt: new Date(), durationMs: 0,
      });
      return reply.code(409).send({
        error: "confirmation_required",
        message: "Writing brightness to a device requires confirm:true.",
      });
    }

    const device = await ctx.queries.device(request.params.id);
    if (!device) {
      await audit(request, {
        action: "brightness_write", verb: "set_brightness", deviceId: request.params.id,
        outcome: "refused", requestedValue: `${body.data.brightnessPercent}%`,
        detail: { reason: "device_not_found", mode: body.data.mode },
        startedAt: new Date(), durationMs: 0,
      });
      return reply.code(404).send({ error: "not_found", message: "No such device." });
    }
    const target = await ctx.repo.commandTarget(request.params.id);
    if (!target || !target.deviceJid) {
      await audit(request, {
        action: "brightness_write", verb: "set_brightness", deviceId: device.id,
        outcome: "refused", requestedValue: `${body.data.brightnessPercent}%`,
        detail: { reason: "not_addressable", mode: body.data.mode },
        startedAt: new Date(), durationMs: 0,
      });
      return reply.code(409).send({
        error: "not_addressable",
        message: "This device has no XMPP JID recorded, so it cannot be commanded.",
      });
    }

    // A CommandRunner bound to this device: one demo_command call → {code, message}.
    const run: CommandRunner = async (arg) => {
      const r = await ctx.videri!.request<{
        response_code?: string; message?: string;
        responses?: Array<{ params?: { response_code?: string } }>;
        others?: unknown;
      }>("messaging", "/messaging/sync_command", {
        method: "POST",
        body: {
          device_id: target.deviceId, device_jid: target.deviceJid,
          player_id: target.playerId ?? target.deviceId,
          command_name: "demo_command", command_params: { arg },
          message_id: crypto.randomUUID(),
        },
      });
      const code = r.response_code ?? r.responses?.[0]?.params?.response_code ?? "UNKNOWN";
      return { code, message: r.message ?? "", others: r.others };
    };

    const startedAt = Date.now();

    // LIVE drag path: fast set + read-back, no rollback. Returns the actual
    // device value so the slider can show the truth, not the request.
    if (body.data.mode === "live") {
      const live = await applyBrightnessLive(device.id, body.data.brightnessPercent, run);
      /**
       * `applied` when the read-back matched, `failed` otherwise. The read-back
       * is the observed value and it is NULL when the device would not tell us —
       * never 0, which on this scale is a display-off panel and would read as a
       * blanked screen we caused.
       */
      await audit(request, {
        action: "brightness_write", verb: "set_brightness", deviceId: device.id,
        outcome: live.applied ? "applied" : "failed",
        requestedValue: `${live.requestedPercent}%`,
        observedValue: live.observedPercent === null ? null : `${live.observedPercent}%`,
        params: { arg: `set_brightness:=${live.requestedRaw}` },
        detail: {
          mode: "live", responseCode: live.code,
          requestedRaw: live.requestedRaw, observedRaw: live.observedRaw,
          /* The drag path never rolls back — recorded so the row is not read as
             a verify cycle that failed to restore anything. */
          rollbackAvailable: false,
        },
        startedAt: new Date(startedAt), durationMs: Date.now() - startedAt,
        error: live.applied
          ? null
          : live.observedRaw === null
            ? `The device answered ${live.code} and its brightness could not be read back.`
            : `The device reports raw ${live.observedRaw}, not the requested ${live.requestedRaw}.`,
      });
      const freshness = await ctx.freshness();
      return reply.code(live.observedRaw === null ? 502 : 200).send(
        envelope({ ...live, durationMs: Date.now() - startedAt }, freshness),
      );
    }

    const result = await applyBrightness(device.id, body.data.brightnessPercent, run);

    /**
     * The audit row for the full cycle. Written for EVERY state, including the
     * ones where the panel was never touched (`preflight_blocked` → refused) and
     * the ones where we put it back (`unconfirmed_rolled_back` → rolled_back):
     * a rollback and a refusal are exactly the events an audit exists for, and
     * `rollback_failed` is the row someone will be paged about.
     */
    await audit(request, {
      action: "brightness_write", verb: "set_brightness", deviceId: device.id,
      outcome: auditOutcomeForBrightness(result.state),
      requestedValue: `${result.requestedPercent}%`,
      observedValue:
        result.observedRaw === null ? null : `${brightnessPercentFromRaw(result.observedRaw)}%`,
      params: { arg: `set_brightness:=${result.requestedRaw}` },
      detail: {
        mode: "verify", state: result.state,
        requestedRaw: result.requestedRaw,
        originalRaw: result.originalRaw,
        observedRaw: result.observedRaw,
        applied: result.applied,
        message: result.message,
      },
      startedAt: new Date(startedAt), durationMs: Date.now() - startedAt,
      /* The cycle's own sentence is the error when the panel did not end up
         where it was asked to; `verified` and `no_change` are not errors. */
      error:
        result.state === "verified" || result.state === "no_change" ? null : result.message,
    });

    const freshness = await ctx.freshness();

    // Map the outcome to a status the client can branch on. Only `verified` is a
    // clean 200; the rollback-failed case is a 500 because a human must look.
    const status =
      result.state === "verified" || result.state === "no_change" ? 200
        : result.state === "preflight_blocked" || result.state === "write_rejected" ? 409
          : result.state === "unconfirmed_rollback_failed" ? 500
            : 502; // unconfirmed_rolled_back — write did not take, but device is safe
    return reply.code(status).send(
      envelope({ ...result, durationMs: Date.now() - startedAt }, freshness),
    );
  });

  /**
   * Runtime telemetry for one device — CPU, memory, signal, NTP, storage — read
   * live from the demo_command shell (see videri/telemetry.ts).
   *
   * This is the slow lane: ~6 device commands, a couple of seconds. It runs on
   * demand (a drawer open), never on the dashboard's hot path, and each field is
   * independently optional — a device that cannot answer one still returns the
   * rest. The result is cached so the fleet health score and a later view can use
   * it without re-commanding.
   */
  app.get<{ Params: { id: string } }>("/api/devices/:id/telemetry", async (request, reply) => {
    if (!ctx.videri) {
      // No device client: serve the last cached reading if we have one.
      const cached = await ctx.repo.latestTelemetry(request.params.id);
      const freshness = await ctx.freshness();
      return cached
        ? envelope({ ...cached, live: false }, freshness)
        : reply.code(503).send({
            error: "telemetry_unavailable",
            message: "This server has no Videri credentials and no cached telemetry.",
          });
    }
    const device = await ctx.queries.device(request.params.id);
    if (!device) return reply.code(404).send({ error: "not_found", message: "No such device." });
    const target = await ctx.repo.commandTarget(request.params.id);
    if (!target || !target.deviceJid) {
      return reply.code(409).send({
        error: "not_addressable",
        message: "This device has no XMPP JID recorded, so it cannot be commanded.",
      });
    }

    const run: TelemetryRunner = async (arg) => {
      const r = await ctx.videri!.request<{
        response_code?: string; message?: string;
        responses?: Array<{ params?: { response_code?: string } }>;
        others?: unknown;
      }>("messaging", "/messaging/sync_command", {
        method: "POST",
        body: {
          device_id: target.deviceId, device_jid: target.deviceJid,
          player_id: target.playerId ?? target.deviceId,
          command_name: "demo_command", command_params: { arg },
          message_id: crypto.randomUUID(),
        },
      });
      const code = r.response_code ?? r.responses?.[0]?.params?.response_code ?? "UNKNOWN";
      return { code, message: r.message ?? "", others: r.others };
    };

    const startedAt = Date.now();
    const telemetry = await readDeviceTelemetry(run);
    // Cache whatever we read, so it survives the drawer close and feeds health.
    await ctx.repo.saveTelemetry(device.id, telemetry).catch(() => {});
    const freshness = await ctx.freshness();
    return envelope(
      { ...telemetry, live: true, observedAt: new Date().toISOString(), durationMs: Date.now() - startedAt },
      freshness,
    );
  });

  /**
   * Network detail for one device — IP address, connected SSID, the latency the
   * device measures itself, and the nearby-Wi-Fi scan (see videri/telemetry.ts).
   *
   * Separate from `/telemetry` on purpose: that endpoint runs on every drawer
   * open and already waits on six device commands, so three more reads for
   * diagnostic detail would tax every operator to serve the few who want it.
   * This one is opt-in.
   *
   * Reads only. The write counterpart on this surface
   * (`set_ethernet_settings`) is not implemented and not reachable from here.
   *
   * Unlike telemetry there is no cached fallback: we do not persist network
   * readings, so with no Videri client the honest answer is 503 rather than a
   * stale IP presented as the current one.
   */
  app.get<{ Params: { id: string } }>("/api/devices/:id/network", async (request, reply) => {
    if (!ctx.videri) {
      return reply.code(503).send({
        error: "network_unavailable",
        message:
          "This server has no Videri credentials, and network readings are read " +
          "live from the device rather than cached.",
      });
    }
    const device = await ctx.queries.device(request.params.id);
    if (!device) return reply.code(404).send({ error: "not_found", message: "No such device." });
    const target = await ctx.repo.commandTarget(request.params.id);
    if (!target || !target.deviceJid) {
      return reply.code(409).send({
        error: "not_addressable",
        message: "This device has no XMPP JID recorded, so it cannot be commanded.",
      });
    }

    // Same construction as the telemetry runner above, with one difference that
    // matters: the payload is taken via `commandMessage`, because the JSON verbs
    // (wm_network, ssid_scan_json) answer in `others.message_json` and leave
    // `message` empty. Reading only `message` reports every one of them as a
    // device that answered SUCCESS with nothing.
    const run: TelemetryRunner = async (arg) => {
      const r = await ctx.videri!.request<{
        response_code?: string; message?: string; others?: Record<string, unknown>;
        responses?: Array<{ params?: { response_code?: string } }>;
      }>("messaging", "/messaging/sync_command", {
        method: "POST",
        body: {
          device_id: target.deviceId, device_jid: target.deviceJid,
          player_id: target.playerId ?? target.deviceId,
          command_name: "demo_command", command_params: { arg },
          message_id: crypto.randomUUID(),
        },
      });
      const code = r.response_code ?? r.responses?.[0]?.params?.response_code ?? "UNKNOWN";
      return { code, message: commandMessage(r) };
    };

    const startedAt = Date.now();
    const network = await readDeviceNetwork(run);
    const freshness = await ctx.freshness();
    // 200 even when nothing answered: `read: []` with all-null fields is the
    // honest report, and it is not an error on our side.
    return envelope(
      { ...network, live: true, observedAt: new Date().toISOString(), durationMs: Date.now() - startedAt },
      freshness,
    );
  });

  /**
   * Verify the platform's black-screen claim against the panel itself.
   *
   * The alert engine raises a CRITICAL "Screen is black" from
   * `health_samples.is_black_screen`. On 2026-09-01 that flag was true in every
   * sample for 25+ minutes on device 1000152 while a fresh screenshot showed a
   * live dashboard and telemetry read CPU 28% / RAM 25% — four devices
   * fleet-wide were in the same state. Restating an upstream flag is not
   * evidence, so this endpoint asks the device (`is_blackscreen`,
   * `is_showing_logo`) and reports whether the two agree.
   *
   * Built exactly like `/telemetry` above — same runner, same gates, same
   * envelope — with two deliberate differences:
   *
   *  - no cached fallback. A verification is worth nothing if half of it is a
   *    stale reading, so with no Videri client the answer is 503, not a guess;
   *  - a silent device is a 200 carrying `verdict: "unanswered"`. That is the
   *    honest outcome of a check that could not be completed, and the one thing
   *    it must never become is a confirmation by default.
   */
  app.get<{ Params: { id: string } }>("/api/devices/:id/screen-check", async (request, reply) => {
    if (!ctx.videri) {
      return reply.code(503).send({
        error: "screen_check_unavailable",
        message:
          "This server has no Videri credentials, so it cannot ask the device " +
          "anything — and a verification made only of our cached copy of the " +
          "platform's claim would verify nothing.",
      });
    }
    const device = await ctx.queries.device(request.params.id);
    if (!device) return reply.code(404).send({ error: "not_found", message: "No such device." });
    const target = await ctx.repo.commandTarget(request.params.id);
    if (!target || !target.deviceJid) {
      return reply.code(409).send({
        error: "not_addressable",
        message: "This device has no XMPP JID recorded, so it cannot be commanded.",
      });
    }

    // A transport failure IS the device not answering, which is precisely what
    // the `unanswered` verdict is for — so it is caught here and reported as
    // silence rather than thrown into a 500 that would hide the platform claim
    // we already have. The reason is kept and surfaced so "we could not ask" is
    // never mistaken for "we asked and it said nothing".
    let transportError: string | null = null;
    const run: TelemetryRunner = async (arg) => {
      try {
        const r = await ctx.videri!.request<{
          response_code?: string; message?: string;
          responses?: Array<{ params?: { response_code?: string } }>;
          others?: unknown;
        }>("messaging", "/messaging/sync_command", {
          method: "POST",
          body: {
            device_id: target.deviceId, device_jid: target.deviceJid,
            player_id: target.playerId ?? target.deviceId,
            command_name: "demo_command", command_params: { arg },
            message_id: crypto.randomUUID(),
          },
        });
        const code = r.response_code ?? r.responses?.[0]?.params?.response_code ?? "UNKNOWN";
        return { code, message: r.message ?? "", others: r.others };
      } catch (error) {
        transportError ??= (error as Error).message;
        return { code: "REQUEST_FAILED", message: "" };
      }
    };

    const startedAt = Date.now();
    const screen = await readScreenState(run);
    const deviceObservedAt = new Date().toISOString();

    // The platform's LATEST claim is the newest status sample we hold — the same
    // row the drawer and the alert engine read, so a verdict here can never
    // disagree with the alert it is explaining.
    const platform = {
      isBlackScreen: device.latest.isBlackScreen,
      showingLogo: device.latest.showingLogo,
      observedAt: device.latest.observedAt,
    };
    const { verdict, detail } = verifyBlackScreenClaim(
      { isBlackScreen: platform.isBlackScreen, observedAt: platform.observedAt },
      { isBlack: screen.isBlack, isShowingLogo: screen.isShowingLogo, observedAt: deviceObservedAt },
    );

    const freshness = await ctx.freshness();
    return envelope(
      {
        platform,
        device: {
          isBlack: screen.isBlack,
          isShowingLogo: screen.isShowingLogo,
          read: screen.read,
          observedAt: deviceObservedAt,
          /** Non-null only when the command could not be sent at all. */
          error: transportError,
        },
        verdict,
        detail,
        durationMs: Date.now() - startedAt,
      },
      freshness,
    );
  });
}
