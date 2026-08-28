/**
 * Device discovery.
 *
 * Walks `/canvases` and upserts the registry. Runs on a slow interval — devices
 * are provisioned, not created every minute — but it must run *before* the
 * telemetry pollers, because they poll whatever is in the devices table.
 */

import type { CanvasService } from "../../videri/services/canvas.js";
import type { Repository } from "../../db/repository.js";
import { type PollerResult, emptyResult } from "./types.js";

export async function pollDevices(
  canvas: CanvasService,
  repo: Repository,
  log: (message: string) => void = () => {},
): Promise<PollerResult> {
  const startedAt = new Date();
  const result = emptyResult("devices", startedAt);

  try {
    for await (const page of canvas.listDevices(200)) {
      try {
        const written = await repo.upsertDevices(page);
        result.rowsWritten += written;
        result.devicesTargeted += page.length;
        result.batchesOk += 1;
        log(`  devices: upserted ${page.length} (running total ${result.devicesTargeted})`);
      } catch (error) {
        result.batchesFailed += 1;
        result.errors.push(`upsert page failed: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    // Pagination itself failed — record and let the next tick retry.
    result.errors.push(`listDevices failed: ${(error as Error).message}`);
    result.batchesFailed += 1;
  }

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
