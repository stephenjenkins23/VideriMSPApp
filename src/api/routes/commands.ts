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
import {
  dedupeDeviceIds, executeBulkApply, planBulkApply,
  BULK_APPLICABLE_ACTIONS, BULK_CONCURRENCY, BULK_MAX_DEVICES,
} from "../../videri/bulk-apply.js";
import { mapSettled } from "../../pipeline/batching.js";
import { recordedIntentByDevice, type SuppressionRecord } from "../../alerting/suppression.js";

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
 * Bulk apply — Epic 8.3. See the route for why the action list has one member.
 *
 * `deviceIds` is validated for shape here and for SIZE in the route, so the
 * over-cap answer can explain the cap instead of reading as a schema violation.
 */
const BulkBrightnessBody = z.object({
  /** Defaulted so the common call is short; still checked against the allowlist. */
  action: z.string().min(1).max(64).default("set_brightness"),
  // 1-100. 0 is display-off and is deliberately not reachable via brightness.
  brightnessPercent: z.coerce.number().int().min(1).max(100),
  deviceIds: z.array(z.string().min(1).max(100)).min(1),
  /** Required to apply. Never required to preview — a dry run touches nothing. */
  confirm: z.boolean().optional(),
  dryRun: z.boolean().default(false),
  /**
   * What the caller believes it is committing to, taken from the dry run a human
   * just approved. Mismatch = refuse the whole batch. Optional.
   */
  expectedAttemptCount: z.coerce.number().int().min(0).optional(),
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

  /**
   * BULK brightness apply — one proven action, many devices (Epic 8.3).
   *
   * `/api/remediation` returns ~283 recommendations that are really a handful of
   * actions: the two largest cohorts are 98 and 90 devices. The correct operator
   * move is one reviewed push; the product offered 98 drawer visits, each firing
   * its own live device reads.
   *
   * Deliberately NOT a generic bulk command proxy. The only verb it will
   * multiply is the brightness write, because it is the only write we hold with
   * a preflight → verify → rollback cycle. `reboot_device` (rejected by the
   * hardware), `power_display` (no documented params contract) and the power
   * schedule / nightly-reboot drifts that motivated this endpoint are all out of
   * scope, and the 400 below says so in words rather than failing obscurely —
   * see videri/bulk-apply.ts for the full reasoning.
   *
   * Every device keeps its own cycle, its own outcome and its own audit row.
   * There is no aggregate verdict: `results` is per device, which is the entire
   * difference between this and "fire 98 writes and hope".
   *
   * Mounted at /api/bulk/... rather than /api/devices/bulk/... so it can never
   * shadow a device whose id happens to be the literal string "bulk".
   */
  app.post("/api/bulk/brightness", async (request, reply) => {
    const parsed = BulkBrightnessBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "bad_request",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const body = parsed.data;

    // The narrow scope, stated at the API surface. Checked as a string against
    // the allowlist rather than as a zod enum so the answer to "why can't I bulk
    // the power schedule?" is this paragraph and not "invalid enum value".
    if (!(BULK_APPLICABLE_ACTIONS as readonly string[]).includes(body.action)) {
      return reply.code(400).send({
        error: "action_not_bulk_applicable",
        message:
          `"${body.action}" cannot be applied in bulk. The only bulk-appliable action is ` +
          `${BULK_APPLICABLE_ACTIONS.join(", ")}, because it is the only write we hold ` +
          `with a preflight → verify → rollback cycle. reboot_device is accepted by the ` +
          `gateway and refused by the hardware; power_display has no documented params ` +
          `contract; and the "Power schedule enabled" / "Nightly reboot enabled" drifts ` +
          `that make this endpoint worth having have no verified write at all, which is ` +
          `why remediation already marks them manual. Apply those through the platform.`,
        bulkAppliableActions: BULK_APPLICABLE_ACTIONS,
      });
    }

    const { ids, duplicatesRemoved } = dedupeDeviceIds(body.deviceIds);
    if (ids.length === 0) {
      return reply.code(400).send({
        error: "bad_request",
        message: "deviceIds contained no usable device id.",
      });
    }
    if (ids.length > BULK_MAX_DEVICES) {
      return reply.code(400).send({
        error: "too_many_devices",
        message:
          `${ids.length} devices requested; the cap is ${BULK_MAX_DEVICES}. The cap exists ` +
          `so a dry run stays short enough for a human to actually read before ` +
          `committing, and so the worst-case batch finishes in a time an operator can ` +
          `wait out. Split the list and review each batch.`,
        cap: BULK_MAX_DEVICES,
        requested: ids.length,
      });
    }

    // A dry run touches nothing, so it does NOT need a device client — a
    // read-only deployment can still show an operator the blast radius. A commit
    // does, and gets the same 503 as every other write path.
    if (!body.dryRun && !ctx.videri) {
      return reply.code(503).send({
        error: "commands_unavailable",
        message: "This server has no Videri credentials, so it cannot reach a device.",
      });
    }

    const now = new Date();
    const [devices, suppressions] = await Promise.all([
      // The SAME projection /api/remediation reads, so the plan can never
      // disagree with the list the operator selected from — and it carries the
      // derived presence status `isReachableStatus` is defined against.
      ctx.queries.remediationDevices(),
      // Active records only; expiry is judged in the pure planner with `now`.
      ctx.repo.listSuppressions(),
    ]);
    const deviceById = new Map(devices.map((d) => [d.id, d]));
    const recordedIntent = recordedIntentByDevice(suppressions, now);
    const suppressionsByDevice = new Map<string, SuppressionRecord[]>();
    for (const record of suppressions) {
      const list = suppressionsByDevice.get(record.deviceId);
      if (list) list.push(record);
      else suppressionsByDevice.set(record.deviceId, [record]);
    }

    /**
     * Addressability, one cheap primary-key lookup per device.
     *
     * If ANY of them fails we abandon the whole request rather than proceed.
     * A database error while building the plan would otherwise be reported as
     * "this device has no JID" — a hundred fabricated refusals from one failed
     * query, which is precisely the kind of confident wrong answer this codebase
     * refuses to give.
     */
    const targets = await mapSettled(ids, 8, async (id) => ({
      id,
      target: await ctx.repo.commandTarget(id),
    }));
    if (targets.failures.length > 0) {
      return reply.code(503).send({
        error: "plan_incomplete",
        message:
          `Could not read addressability for ${targets.failures.length} of ${ids.length} ` +
          `device(s), so the blast radius cannot be computed honestly and nothing was ` +
          `attempted. First error: ${targets.failures[0]!.error.message}`,
      });
    }
    const targetById = new Map(targets.ok.map((t) => [t.id, t.target]));

    const plan = planBulkApply(
      ids.map((id) => {
        const device = deviceById.get(id);
        return {
          deviceId: id,
          device: device ? { name: device.name, status: device.status } : null,
          addressable: Boolean(targetById.get(id)?.deviceJid),
          recordedIntent: recordedIntent.get(id) ?? null,
          suppressions: suppressionsByDevice.get(id) ?? [],
        };
      }),
      now,
    );

    const limits = {
      maxDevices: BULK_MAX_DEVICES,
      concurrency: BULK_CONCURRENCY,
      requiresConfirm: true,
    };

    /**
     * DRY RUN — the blast radius, computed and returned, with nothing touched.
     *
     * No device command, and deliberately NO audit rows: nothing happened to any
     * panel, and 100 rows saying so per preview would bury the writes the log
     * exists to record. This is also how the write path is verified without
     * firing a write.
     */
    if (body.dryRun) {
      const freshness = await ctx.freshness();
      return reply.send(
        envelope(
          {
            dryRun: true,
            action: body.action,
            brightnessPercent: body.brightnessPercent,
            requestedRaw: brightnessRawFromPercent(body.brightnessPercent),
            duplicatesRemoved,
            plan: plan.items,
            counts: plan.counts,
            limits,
            /** False on a read-only deployment: the preview is real, the commit would 503. */
            canCommit: ctx.videri != null,
            note:
              "Nothing was sent to any device and nothing was logged. Re-send with " +
              "dryRun:false and confirm:true to apply, optionally passing " +
              `expectedAttemptCount:${plan.counts.attempt} so the commit is refused if the ` +
              "fleet has changed since this preview.",
          },
          freshness,
        ),
      );
    }

    /**
     * The confirm handshake, mirroring the single-device write.
     *
     * Not audited, and that is a deliberate divergence from the single-device
     * path (which logs its handshake because it is one row): at batch scale the
     * same policy writes up to 100 rows recording that nothing happened. The
     * response carries the counts so the console can show the blast radius on
     * the confirm screen without a second call.
     */
    if (body.confirm !== true) {
      return reply.code(409).send({
        error: "confirmation_required",
        message:
          `This would write brightness to ${plan.counts.attempt} device(s) and refuse ` +
          `${plan.counts.refuse}. A bulk write is the most consequential thing this ` +
          `product does. Re-send with confirm:true, or with dryRun:true to see the ` +
          `per-device blast radius first.`,
        counts: plan.counts,
        limits,
      });
    }

    /**
     * Optional second half of the handshake: the caller states how many devices
     * it expects to be written to, from the dry run it just showed a human. If
     * the fleet has moved since — a device came back online, a suppression
     * lapsed — the commit is refused rather than quietly writing to a set nobody
     * reviewed. Optional so the plain `confirm:true` handshake still works.
     */
    if (
      body.expectedAttemptCount !== undefined &&
      body.expectedAttemptCount !== plan.counts.attempt
    ) {
      return reply.code(409).send({
        error: "plan_changed",
        message:
          `You confirmed ${body.expectedAttemptCount} device(s) but the plan now attempts ` +
          `${plan.counts.attempt}. Nothing was sent. Re-run the dry run and confirm again.`,
        counts: plan.counts,
      });
    }

    const batchId = crypto.randomUUID();
    const actorHeader = request.headers["x-vfi-actor"];
    // Resolved ONCE for the batch: every row carries the same actor because it
    // was the same request, and re-deriving it per device could not disagree
    // without lying about one of them.
    const actor = resolveActor({
      actorHeader: Array.isArray(actorHeader) ? actorHeader[0] : actorHeader,
      authorization: request.headers.authorization,
      allowAnonymous: ctx.allowAnonymous,
    });
    const startedAt = Date.now();

    const batch = await executeBulkApply(plan, body.brightnessPercent, batchId, {
      concurrency: BULK_CONCURRENCY,
      // One runner per device, built from the target we already looked up during
      // planning — no second round trip, and a device that reached this point is
      // known addressable.
      runnerFor: (deviceId) => {
        const target = targetById.get(deviceId)!;
        return async (arg) => {
          const r = await ctx.videri!.request<{
            response_code?: string; message?: string;
            responses?: Array<{ params?: { response_code?: string } }>;
          }>("messaging", "/messaging/sync_command", {
            method: "POST",
            body: {
              device_id: target!.deviceId, device_jid: target!.deviceJid,
              player_id: target!.playerId ?? target!.deviceId,
              command_name: "demo_command", command_params: { arg },
              message_id: crypto.randomUUID(),
            },
          });
          const code = r.response_code ?? r.responses?.[0]?.params?.response_code ?? "UNKNOWN";
          return { code, message: r.message ?? "" };
        };
      },
      /**
       * One audit row per device, tied to the batch by `detail.batchId`.
       *
       * `action` is its own verb (`bulk_brightness_write`) rather than reusing
       * `brightness_write`, so "what did that bulk push do?" is one query the
       * existing audit endpoint already supports — `GET /api/audit?action=
       * bulk_brightness_write&since=…` — and `detail.batchId` says which push.
       * The trade is that a device's brightness history now spans two `action`
       * values; the reviewer note calls this out.
       *
       * This throws on a failed insert ON PURPOSE: `executeBulkApply` catches it
       * per device and records `audited: false`, so a broken audit table costs
       * one honest flag per row and neither stops the batch nor lets a write be
       * reported as logged when it was not.
       */
      record: async (event) => {
        const failure = (await ctx.repo.recordDeviceAction({
          action: "bulk_brightness_write",
          verb: "set_brightness",
          deviceId: event.deviceId,
          outcome: event.outcome,
          requestedValue: `${event.requestedPercent}%`,
          // Honest null: unread stays null and never becomes 0, which on this
          // scale is a display-off panel.
          observedValue:
            event.result && event.result.observedRaw !== null
              ? `${brightnessPercentFromRaw(event.result.observedRaw)}%`
              : null,
          params:
            event.refusedBecause === null
              ? { arg: `set_brightness:=${event.result?.requestedRaw ?? ""}` }
              : {},
          detail: {
            bulk: true,
            batchId: event.batchId,
            batchSize: event.batchSize,
            mode: "verify",
            refusedBecause: event.refusedBecause,
            state: event.result?.state ?? null,
            requestedRaw: event.result?.requestedRaw ?? null,
            originalRaw: event.result?.originalRaw ?? null,
            observedRaw: event.result?.observedRaw ?? null,
            applied: event.result?.applied ?? false,
            message: event.explanation,
          },
          actor,
          actorIp: request.ip ?? null,
          startedAt: event.startedAt,
          durationMs: event.durationMs,
          // `verified` and `no_change` are the only non-error outcomes; a
          // refusal carries its reason here so the row explains itself.
          error:
            event.outcome === "verified" || event.outcome === "no_change"
              ? null
              : event.explanation,
        })).error;
        if (failure) {
          request.log.error(
            { auditError: failure, batchId: event.batchId, deviceId: event.deviceId, outcome: event.outcome },
            "bulk audit row failed — the device outcome itself was unaffected",
          );
          throw new Error(failure);
        }
      },
    });

    if (batch.needsAttention.length > 0) {
      request.log.error(
        { batchId, devices: batch.needsAttention },
        "bulk brightness: rollback could not be confirmed — these panels need a direct check",
      );
    }

    const freshness = await ctx.freshness();
    /**
     * 200 for a batch that RAN, whatever the devices said.
     *
     * There is no aggregate verdict to encode in the status line — that is the
     * point of the endpoint. A single 502 because one of 98 panels timed out
     * would be exactly the "aggregate verdict" this design refuses to produce.
     * The outcome of each device is in its own record, and `counts.byOutcome`
     * keeps `refused` and `failed` apart.
     */
    return reply.send(
      envelope(
        {
          dryRun: false,
          action: body.action,
          duplicatesRemoved,
          ...batch,
          refused: plan.items.filter((i) => i.decision === "refuse"),
          limits,
          durationMs: Date.now() - startedAt,
        },
        freshness,
      ),
    );
  });
}
