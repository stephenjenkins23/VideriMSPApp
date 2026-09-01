/**
 * Runtime device telemetry via demo_command.
 *
 * The batch `metrics/fetch_all` payload carries no CPU, memory, signal or NTP —
 * we reported for weeks that this data "does not exist". It does: every value is
 * readable per-device through the demo_command shell (docs/14, B-001/B-003).
 * This module reads and parses it.
 *
 * The catch is shape, not existence: this is a slow lane. Each field is one
 * synchronous device command (~1 s), the outputs are human-readable strings that
 * must be parsed, and some verbs are device-dependent — `read_proc_stat` returns
 * real jiffies on a Canvas V4 but all-zeros on a TCL; `used_storage` errors on
 * devices without an sdcard1. So every field is independently optional: a device
 * that cannot answer one still yields the rest, and a field we cannot read comes
 * back `null`, never zero.
 *
 * The parsers are pure and unit-tested; only `readDeviceTelemetry` does IO.
 */

export interface DeviceTelemetry {
  cpuPercent: number | null;
  ramUsedPercent: number | null;
  ramTotalGb: number | null;
  ramFreeGb: number | null;
  storageUsedPercent: number | null;
  storageTotalMb: number | null;
  rssiDbm: number | null;
  ntpOffsetMs: number | null;
  ntpReach: number | null;
  ntpServer: string | null;
  /** Which verbs answered — so the UI can say "read live" vs "not reported". */
  read: string[];
}

/** `meminfo: total: 4.00 GB free: 2.16 GB ...` → RAM usage. */
export function parseMeminfo(message: string): { totalGb: number; freeGb: number; usedPercent: number } | null {
  const toGb = (v: string, unit: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return NaN;
    return unit.toUpperCase() === "MB" ? n / 1024 : unit.toUpperCase() === "KB" ? n / 1048576 : n;
  };
  const total = /total:\s*([\d.]+)\s*(GB|MB|KB)/i.exec(message);
  const free = /free:\s*([\d.]+)\s*(GB|MB|KB)/i.exec(message);
  if (!total || !free) return null;
  const totalGb = toGb(total[1]!, total[2]!);
  const freeGb = toGb(free[1]!, free[2]!);
  if (!Number.isFinite(totalGb) || !Number.isFinite(freeGb) || totalGb <= 0) return null;
  return {
    totalGb: Math.round(totalGb * 100) / 100,
    freeGb: Math.round(freeGb * 100) / 100,
    usedPercent: Math.max(0, Math.min(100, Math.round(((totalGb - freeGb) / totalGb) * 100))),
  };
}

