/**
 * Energy membership is units with power telemetry. A Raspberry Pi has no
 * measured input power, so including its id would leave the fleet baseline
 * null for every Spark (see FleetEnergyTracker). Keep the filter in one place
 * so the constructor and every membership refresh agree.
 */
export function energyNodeIds(registry) {
  return registry.sparkIds.filter((id) => registry.getSpark(id)?.kind !== "pi");
}
