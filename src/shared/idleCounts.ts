/**
 * Idle-count shapes shared by the AI Proxy panel, the Dev Engine panel and
 * the Spark AutoPower card.
 *
 * The two widgets already poll the bridge every 5 s. AutoPower displays
 * THEIR live numbers (lifted to OverviewPage) instead of re-querying, so the
 * counts on the AutoPower card never lag behind the widgets. AutoPower's
 * shutdown DECISION still runs server-side every 30 s (it must fire even
 * with no browser open) — only the displayed counters come from here.
 */

/** Live AI-proxy idleness as shown by the AI Proxy panel. */
export interface ProxyLive {
  /** False when the panel could not reach the proxy this poll. */
  ok: boolean;
  /** Streaming responses still open. */
  streams: number;
  /** Non-streaming requests still open. */
  requests: number;
  /** Epoch ms of the poll that produced these numbers. */
  at: number;
}

/** Live dev-engine idleness as shown by the Spark Dev Engine panel. */
export interface EngineLive {
  /** False when the panel could not reach the engine this poll. */
  ok: boolean;
  slotsUsed: number;
  ticketsActive: number;
  plansActive: number;
  /** Epoch ms of the poll that produced these numbers. */
  at: number;
}

/** Lifted feed: the two widgets' latest published counts. */
export interface IdleFeed {
  proxy: ProxyLive | null;
  engine: EngineLive | null;
}

/**
 * Mirror of server busyReasons (server/autopower/probe.js) for the LIVE feed.
 * [] = every loaded source reads idle; a not-yet-loaded source is skipped
 * (AutoPower has no data to judge — the server tick is what actually decides).
 */
export function liveBusyReasons(feed: IdleFeed): string[] {
  const reasons: string[] = [];
  const { proxy, engine } = feed;
  if (proxy) {
    if (!proxy.ok) reasons.push("AI proxy unreachable");
    else {
      if (proxy.streams > 0) reasons.push(`${proxy.streams} streaming request(s) in proxy`);
      if (proxy.requests > 0) reasons.push(`${proxy.requests} active request(s) in proxy`);
    }
  }
  if (engine) {
    if (!engine.ok) reasons.push("dev engine unreachable");
    else {
      if (engine.slotsUsed > 0) reasons.push(`${engine.slotsUsed} engine slot(s) in use`);
      if (engine.ticketsActive > 0) reasons.push(`${engine.ticketsActive} ticket(s) in dev engine`);
      if (engine.plansActive > 0) reasons.push(`${engine.plansActive} plan run(s) in dev engine`);
    }
  }
  return reasons;
}

/** True when both sources are loaded, reachable, and read zero. */
export function liveIdleConfirmed(feed: IdleFeed): boolean {
  return (
    feed.proxy != null &&
    feed.engine != null &&
    liveBusyReasons(feed).length === 0 &&
    feed.proxy.ok &&
    feed.engine.ok
  );
}
