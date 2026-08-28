/**
 * demo_command audit — classify the device's 509-verb shell, execute only reads.
 *
 * `demo_command` with `arg: "help"` returns a self-documenting list of every verb
 * the device understands (see evidence/demo-command-help.txt). This script:
 *
 *   1. re-fetches `help` live so the vocabulary is never stale,
 *   2. classifies each verb from its own description text, and
 *   3. executes ONLY the verbs classified read-only, against ONE device.
 *
 * SAFETY IS THE ENTIRE POINT. The list contains su_shell_cmd, adb_enable,
 * su_firmware_install, android_factory_reset, reset, rollback_firmware,
 * set_ethernet_settings and hundreds of other state-changing or destructive
 * verbs. A verb is executed ONLY when:
 *
 *   - it is on the explicit READ_ALLOW allowlist below (opt-in, not opt-out), AND
 *   - its classification came out "read".
 *
 * Everything else is classified and counted but never sent. The allowlist is
 * hand-audited; classification alone is not trusted to gate execution. Nothing
 * here uses ":=" setter syntax, no argument is ever supplied beyond the bare
 * verb, and the target device id is required on the command line so it can never
 * default to a live customer screen.
 *
 *   npm run audit:demo -- <deviceRowId>          # classify + run reads
 *   npm run audit:demo -- <deviceRowId> --classify-only
 */

import { pool } from "../db/pool.js";
import { VideriAuth } from "../videri/auth.js";
import { config } from "../config.js";

type Risk = "read" | "setter" | "network" | "privileged" | "destructive" | "unknown";

interface Verb {
  name: string;
  description: string;
  risk: Risk;
}

/**
 * The ONLY verbs this script will send. Hand-audited from the help text as
 * pure reads with no argument and no side effect. Opt-in by design: a verb not
 * on this list is never executed, whatever the classifier decides.
 */
const READ_ALLOW = new Set<string>([
  "read_proc_stat", "meminfo", "free_memory", "total_memory", "used_storage",
  "total_storage", "wifi_strength", "wifi_ip", "ntp_time", "battery_stats",
  "list_sensors", "sensor_data", "native_info", "triage_status", "version",
  "su_version", "mac_address", "serial", "uuid", "list_running_processes",
  "list_installed_packages", "list_packages", "list_usb_devices", "list_ssid",
  "ssid_scan_json", "list_gps_providers", "meminfo", "read_proc_stat",
  "wifi_disable", // NOT included — see below; kept out deliberately
  "ops_chrony_stats_json", "power_profile", "prox_detection_info",
  "list_open_ssid", "list_external_commands", "list_undocumented_commands",
  "auto_on_off_get", "show_fs", "used_storage", "wm_network",
]);
// wifi_disable is destructive to connectivity — remove it from the allowlist.
READ_ALLOW.delete("wifi_disable");

/**
 * Classify a verb from its name and description. Order matters: a verb is
 * checked against the most dangerous patterns first, so anything ambiguous
 * lands on the safe (never-executed) side.
 */
function classify(name: string, desc: string): Risk {
  const s = `${name} ${desc}`.toLowerCase();

  // Destructive / irreversible.
  if (/factory[_ ]?reset|\bwipe\b|\berase\b|rollback_firmware|\breset\b(?!_)|forget|delete|remove_|uninstall|quit_canvas|native_crash|service_crash|anr_|allocate_heap|reboot|power_cycle|power_display/.test(s)) {
    return "destructive";
  }
  // Privileged / remote-code / auth surface.
  if (/^su_|shell_cmd|adb|\bssh\b|_key\b|install|firmware|js_cmd|run_app|start_server|write_usb|provision|master|relay_command|save_.*_url|update_factory/.test(s)) {
    return "privileged";
  }
  // Network configuration (state-changing, isolates the device if wrong).
  if (/^set_(ethernet|apn|ntp_server|antenna|ap_mode|data_prefer|wifi)|reset_(ethernet|apn)|select_apn|wifi_enable|wifi_disable|wifi_reconnect|reconnect_xmpp|set_.*network|antenna/.test(s)) {
    return "network";
  }
  // Any other setter.
  if (/^set_|^update_|^add_|^save_|^show_|^play_|^pause_|^resume_|^rotate|^override|^enable|^disable|^select_|^start_|^stop_|^sleep|^wake|^touch|^back_key|^tab_key|^turn_|_set$|_enable$|_disable$|:=/.test(s)
      || /\bsets?\b|\bstarts?\b|\bstops?\b|turn on|turn off|enables?|disables?|injects?/.test(desc.toLowerCase())) {
    return "setter";
  }
  // Reads: returns / gets / lists / prints / scans (without a documented side effect).
  if (/^(returns?|gets?|lists?|prints?|scans?|shows the current|reports?)\b/.test(desc.toLowerCase().trim())
      || /^(list_|read_|get_|show_fs)/.test(name)
      || /\breturns?\b|\bgets?\b/.test(desc.toLowerCase())) {
    return "read";
  }
  return "unknown";
}

