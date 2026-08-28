/**
 * Telemetry vocabulary discovery.
 *
 * The single most useful script in this repo right now. Point it at the API with
 * a valid token and it answers the question the documentation cannot: what is
 * actually inside `super_props` and `status`?
 *
 *   npm run build && node --env-file=.env dist/canary/run-discover.js [deviceLimit]
 *
 * Output is a report of every observed key with its type, sample values, and
 * which of our candidate metrics (if any) it matched. Paste the result into
 * docs/ and the whole Health surface stops being guesswork.
 *
 * This runs read-only. It sends no commands and writes nothing to any device.
 */

import { writeFileSync } from "node:fs";
import { VideriAuth } from "../videri/auth.js";
import { VideriHttp } from "../videri/http.js";
import { CanvasService } from "../videri/services/canvas.js";
import type { DiscoveredKey } from "../videri/adapter.js";

const deviceLimit = Number(process.argv[2] ?? 25);

interface KeyReport {
  container: string;
  key: string;
  inferredType: string;
  observations: number;
  samples: unknown[];
}

const registry = new Map<string, KeyReport>();

const sink = (found: DiscoveredKey): void => {
  const id = `${found.container}:${found.key}`;
  const existing = registry.get(id);
  if (existing) {
    existing.observations += 1;
    if (existing.samples.length < 5) existing.samples.push(found.sampleValue);
    return;
  }
  registry.set(id, {
    container: found.container,
    key: found.key,
    inferredType: found.inferredType,
    observations: 1,
    samples: [found.sampleValue],
  });
};

const auth = new VideriAuth();
const http = new VideriHttp(auth);
const canvas = new CanvasService(http, sink);

console.log(`Discovering telemetry vocabulary across up to ${deviceLimit} devices…\n`);

const targets: Array<{ deviceId: string; deviceJid: string | null; name: string | null }> = [];
outer: for await (const page of canvas.listDevices(100)) {
  for (const device of page) {
    if (device.deviceId) {
      targets.push({ deviceId: device.deviceId, deviceJid: device.deviceJid, name: device.name });
    }
    if (targets.length >= deviceLimit) break outer;
  }
}

console.log(`Found ${targets.length} devices with a device_id.\n`);

const rawSamples: unknown[] = [];
let succeeded = 0;

for (const target of targets) {
  try {
    const raw = await canvas.fetchMetrics(target.deviceId);
    if (rawSamples.length < 3) rawSamples.push(raw);
    // Parsing is what populates the sink.
    canvas.toHealthSample(target.deviceId, raw);
    succeeded += 1;
  } catch (error) {
    console.error(`  ! ${target.name ?? target.deviceId}: ${(error as Error).message}`);
  }
}

console.log(`\nRead metrics from ${succeeded}/${targets.length} devices.`);
console.log(`Discovered ${registry.size} distinct telemetry keys.\n`);

const report = [...registry.values()].sort(
  (a, b) => a.container.localeCompare(b.container) || a.key.localeCompare(b.key),
);

for (const entry of report) {
  const samples = entry.samples.map((s) => JSON.stringify(s)).join(", ");
  console.log(
    `  ${entry.container.padEnd(12)} ${entry.key.padEnd(38)} ${entry.inferredType.padEnd(8)} n=${String(entry.observations).padEnd(5)} e.g. ${samples.slice(0, 90)}`,
  );
}

const outPath = "discovered-schema.json";
writeFileSync(
  outPath,
  JSON.stringify(
    { discoveredAt: new Date().toISOString(), devicesSampled: succeeded, keys: report, rawSamples },
    null,
    2,
  ),
);

console.log(`\nWrote ${outPath} (includes ${rawSamples.length} full raw payloads for inspection).`);

if (registry.size === 0) {
  console.log(
    "\nNo keys found. Either super_props/status came back empty for these devices,\n" +
      "or the payload nests them somewhere the adapter is not looking. Inspect the\n" +
      "rawSamples in the output file before concluding the metrics do not exist.",
  );
}
