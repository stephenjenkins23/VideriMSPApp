/**
 * The FleetBundle — the exact data any AI surface is given about the fleet.
 *
 * Extracted as its own type for one reason: **testability**. The brief takes a
 * bundle, not a database connection, so an eval fixture is a plain object and the
 * AI QA suite runs with no Postgres and no live API. Coupling the prompt to a
 * live query would make the AI layer effectively untestable.
 */

import type { FleetContext, FleetOverview, FirmwareDistribution, DeviceSummary, ChangeSince } from "./context.js";

export interface FleetBundle {
  overview: FleetOverview;
  firmware: FirmwareDistribution;
  attention: DeviceSummary[];
  changes: ChangeSince;
}

export async function assembleBundle(fleet: FleetContext, windowHours = 24): Promise<FleetBundle> {
  const [overview, firmware, attention, changes] = await Promise.all([
    fleet.overview(),
    fleet.firmwareDistribution(),
    fleet.devicesNeedingAttention(25),
    fleet.changesSince(windowHours),
  ]);
  return { overview, firmware, attention, changes };
}
