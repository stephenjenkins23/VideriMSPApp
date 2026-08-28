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
 * percentage of 255. Verified 2026-08-28: answered by 0 of 73 online devices in
 * this fleet — a rarely-populated field, not a broken read.
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

/** One demo_command call, already unwrapped. */
export interface TelemetryRunner {
  (arg: string): Promise<{ code: string; message: string }>;
}

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
    const m = parseMeminfo(mem.message);
    if (m) { t.ramUsedPercent = m.usedPercent; t.ramTotalGb = m.totalGb; t.ramFreeGb = m.freeGb; t.read.push("meminfo"); }
  }
  if (ok(free) && ok(total)) {
    const f = parseKeyEqNum(free.message, "free_memory");
    const to = parseKeyEqNum(total.message, "total_memory");
    if (f !== null && to !== null && to > 0) {
      t.storageTotalMb = to;
      t.storageUsedPercent = Math.max(0, Math.min(100, Math.round(((to - f) / to) * 100)));
      t.read.push("storage");
    }
  }
  if (ok(rssi)) {
    const v = parseRssi(rssi.message);
    if (v !== null) { t.rssiDbm = v; t.read.push("wifi_strength"); }
  }
  if (ok(chrony)) {
    const c = parseChrony(chrony.message);
    if (c) { t.ntpOffsetMs = c.offsetMs; t.ntpReach = c.reach; t.ntpServer = c.server; t.read.push("ntp"); }
  }

  // Round 2 — CPU second snapshot, only if the first was usable jiffies.
  const a = ok(cpu1) ? parseProcStat(cpu1.message) : null;
  if (a) {
    await new Promise((r) => setTimeout(r, 800));
    const cpu2 = await run("read_proc_stat");
    const b = ok(cpu2) ? parseProcStat(cpu2.message) : null;
    if (b) { t.cpuPercent = cpuPercentFromDeltas(a, b); if (t.cpuPercent !== null) t.read.push("cpu"); }
  }

  return t;
}