function parseHelp(message: string): Verb[] {
  const out: Verb[] = [];
  for (const line of message.split("\n")) {
    const m = /^([a-z0-9_]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const name = m[1]!;
    const description = m[2]!;
    out.push({ name, description, risk: classify(name, description) });
  }
  return out;
}

async function main(): Promise<void> {
  const deviceRowId = process.argv[2];
  const classifyOnly = process.argv.includes("--classify-only");
  if (!deviceRowId || deviceRowId.startsWith("--")) {
    console.error("Usage: npm run audit:demo -- <deviceRowId> [--classify-only]");
    process.exit(2);
  }

  const auth = new VideriAuth();
  const token = await auth.token();
  const base = config.VIDERI_API_BASE;
  const headers = {
    authorization: `Bearer ${token}`,
    "x-tenant": config.VIDERI_TENANT,
    "content-type": "application/json",
    accept: "application/json",
  };

  const dev = (
    await pool.query<{ device_id: string; device_jid: string; player_id: string; name: string }>(
      `SELECT device_id, device_jid, player_id, name FROM devices WHERE id = $1`,
      [deviceRowId],
    )
  ).rows[0];
  if (!dev) {
    console.error(`No device with row id ${deviceRowId}`);
    process.exit(1);
  }

  const send = async (arg: string): Promise<{ code: string; message: string }> => {
    const res = await fetch(`${base}/messaging-websocket/messaging/sync_command`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        device_id: dev.device_id,
        device_jid: dev.device_jid,
        player_id: dev.player_id ?? dev.device_id,
        command_name: "demo_command",
        command_params: { arg },
        message_id: crypto.randomUUID(),
      }),
    });
    const j = (await res.json().catch(() => ({}))) as {
      response_code?: string; message?: string; others?: unknown;
      responses?: Array<{ params?: { response_code?: string } }>;
    };
    const code = j.response_code ?? j.responses?.[0]?.params?.response_code ?? "?";
    // Preserve newlines: `help` is line-delimited and parseHelp splits on "\n".
    // Collapsing whitespace here turned the whole 67 KB catalogue into one
    // unparseable line and yielded zero verbs.
    const message = (j.message ?? JSON.stringify(j.others ?? {})).trim();
    return { code, message };
  };
  const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

  console.log(`Device: ${dev.name} (${dev.device_id})\n`);

  // `help` is itself a device command and can TIME_OUT. Retry a few times, then
  // fall back to the captured vocabulary so classification is never blocked by a
  // transient miss — the verb set is stable across firmware.
  let helpMessage = "";
  for (let attempt = 1; attempt <= 4 && helpMessage.length < 500; attempt++) {
    const help = await send("help");
    if (help.message.length >= 500) helpMessage = help.message;
    else console.log(`  help attempt ${attempt}: ${help.code} (${help.message.length} bytes)`);
  }
  if (helpMessage.length < 500) {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const evidence = join(here, "..", "..", "..", "evidence", "demo-command-help.txt");
    try {
      helpMessage = await readFile(evidence, "utf8");
      console.log(`  live help unavailable — using captured vocabulary (${helpMessage.length} bytes)`);
    } catch {
      console.error("Live help failed and no captured vocabulary found.");
      await pool.end();
      process.exit(1);
    }
  }
  const verbs = parseHelp(helpMessage);

  const counts: Record<Risk, number> = {
    read: 0, setter: 0, network: 0, privileged: 0, destructive: 0, unknown: 0,
  };
  for (const v of verbs) counts[v.risk] += 1;

  console.log(`Parsed ${verbs.length} verbs from live help:`);
  for (const [k, n] of Object.entries(counts)) console.log(`  ${k.padEnd(12)} ${n}`);

  const runnable = verbs.filter((v) => v.risk === "read" && READ_ALLOW.has(v.name));
  console.log(`\n${runnable.length} verbs are BOTH classified read AND on the hand-audited allowlist.`);
  console.log(`${verbs.length - runnable.length} verbs will NOT be executed.\n`);

  if (classifyOnly) {
    // Print the full classification for the record; run nothing.
    for (const risk of ["destructive", "privileged", "network", "setter", "unknown", "read"] as Risk[]) {
      const list = verbs.filter((v) => v.risk === risk).map((v) => v.name);
      console.log(`\n[${risk}] (${list.length})`);
      for (let i = 0; i < list.length; i += 6) console.log("  " + list.slice(i, i + 6).join(", "));
    }
    await pool.end();
    return;
  }

  console.log("=== EXECUTING READ-ONLY VERBS ===");
  const results: Array<{ verb: string; code: string; sample: string }> = [];
  for (const v of Array.from(new Set(runnable.map((r) => r.name)))) {
    const r = await send(v);
    const flat = oneLine(r.message);
    results.push({ verb: v, code: r.code, sample: flat.slice(0, 160) });
    console.log(`── ${v.padEnd(24)} [${r.code}]`);
    if (flat && flat !== "{}") console.log(`   ${flat.slice(0, 160)}`);
  }

  const ok = results.filter((r) => r.code === "SUCCESS").length;
  console.log(`\n${ok}/${results.length} read verbs returned SUCCESS.`);
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