/** `free_memory=18943` (MB on the main SD → storage, not RAM). */
export function parseKeyEqNum(message: string, key: string): number | null {
  const m = new RegExp(`${key}\\s*=\\s*(-?[\\d.]+)`, "i").exec(message);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** `RSSI=-48` → dBm. -127 means no connection (Wi-Fi radio off / on Ethernet). */
export function parseRssi(message: string): number | null {
  const m = /RSSI\s*=\s*(-?\d+)/i.exec(message);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * ops_chrony_stats_json → {offsetMs, reach, server}.
 *
 * `reach` is chrony's 8-bit reachability register, passed through verbatim:
 * range 0..377 OCTAL (377 = the last 8 polls all succeeded), NOT 0..255. Any UI
 * that surfaces it should render it as N/377 or "n of last 8 polls", never as a
 * percentage of 255.
 *
 * CORRECTION 2026-08-31: we previously recorded "answered by 0 of 73 online
 * devices — a rarely-populated field". That was OUR BUG, not the fleet's. chrony
 * replies with its payload in `others` and an EMPTY `message`, and the runner
 * only forwarded `message`, so every device looked silent. With `commandMessage`
 * routing `others` through, NTP answers on 10 of 10 online devices sampled —
 * offsets 0.03-1.75 ms, reach 377, real upstream servers. A textbook case of
 * concluding "the platform cannot do X" from "the way we asked was wrong".
 */
export function parseChrony(message: string): { offsetMs: number; reach: number | null; server: string | null } | null {
  try {
    const outer = JSON.parse(message) as { message_json?: unknown };
    const j = (outer.message_json ?? outer) as {
      rms_offset_s?: number; reach?: number; ntp_server?: string;
    };
    if (typeof j.rms_offset_s !== "number") return null;
    return {
      offsetMs: Math.round(j.rms_offset_s * 1000 * 100) / 100,
      reach: typeof j.reach === "number" ? j.reach : null,
      server: typeof j.ntp_server === "string" ? j.ntp_server : null,
    };
  } catch {
    return null;
  }
}

/** `Proc Stats: 9117321 320406 7598811 477721247 ...` → the jiffie counters. */
export function parseProcStat(message: string): number[] | null {
  const m = /Proc Stats:\s*([\d\s]+)/i.exec(message);
  if (!m) return null;
  const nums = m[1]!.trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
  if (nums.length < 4) return null;
  // All zeros = the counter is not populated on this device (seen on TCL).
  if (nums.every((n) => n === 0)) return null;
  return nums;
}

/**
 * CPU utilisation from two /proc/stat snapshots.
 *
 * Fields are [user, nice, system, idle, iowait, irq, softirq, ...]. Busy is
 * everything but idle+iowait; utilisation is the busy share of the delta.
 */
export function cpuPercentFromDeltas(a: number[], b: number[]): number | null {
  if (a.length < 4 || b.length < 4) return null;
  const sum = (x: number[]): number => x.reduce((p, c) => p + c, 0);
  const idle = (x: number[]): number => (x[3] ?? 0) + (x[4] ?? 0);
  const totalDelta = sum(b) - sum(a);
  const idleDelta = idle(b) - idle(a);
  if (totalDelta <= 0) return null;
  const busy = 1 - idleDelta / totalDelta;
  return Math.max(0, Math.min(100, Math.round(busy * 100)));
}

/**
 * One demo_command call, already unwrapped.
 *
 * `others` is load-bearing, not optional decoration: every verb that answers in
 * JSON puts its payload there and leaves `message` EMPTY (see commandMessage).
 * A runner that drops it makes those verbs look unsupported.
 */
export interface TelemetryRunner {
  (arg: string): Promise<{ code: string; message: string; others?: unknown }>;
}

/**
 * Normalise one sync_command reply into the string the parsers expect.
 *
 * Verified live 2026-08-31: demo_command answers in TWO shapes, and which one
 * you get depends on the verb.
 *
 *   wifi_strength  → `{response_code:"SUCCESS", message:"RSSI=-47", others:{}}`
 *   wm_network     → `{response_code:"SUCCESS", message:"", others:{message_json:{…}}}`
 *
 * Every verb that answers with JSON puts its payload in `others`, leaving
 * `message` EMPTY. A runner that reads only `message` therefore sees SUCCESS
 * with nothing and reports the field as unreadable — which looks exactly like a
 * device that does not support the verb. Stringifying `others` is safe for the
 * JSON parsers here because they all already accept a `message_json` wrapper.
 */
export const commandMessage = (r: { message?: string; others?: unknown }): string => {
  if (typeof r.message === "string" && r.message.trim() !== "") return r.message;
  const others = r.others;
  if (others !== null && typeof others === "object" && Object.keys(others).length > 0) {
    return JSON.stringify(others);
  }
  return "";
};

const ok = (r: { code: string }): boolean => r.code.toUpperCase() === "SUCCESS";

export async function readDeviceTelemetry(run: TelemetryRunner): Promise<DeviceTelemetry> {
  const t: DeviceTelemetry = {
    cpuPercent: null, ramUsedPercent: null, ramTotalGb: null, ramFreeGb: null,
    storageUsedPercent: null, storageTotalMb: null,
    rssiDbm: null, ntpOffsetMs: null, ntpReach: null, ntpServer: null, read: [],
  };

  // Round 1 — every independent read at once. The device serialises internally,
  // but issuing them concurrently cuts ~6 sequential round-trips to one, taking
  // a ~15 s drawer read down to a few seconds. read_proc_stat is the CPU
  // baseline snapshot; the second snapshot is round 2.
  const [mem, free, total, rssi, chrony, cpu1] = await Promise.all([
    run("meminfo"), run("free_memory"), run("total_memory"),
    run("wifi_strength"), run("ops_chrony_stats_json"), run("read_proc_stat"),
  ]);

  if (ok(mem)) {
    const m = parseMeminfo(commandMessage(mem));
    if (m) { t.ramUsedPercent = m.usedPercent; t.ramTotalGb = m.totalGb; t.ramFreeGb = m.freeGb; t.read.push("meminfo"); }
  }
  if (ok(free) && ok(total)) {
    const f = parseKeyEqNum(commandMessage(free), "free_memory");
    const to = parseKeyEqNum(commandMessage(total), "total_memory");
    if (f !== null && to !== null && to > 0) {
      t.storageTotalMb = to;
      t.storageUsedPercent = Math.max(0, Math.min(100, Math.round(((to - f) / to) * 100)));
      t.read.push("storage");
    }
  }
  if (ok(rssi)) {
    const v = parseRssi(commandMessage(rssi));
    if (v !== null) { t.rssiDbm = v; t.read.push("wifi_strength"); }
  }
  if (ok(chrony)) {
    const c = parseChrony(commandMessage(chrony));
    if (c) { t.ntpOffsetMs = c.offsetMs; t.ntpReach = c.reach; t.ntpServer = c.server; t.read.push("ntp"); }
  }

  // Round 2 — CPU second snapshot, only if the first was usable jiffies.
  const a = ok(cpu1) ? parseProcStat(commandMessage(cpu1)) : null;
  if (a) {
    await new Promise((r) => setTimeout(r, 800));
    const cpu2 = await run("read_proc_stat");
    const b = ok(cpu2) ? parseProcStat(commandMessage(cpu2)) : null;
    if (b) { t.cpuPercent = cpuPercentFromDeltas(a, b); if (t.cpuPercent !== null) t.read.push("cpu"); }
  }

  return t;
}

// ─── network: IP, connected SSID, latency, nearby scan ────────────────────────

/**
 * The network readouts our own UI advertises as "the device can report these"
 * (docs/14 B3). Three READ verbs on the same demo_command shell:
 *
 *   wifi_ip        → `wifi_ip:=192.168.183.115`
 *   wm_network     → the connected-network snapshot, incl. `ping_ms` latency
 *   ssid_scan_json → the device's last scan of nearby networks
 *
 * Kept OFF `readDeviceTelemetry` deliberately. That function is the drawer's hot
 * path and already waits on six commands; IP, SSID and a Wi-Fi scan are
 * diagnostic detail nobody needs on every drawer open, so they get their own
 * opt-in reader and their own endpoint.
 *
 * `set_ethernet_settings:=static_ip|subnet|router|dns1|dns2|iface` is the WRITE
 * counterpart on this surface. It is not implemented, not called and not
 * exposed: a static-IP write to a remote panel whose only route home is the
 * network being reconfigured can strand the device with no way back.
 */

/** One row of a nearby-Wi-Fi scan. */
export interface NearbyNetwork {
  ssid: string;
  /** dBm (negative). null when the row carried no readable strength. */
  signalDbm: number | null;
  /** Verbatim from the device, e.g. "PSK", "NONE". */
  security: string | null;
}

export interface DeviceNetwork {
  ip: string | null;
  /** The CONNECTED ssid, not a scan result. */
  ssid: string | null;
  /** Latency the device measured itself. Never negative — see parseWmNetwork. */
  pingMs: number | null;
  signalDbm: number | null;
  /** Verbatim, e.g. "CONNECTED", so an unexpected state stays legible. */
  status: string | null;
  /**
   * Nearby networks, strongest first. `[]` means "no readable scan" — whether
   * the verb answered at all is in `read`, so an empty list is never mistaken
   * for a confident "there is no Wi-Fi here".
   */
  nearby: NearbyNetwork[];
  /**
   * ssid_scan_json returns the device's LAST scan and carries no timestamp, so a
   * populated `nearby` is a snapshot of unknown age, never a sweep we just ran.
   * The flag exists so the UI does not have to infer that from `read`.
   */
  nearbyIsLastScan: boolean;
  /** Which verbs answered — so the UI can say "read live" vs "not reported". */
  read: string[];
}

/**
 * Honest coercion, same guard as intelligence/proof-of-play.ts. `Number("")` is
 * 0 and `Number(true)` is 1, so blind coercion would turn a BLANK `wifi_dbm`
 * into a perfect 0 dBm signal and a blank `ping_ms` into instant latency —
 * exactly the fake-zero this codebase refuses. Accept only a real number or a
 * non-blank numeric string; everything else stays unread.
 */
const numOrNull = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/**
 * A dotted quad with in-range octets, or null.
 *
 * Strict on purpose: these verbs answer with human-readable strings, and the
 * only thing stopping us from printing `Invalid path: /storage/sdcard1` in an
 * "IP address" field is refusing anything not shaped like an address. `0.0.0.0`
 * is Android's "no address assigned" placeholder — that is a null, not an IP.
 */
const ipOrNull = (v: unknown): string | null => {
  const s = strOrNull(v);
  if (s === null) return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  if (m.slice(1).some((octet) => Number(octet) > 255)) return null;
  return s === "0.0.0.0" ? null : s;
};

/** `wifi_ip:=192.168.183.115` → the address. The `verb:=` echo is optional. */
export function parseWifiIp(message: string): string | null {
  const m = /wifi_ip\s*:?=\s*(\S+)/i.exec(message);
  return ipOrNull(m ? m[1] : message.trim());
}

export interface WmNetwork {
  pingMs: number | null;
  wifiDbm: number | null;
  wifiIp: string | null;
  wifiSsid: string | null;
  wifiStatus: string | null;
}

/**
 * wm_network → the connected-network snapshot.
 *
 * Wrapped in `message_json` on every device we have seen (like
 * ops_chrony_stats_json), but a bare object is accepted too rather than betting
 * the whole read on one envelope.
 *
 * `ping_ms` is -1 when the device's own reachability probe did not answer. A
 * negative latency is a sentinel, not a measurement, so it becomes null — the
 * one thing it must never become is a fast 0 ms.
 *
 * `wifi_dbm` passes through verbatim INCLUDING the -127 no-connection sentinel,
 * matching parseRssi: -127 is a real statement about the radio, not a failed read.
 *
 * The payload also carries `ping_host` and a `cellular` block. Neither is parsed
 * or surfaced: the ping host is an XMPP endpoint and this codebase does not
 * touch XMPP, and no device in this fleet has a modem to report.
 */
export function parseWmNetwork(message: string): WmNetwork | null {
  let payload: unknown;
  try {
    payload = JSON.parse(message);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const outer = payload as Record<string, unknown>;
  const inner = outer["message_json"];
  const j = (inner !== null && typeof inner === "object" && !Array.isArray(inner) ? inner : outer) as
    Record<string, unknown>;

  // An object carrying none of these keys is some OTHER payload, not an empty
  // network reading. Return null so the caller reports "not read" rather than
  // five confident nulls that look like a device with no network.
  const keys = ["ping_ms", "wifi_dbm", "wifi_ip", "wifi_ssid", "wifi_status"];
  if (!keys.some((k) => k in j)) return null;

  const ping = numOrNull(j["ping_ms"]);
  return {
    pingMs: ping !== null && ping >= 0 ? ping : null,
    wifiDbm: numOrNull(j["wifi_dbm"]),
    wifiIp: ipOrNull(j["wifi_ip"]),
    wifiSsid: strOrNull(j["wifi_ssid"]),
    wifiStatus: strOrNull(j["wifi_status"]),
  };
}

/**
 * ssid_scan_json → the nearby networks from the device's last scan.
 *
 * Accepts every envelope we might meet: `{message_json:{networks:[…]}}` (the
 * live shape), `{networks:[…]}`, and a bare array.
 *
 * Returns `[]`, never null: the caller already distinguishes "answered" from
 * "did not answer" with `read`, and an `Array|null` return would push that same
 * question into every consumer for no extra information.
 *
 * Two deliberate reductions:
 *  - the same network answers on 2.4 and 5 GHz, so rows are deduped by SSID
 *    keeping the strongest — a list repeating "SJWifi" three times reads as our
 *    bug, not as the radio's truth;
 *  - rows with no SSID (hidden APs) are dropped, because there is no name to show.
 */
export function parseSsidScan(message: string): NearbyNetwork[] {
  let payload: unknown;
  try {
    payload = JSON.parse(message);
  } catch {
    return [];
  }
  const unwrap = (v: unknown): unknown[] => {
    if (Array.isArray(v)) return v;
    if (v === null || typeof v !== "object") return [];
    const o = v as Record<string, unknown>;
    if (Array.isArray(o["networks"])) return o["networks"];
    if ("message_json" in o) return unwrap(o["message_json"]);
    return [];
  };

  const strongest = new Map<string, NearbyNetwork>();
  for (const row of unwrap(payload)) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const o = row as Record<string, unknown>;
    const ssid = strOrNull(o["ssid"]);
    if (ssid === null) continue;
    const entry: NearbyNetwork = {
      ssid,
      signalDbm: numOrNull(o["signal_strength"] ?? o["signal"] ?? o["rssi"]),
      security: strOrNull(o["security_type"] ?? o["security"]),
    };
    const prior = strongest.get(ssid);
    const stronger = prior === undefined
      || (entry.signalDbm !== null && (prior.signalDbm === null || entry.signalDbm > prior.signalDbm));
    if (stronger) strongest.set(ssid, entry);
  }
  // Strongest first; rows whose strength was unreadable sort last rather than
  // sorting as if they were 0 dBm (which would put them at the top).
  return [...strongest.values()].sort(
    (a, b) => (b.signalDbm ?? -Infinity) - (a.signalDbm ?? -Infinity),
  );
}

/**
 * The opt-in network read. Three commands, ~1 s each, all of them reads that
 * change no device state.
 */
export async function readDeviceNetwork(run: TelemetryRunner): Promise<DeviceNetwork> {
  const n: DeviceNetwork = {
    ip: null, ssid: null, pingMs: null, signalDbm: null, status: null,
    nearby: [], nearbyIsLastScan: false, read: [],
  };

  // Issued together for the same reason round 1 of readDeviceTelemetry is: the
  // device serialises them internally anyway, so concurrency costs nothing and
  // saves two round-trips.
  const [wm, ip, scan] = await Promise.all([
    run("wm_network"), run("wifi_ip"), run("ssid_scan_json"),
  ]);

  if (ok(wm)) {
    const w = parseWmNetwork(commandMessage(wm));
    if (w) {
      n.ip = w.wifiIp;
      n.ssid = w.wifiSsid;
      n.pingMs = w.pingMs;
      n.signalDbm = w.wifiDbm;
      n.status = w.wifiStatus;
      n.read.push("wm_network");
    }
  }
  if (ok(ip)) {
    const v = parseWifiIp(commandMessage(ip));
    // wm_network wins a conflict: it is one coherent snapshot of the radio,
    // where wifi_ip is a second, separately-timed read of one field of it. The
    // verb is still recorded as having answered.
    if (v !== null) { n.ip ??= v; n.read.push("wifi_ip"); }
  }
  if (ok(scan)) {
    // An unparseable body and a genuinely empty scan are indistinguishable here
    // (both parse to []), so we take the conservative reading and report the
    // verb as not having answered. In practice a device that has scanned always
    // sees at least its own AP, so an empty list means "no usable scan data".
    const rows = parseSsidScan(commandMessage(scan));
    if (rows.length > 0) {
      n.nearby = rows;
      n.nearbyIsLastScan = true;
      n.read.push("ssid_scan_json");
    }
  }

  return n;
}
