/**
 * Network parser tests (docs/14 B3) — `node --test dist/videri/network.test.js`
 *
 * Separate from telemetry.test.ts because these three verbs share one failure
 * mode the CPU/RAM parsers do not: their payloads are JSON with optional,
 * frequently-blank fields, and blind coercion turns a blank into a *flattering*
 * value — 0 dBm is a perfect signal, 0 ms is instant latency. The inputs below
 * are the real shapes captured off a live V4 (evidence/demo-command-reads.txt).
 *
 * Pure functions only. Nothing here reaches a device.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWifiIp, parseWmNetwork, parseSsidScan, readDeviceNetwork, commandMessage,
} from "./telemetry.js";

// The live payloads, verbatim.
const WM_LIVE = '{"message_json":{"ping_ms":-1,"ping_host":"xmpp-go.videri.com","wifi_dbm":-127,'
  + '"wifi_ip":"192.168.183.115","wifi_ssid":"SJWifi","wifi_status":"CONNECTED","cellular":{}}}';
const SCAN_LIVE = '{"message_json":{"networks":['
  + '{"ssid":"SJWifi","security_type":"PSK","signal_strength":-60,"frequency_mhz":5785,'
  + '"saved_creds":true,"enabled":true,"bssid":"f2:9f:11:22:33:44"},'
  + '{"ssid":"Guest","security_type":"NONE","signal_strength":-81,"frequency_mhz":2437}]}}';

// ─── the wire shape ───────────────────────────────────────────────────────────

test("commandMessage finds the payload whichever field the verb answers in", () => {
  // Verified live: string verbs use `message`, JSON verbs use `others` and leave
  // `message` EMPTY. Reading only `message` made wm_network and ssid_scan_json
  // look like devices that answered SUCCESS with nothing.
  assert.equal(commandMessage({ message: "RSSI=-47", others: {} }), "RSSI=-47");
  assert.equal(
    commandMessage({ message: "", others: { message_json: { wifi_ssid: "SJWifi" } } }),
    '{"message_json":{"wifi_ssid":"SJWifi"}}',
  );
  // And the stringified `others` is exactly what parseWmNetwork already accepts.
  const roundTrip = parseWmNetwork(commandMessage({
    message: "", others: { message_json: { wifi_ip: "10.0.0.9", wifi_ssid: "X" } },
  }));
  assert.equal(roundTrip?.wifiIp, "10.0.0.9");
});

test("commandMessage reports genuine silence as an empty string", () => {
  assert.equal(commandMessage({}), "");
  assert.equal(commandMessage({ message: "   ", others: {} }), "");
  assert.equal(commandMessage({ message: "", others: null as unknown as undefined }), "");
});

// ─── wifi_ip ──────────────────────────────────────────────────────────────────

test("parseWifiIp reads the `wifi_ip:=` echo the device actually sends", () => {
  assert.equal(parseWifiIp("wifi_ip:=192.168.183.115"), "192.168.183.115");
  // Bare address, in case a firmware drops the echo.
  assert.equal(parseWifiIp("10.0.4.7"), "10.0.4.7");
  assert.equal(parseWifiIp("  wifi_ip:= 172.16.0.1  "), "172.16.0.1");
});

test("parseWifiIp refuses anything not shaped like an address", () => {
  // The verbs answer with human-readable strings; an error must never be
  // rendered in an "IP address" field.
  assert.equal(parseWifiIp("Invalid path: /storage/sdcard1"), null);
  assert.equal(parseWifiIp(""), null);
  assert.equal(parseWifiIp("wifi_ip:="), null);
  assert.equal(parseWifiIp("wifi_ip:=999.1.1.1"), null, "octets must be in range");
  assert.equal(parseWifiIp("wifi_ip:=192.168.1"), null);
  assert.equal(parseWifiIp("wifi_ip:=0.0.0.0"), null, "0.0.0.0 = no address assigned");
});

// ─── wm_network ───────────────────────────────────────────────────────────────

test("parseWmNetwork reads the live nested message_json", () => {
  const r = parseWmNetwork(WM_LIVE);
  assert.equal(r?.wifiIp, "192.168.183.115");
  assert.equal(r?.wifiSsid, "SJWifi");
  assert.equal(r?.wifiStatus, "CONNECTED");
  assert.equal(r?.wifiDbm, -127, "-127 is the radio's real no-connection statement");
  assert.equal(r?.pingMs, null, "ping_ms:-1 is a failed probe, not 0 ms latency");
});

test("parseWmNetwork accepts a bare object as well as the wrapped one", () => {
  const bare = parseWmNetwork('{"ping_ms":12.5,"wifi_dbm":-48,"wifi_ip":"10.1.2.3","wifi_ssid":"VAP-1","wifi_status":"CONNECTED"}');
  assert.equal(bare?.pingMs, 12.5);
  assert.equal(bare?.wifiDbm, -48);
  assert.equal(bare?.wifiIp, "10.1.2.3");
  assert.equal(bare?.wifiSsid, "VAP-1");
});

test("parseWmNetwork keeps every field independently nullable", () => {
  const r = parseWmNetwork('{"message_json":{"wifi_status":"DISCONNECTED"}}');
  assert.deepEqual(r, {
    pingMs: null, wifiDbm: null, wifiIp: null, wifiSsid: null, wifiStatus: "DISCONNECTED",
  });
});

test("parseWmNetwork does not coerce blanks into flattering zeros", () => {
  // The regression this file exists for: Number("") is 0, so a blank wifi_dbm
  // would report a perfect signal and a blank ping_ms instant latency.
  const r = parseWmNetwork('{"message_json":{"ping_ms":"","wifi_dbm":"","wifi_ip":"","wifi_ssid":"","wifi_status":"  "}}');
  assert.deepEqual(r, {
    pingMs: null, wifiDbm: null, wifiIp: null, wifiSsid: null, wifiStatus: null,
  });
  // Booleans coerce too (Number(true) === 1) — also refused.
  assert.equal(parseWmNetwork('{"ping_ms":true,"wifi_dbm":false}')?.pingMs, null);
  assert.equal(parseWmNetwork('{"ping_ms":true,"wifi_dbm":false}')?.wifiDbm, null);
  // A numeric STRING is a real reading and is accepted.
  assert.equal(parseWmNetwork('{"ping_ms":"31"}')?.pingMs, 31);
});

test("parseWmNetwork returns null for garbage and for some other payload", () => {
  assert.equal(parseWmNetwork("not json"), null);
  assert.equal(parseWmNetwork(""), null);
  assert.equal(parseWmNetwork("[]"), null);
  assert.equal(parseWmNetwork("null"), null);
  assert.equal(parseWmNetwork('"a string"'), null);
  // A valid JSON object with none of the network keys is a different payload,
  // not a device with no network — must not become five confident nulls.
  assert.equal(parseWmNetwork('{"message_json":{"reach":377}}'), null);
  assert.equal(parseWmNetwork("{}"), null);
});

// ─── ssid_scan_json ───────────────────────────────────────────────────────────

test("parseSsidScan reads the live scan, strongest first", () => {
  assert.deepEqual(parseSsidScan(SCAN_LIVE), [
    { ssid: "SJWifi", signalDbm: -60, security: "PSK" },
    { ssid: "Guest", signalDbm: -81, security: "NONE" },
  ]);
});

test("parseSsidScan accepts wrapped, semi-wrapped and bare envelopes", () => {
  const rows = '[{"ssid":"A","signal_strength":-50}]';
  assert.deepEqual(parseSsidScan(rows), [{ ssid: "A", signalDbm: -50, security: null }]);
  assert.deepEqual(parseSsidScan(`{"networks":${rows}}`), [{ ssid: "A", signalDbm: -50, security: null }]);
  assert.deepEqual(parseSsidScan(`{"message_json":${rows}}`), [{ ssid: "A", signalDbm: -50, security: null }]);
  assert.deepEqual(
    parseSsidScan(`{"message_json":{"networks":${rows}}}`),
    [{ ssid: "A", signalDbm: -50, security: null }],
  );
});

test("parseSsidScan collapses the same SSID seen on two bands, keeping the strongest", () => {
  const dual = '{"networks":['
    + '{"ssid":"SJWifi","signal_strength":-72,"frequency_mhz":2437},'
    + '{"ssid":"SJWifi","signal_strength":-58,"frequency_mhz":5785},'
    + '{"ssid":"Other","signal_strength":-65}]}';
  assert.deepEqual(parseSsidScan(dual), [
    { ssid: "SJWifi", signalDbm: -58, security: null },
    { ssid: "Other", signalDbm: -65, security: null },
  ]);
});

test("parseSsidScan drops unnameable rows and never invents a strength", () => {
  const messy = '{"networks":['
    + '{"ssid":"","signal_strength":-40},'          // hidden AP: nothing to show
    + '{"signal_strength":-41},'                    // no ssid key at all
    + '{"ssid":"Weak","signal_strength":""},'       // blank must NOT become 0 dBm
    + '{"ssid":"Strong","signal_strength":-30},'
    + 'null,17]}';
  // Unreadable strength sorts LAST, not first as a 0 dBm would.
  assert.deepEqual(parseSsidScan(messy), [
    { ssid: "Strong", signalDbm: -30, security: null },
    { ssid: "Weak", signalDbm: null, security: null },
  ]);
});

test("parseSsidScan returns [] — never null — for garbage and empty scans", () => {
  assert.deepEqual(parseSsidScan("not json"), []);
  assert.deepEqual(parseSsidScan(""), []);
  assert.deepEqual(parseSsidScan("{}"), []);
  assert.deepEqual(parseSsidScan('{"message_json":{"networks":[]}}'), []);
  assert.deepEqual(parseSsidScan("null"), []);
});

// ─── readDeviceNetwork ────────────────────────────────────────────────────────

test("readDeviceNetwork assembles all three verbs and reports which answered", async () => {
  const run = async (arg: string) => {
    if (arg === "wm_network") return { code: "SUCCESS", message: WM_LIVE };
    if (arg === "wifi_ip") return { code: "SUCCESS", message: "wifi_ip:=192.168.183.115" };
    if (arg === "ssid_scan_json") return { code: "SUCCESS", message: SCAN_LIVE };
    throw new Error(`unexpected verb ${arg}`);
  };
  const n = await readDeviceNetwork(run);
  assert.equal(n.ip, "192.168.183.115");
  assert.equal(n.ssid, "SJWifi");
  assert.equal(n.status, "CONNECTED");
  assert.equal(n.signalDbm, -127);
  assert.equal(n.pingMs, null);
  assert.equal(n.nearby.length, 2);
  assert.equal(n.nearbyIsLastScan, true, "a scan we did not run must say so");
  assert.deepEqual(n.read.sort(), ["ssid_scan_json", "wifi_ip", "wm_network"]);
});

test("readDeviceNetwork is field-independent: wifi_ip alone still yields an IP", async () => {
  // wm_network unsupported, scan refused — the IP read still lands, and nothing
  // that could not be read comes back as a zero.
  const run = async (arg: string) => {
    if (arg === "wifi_ip") return { code: "SUCCESS", message: "wifi_ip:=10.9.9.9" };
    return { code: "ERROR", message: "Unknown command" };
  };
  const n = await readDeviceNetwork(run);
  assert.equal(n.ip, "10.9.9.9");
  assert.equal(n.ssid, null);
  assert.equal(n.pingMs, null);
  assert.equal(n.signalDbm, null, "unread signal is null, not 0 dBm");
  assert.equal(n.status, null);
  assert.deepEqual(n.nearby, []);
  assert.equal(n.nearbyIsLastScan, false);
  assert.deepEqual(n.read, ["wifi_ip"]);
});

test("readDeviceNetwork prefers wm_network's IP but still credits wifi_ip", async () => {
  // One coherent snapshot of the radio beats a separately-timed single field.
  const run = async (arg: string) => {
    if (arg === "wm_network") {
      return { code: "SUCCESS", message: '{"message_json":{"wifi_ip":"10.0.0.1","wifi_ssid":"X","ping_ms":9}}' };
    }
    if (arg === "wifi_ip") return { code: "SUCCESS", message: "wifi_ip:=10.0.0.2" };
    return { code: "ERROR", message: "" };
  };
  const n = await readDeviceNetwork(run);
  assert.equal(n.ip, "10.0.0.1");
  assert.equal(n.pingMs, 9);
  assert.deepEqual(n.read.sort(), ["wifi_ip", "wm_network"]);
});

test("readDeviceNetwork on a device that answers nothing reports nulls, not zeros", async () => {
  const run = async () => ({ code: "TIME_OUT", message: "" });
  const n = await readDeviceNetwork(run);
  assert.deepEqual(n, {
    ip: null, ssid: null, pingMs: null, signalDbm: null, status: null,
    nearby: [], nearbyIsLastScan: false, read: [],
  });
});

test("readDeviceNetwork issues exactly three READ verbs and no write", async () => {
  const seen: string[] = [];
  const run = async (arg: string) => {
    seen.push(arg);
    return { code: "SUCCESS", message: "" };
  };
  await readDeviceNetwork(run);
  assert.deepEqual(seen.sort(), ["ssid_scan_json", "wifi_ip", "wm_network"]);
  // The write counterpart on this surface must never be reachable from a read.
  assert.ok(!seen.some((a) => a.includes("set_ethernet_settings")));
});
