/**
 * Adapter smoke test — `node --test dist/canary/smoke-adapter.js`
 *
 * Exercises the telemetry adapter against synthetic payloads shaped the way we
 * *believe* Videri's may be. It cannot prove we match the real API — nothing can
 * until we see live data — but it does prove the unit coercion, the graceful
 * degradation, and the ambiguity marking all behave as intended.
 *
 * When the real vocabulary is discovered, replace these fixtures with captured
 * payloads and this becomes a genuine regression test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MetricsAdapter, inferDeviceClass, inferCapabilities, type DiscoveredKey } from "../videri/adapter.js";

test("coerces plausible units and records provenance", () => {
  const adapter = new MetricsAdapter();
  const sample = adapter.toHealthSample("canvas-1", {
    presence: "online",
    is_screen_on: "true",
    is_black_screen: "false",
    ping_quality: 0.92,
    status: { network: { rssi: 62 } },
    super_props: {
      thermal: { soc_temp: 61000 },
      net: { packet_loss: 1.8 },
      uptime: 864_000_000,
      system: { mem_usage: 78.2 },
    },
  });

  assert.equal(sample.temperatureC.value, 61, "milli-degrees scaled to °C");
  assert.equal(sample.wifiSignalDbm.value, -62, "positive RSSI magnitude sign-corrected");
  assert.equal(sample.uptimeSeconds.value, 864_000, "milliseconds scaled to seconds");
  assert.equal(sample.ramPercent.value, 78.2);
  assert.equal(sample.packetLossPercent.value, 1.8);

  assert.equal(sample.presence.value, "online");
  assert.equal(sample.isScreenOn.value, true, 'the string "true" parses as boolean');
  assert.equal(sample.isBlackScreen.value, false);

  assert.equal(sample.temperatureC.provenance.kind, "inferred");
  assert.equal(sample.presence.provenance.kind, "documented");
});

test("missing metrics degrade to unavailable, never to zero", () => {
  const adapter = new MetricsAdapter();
  const sample = adapter.toHealthSample("canvas-2", {
    presence: "online",
    status: {},
    super_props: {},
  });

  // The distinction this test protects: a device at 0% CPU and a device whose
  // CPU we cannot read are different facts. Collapsing them makes the dashboard
  // lie, which is the one failure mode we cannot ship.
  assert.equal(sample.cpuPercent.value, null);
  assert.equal(sample.cpuPercent.provenance.kind, "unavailable");
  assert.notEqual(sample.cpuPercent.value, 0);

  // Documented fields still work when the untyped maps are empty.
  assert.equal(sample.presence.value, "online");
});

test("flags undecidable units instead of guessing", () => {
  const adapter = new MetricsAdapter();
  const sample = adapter.toHealthSample("canvas-3", {
    super_props: { system: { cpu_usage: 0.684 } },
    status: {},
  });

  // 0.684 is either 0.684% or 68.4% and the payload does not say which.
  assert.equal(sample.cpuPercent.value, 0.684, "raw value preserved, not silently scaled");
  assert.ok(sample.cpuPercent.ambiguous, "ambiguity is surfaced, not swallowed");
  assert.match(sample.cpuPercent.ambiguous!, /68\.4%/);
});

test("rejects implausible values rather than rendering nonsense", () => {
  const adapter = new MetricsAdapter();
  const sample = adapter.toHealthSample("canvas-4", {
    super_props: { thermal: { soc_temp: 99_999_999 } },
    status: {},
  });
  assert.equal(sample.temperatureC.value, null);
  assert.equal(sample.temperatureC.provenance.kind, "unavailable");
});

test("reports every unseen key exactly once", () => {
  const found: DiscoveredKey[] = [];
  const adapter = new MetricsAdapter((k) => found.push(k));

  const payload = { super_props: { a: { b: 1 }, c: "x" }, status: { d: true } };
  adapter.toHealthSample("canvas-5", payload);
  adapter.toHealthSample("canvas-5", payload); // second pass must not re-report

  assert.equal(found.length, 3);
  assert.deepEqual(
    found.map((f) => `${f.container}.${f.key}`).sort(),
    ["status.d", "super_props.a.b", "super_props.c"],
  );
  assert.equal(found.find((f) => f.key === "c")?.inferredType, "string");
});

test("device class covers the full live hardware catalogue", () => {
  // All 20 product names retrieved from canvases/field_values (docs/09 Part 1).
  const cases: Array<[string, string]> = [
    ["TCL TMN Series, 55", "tcl"],
    ["TCL TBN Series, 55", "tcl"],
    ["Allsee 43 High Vibrance Advertising Display", "allsee"],
    ["Allsee 22 Android PCAP Touch Screen", "allsee"],
    ["Allsee 23 Stretch Display", "allsee-shelf"],
    ["Allsee 37 Ultra-Wide Stretched Bar Display", "allsee-shelf"],
    ["SparkBridge+", "spark-bridge"],
    ["SparkBridge (2022)", "spark-bridge"],
    ["Spark2 LTE", "canvas"],
    ["Spark5", "canvas"],
    ["SparkQ+", "canvas"],
    ["V4", "canvas"],
    ["VQ", "canvas"],
    // Previously fell through to "unknown" — 34 devices in the live fleet.
    ["The 4", "canvas"],
    ["The 5", "canvas"],
    ["H11.1", "canvas"],
    // Only present among unassigned devices, so absent from field_values.
    ["V3 (v1)", "canvas"],
    ["V5", "canvas"],
    ["V17EE kit", "canvas"],
  ];
  for (const [product, expected] of cases) {
    assert.equal(inferDeviceClass({ product_name: product }), expected, `"${product}"`);
  }
});

test("nothing in the live catalogue classifies as unknown", () => {
  const catalogue = [
    "Allsee 22 Android PCAP Touch Screen", "Allsee 23 Stretch Display",
    "Allsee 37 Ultra-Wide Stretched Bar Display",
    "Allsee 43 Black Outdoor High Brightness Digital Battery A-Board",
    "Allsee 43 High Vibrance Advertising Display",
    "Allsee 43 Ultra High Brightness Window Display",
    "TCL TBN Series, 55", "TCL TMN Series, 43", "TCL TMN Series, 55",
    "Spark2", "Spark2 LTE", "Spark3", "Spark4", "Spark5",
    "SparkBridge", "SparkBridge+", "SparkBridge (2022)", "SparkQ+",
    "H11.1", "The 4",
  ];
  const unknown = catalogue.filter((p) => inferDeviceClass({ product_name: p }) === "unknown");
  assert.deepEqual(unknown, [], "every catalogue entry must classify");
});

test("sub-capabilities are read from the product name", () => {
  const lte = inferCapabilities({ product_name: "Spark2 LTE" });
  assert.equal(lte.cellular, true);

  const aboard = inferCapabilities({
    product_name: "Allsee 43 Black Outdoor High Brightness Digital Battery A-Board",
  });
  assert.equal(aboard.battery, true);
  assert.equal(aboard.outdoor, true);
  assert.equal(aboard.highBrightness, true);

  const touch = inferCapabilities({ product_name: "Allsee 22 Android PCAP Touch Screen" });
  assert.equal(touch.touch, true);

  const plain = inferCapabilities({ product_name: "Spark5" });
  assert.deepEqual(plain,
    { cellular: false, battery: false, touch: false, outdoor: false, highBrightness: false });
});

test("a device with no product name stays unknown rather than being guessed", () => {
  // Nine live devices report no product_name. Inventing a class for them would
  // put them under a compliance template they were never assessed against.
  assert.equal(inferDeviceClass({}), "unknown");
  assert.equal(inferDeviceClass({ product_name: null }), "unknown");
});
