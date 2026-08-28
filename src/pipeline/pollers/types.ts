export interface PollerResult {
  poller: string;
  startedAt: Date;
  durationMs: number;
  devicesTargeted: number;
  rowsWritten: number;
  batchesOk: number;
  batchesFailed: number;
  /** Share of targeted devices where at least one inferred metric resolved. */
  telemetryYield: number | null;
  errors: string[];
}

export const emptyResult = (poller: string, startedAt: Date): PollerResult => ({
  poller,
  startedAt,
  durationMs: 0,
  devicesTargeted: 0,
  rowsWritten: 0,
  batchesOk: 0,
  batchesFailed: 0,
  telemetryYield: null,
  errors: [],
});
