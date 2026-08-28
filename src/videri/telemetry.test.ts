/** Telemetry parser tests — `node --test dist/videri/telemetry.test.js` */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMeminfo, parseKeyEqNum, parseRssi, parseChrony, parseProcStat,
  cpuPercentFromDeltas, readDeviceTelemetry,
} from "./telemetry.js";

test("parseMeminfo reads GB total/free and computes used%", () => {
  const r = parseMeminfo("total: 4.00 GB free: 2.16 GB lost: 325.72 MB");
  assert.equal(r?.totalGb, 4);
  assert.equal(r?.freeGb, 2.16);
  assert.equal(r?.usedPercent, 46); // (4-2.16)/4 = 46%
  assert.equal(parseMeminfo("garbage"), null);
});

test("parseKeyEqNum reads free_memory=N", () => {
  assert.equal(parseKeyEqNum("free_memory=18943", "free_memory"), 18943);
  assert.equal(parseKeyEqNum("total_memory=21523", "total_memory"), 21523);
  assert.equal(parseKeyEqNum("nope", "free_memory"), null);
});

test("parseRssi reads dBm including the -127 no-signal sentinel", () => {
  assert.equal(parseRssi("RSSI=-48"), -48);
  assert.equal(parseRssi("RSSI=-127"), -127);
  assert.equal(parseRssi("x"), null);
});

test("parseChrony reads the nested message_json", () => {
  const msg = '{"message_json":{"ref_time_uts":1787923539,"rms_offset_s":0.000248,"ntp_server":"1.2.3.4","reach":377}}';
  const r = parseChrony(msg);
  assert.equal(r?.offsetMs, 0.25);
  assert.equal(r?.reach, 377);
  assert.equal(r?.server, "1.2.3.4");
  assert.equal(parseChrony("not json"), null);
});

test("parseProcStat returns null for the all-zeros TCL case", () => {
  assert.deepEqual(parseProcStat("Proc Stats: 100 0 50 900 0 0 0"), [100, 0, 50, 900, 0, 0, 0]);
  assert.equal(parseProcStat("Proc Stats: 0 0 0 0 0 0 0"), null, "all-zeros = not populated");
  assert.equal(parseProcStat("no match"), null);
});

test("cpuPercentFromDeltas computes busy share between two snapshots", () => {
  // idle+iowait grew by 90 of a total delta of 100 → 10% busy.
  const a = [0, 0, 0, 0, 0, 0, 0];
  const b = [5, 0, 5, 88, 2, 0, 0];
  assert.equal(cpuPercentFromDeltas(a, b), 10);
  // no movement → null, not a divide-by-zero
  assert.equal(cpuPercentFromDeltas(a, a), null);
});

test("readDeviceTelemetry is field-independent: a partial device still yields the rest", async () => {
  // meminfo works; storage errors; rssi works; ntp works; proc_stat all-zeros.
  const run = async (arg: string) => {
    if (arg === "meminfo") return { code: "SUCCESS", message: "total: 4.00 GB free: 1.00 GB" };
    if (arg === "wifi_strength") return { code: "SUCCESS", message: "RSSI=-50" };
    if (arg === "ops_chrony_stats_json") return { code: "SUCCESS", message: '{"message_json":{"rms_offset_s":0.001,"reach":377}}' };
    if (arg === "read_proc_stat") return { code: "SUCCESS", message: "Proc Stats: 0 0 0 0 0 0 0" };
    return { code: "ERROR", message: "Invalid path: /storage/sdcard1" }; // storage
  };
  const t = await readDeviceTelemetry(run);
  assert.equal(t.ramUsedPercent, 75);
  assert.equal(t.rssiDbm, -50);
  assert.equal(t.ntpOffsetMs, 1);
  assert.equal(t.storageUsedPercent, null, "storage errored → null, not zero");
  assert.equal(t.cpuPercent, null, "proc_stat zeros → CPU null");
  assert.deepEqual(t.read.sort(), ["meminfo", "ntp", "wifi_strength"]);
});
