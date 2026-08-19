/**
 * Host used for LLM HTTP (probe, Showcase, DecodeBench, connectivity test).
 *
 * Local Sparks probe loopback: engines like ds4-server (Entrpi/ds4-on-spark
 * via ~/models/ds4f/start.sh) default to `--host 127.0.0.1`, so probing the
 * LAN IP would miss them. Remote Sparks still use lanIp (they must bind a
 * reachable interface or sit behind a tunnel).
 *
 * Requires the dashboard process to share the host network namespace when
 * running in Docker (see docker-compose `network_mode: host`).
 *
 * @param {{ isLocal?: boolean, lanIp?: string } | null | undefined} spark
 * @returns {string}
 */
export function llmProbeHost(spark) {
  if (spark?.isLocal) return "127.0.0.1";
  const ip = spark?.lanIp != null ? String(spark.lanIp).trim() : "";
  return ip;
}
