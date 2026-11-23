/** Pure math over one endpoint's bucketed LLM history. Missing readings stay null. */

/** Queue-depth bins used for the queue-vs-decode sweet-spot chart. Half-open: [min, max). */
export const QUEUE_BINS = Object.freeze([
  Object.freeze({ id: "0", label: "0", min: 0, max: 1 }),
  Object.freeze({ id: "1", label: "1", min: 1, max: 2 }),
  Object.freeze({ id: "2", label: "2", min: 2, max: 3 }),
  Object.freeze({ id: "3-4", label: "3–4", min: 3, max: 5 }),
  Object.freeze({ id: "5+", label: "5+", min: 5, max: Infinity }),
]);

/** Decode must keep 90% of baseline; a bin needs 3 buckets to anchor the knee. */
const KNEE_DECODE_RATIO = 0.9;
const MIN_KNEE_BUCKETS = 3;
/** Cache hit rate the savings estimate targets. */
const CACHE_TARGET = 0.9;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function avg(point, name) {
  return num(point?.[name]?.avg);
}

function max(point, name) {
  return num(point?.[name]?.max);
}

function count(point, name) {
  const n = num(point?.[name]?.n);
  return n != null && n > 0 ? n : 0;
}

function total(point, name) {
  const a = avg(point, name);
  const n = count(point, name);
  return a == null || n === 0 ? null : a * n;
}

function perRequest(point, valueSeries, countSeries) {
  const v = total(point, valueSeries);
  const c = total(point, countSeries);
  return v != null && c != null && c > 0 ? v / c : null;
}

function median(values) {
  const xs = values.filter((v) => num(v) != null).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function mean(values) {
  const xs = values.filter((v) => num(v) != null);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round(v, places = 2) {
  if (num(v) == null) return null;
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function binFor(waiting) {
  return QUEUE_BINS.find((b) => waiting >= b.min && waiting < b.max) ?? QUEUE_BINS[QUEUE_BINS.length - 1];
}

export function computeLlmInsights({ points, stepMs = null, live = null }) {
  const buckets = Array.isArray(points) ? points : [];
  if (buckets.length === 0) {
    return {
      available: false,
      reason: "no-history",
      sampleBuckets: 0,
      stepMs,
      queueBins: [],
      knee: null,
      requestTime: null,
      cache: null,
      kv: null,
      mtp: null,
      workload: null,
      timeInState: null,
      insights: [],
    };
  }

  const binRows = new Map(QUEUE_BINS.map((b) => [b.id, []]));
  for (const point of buckets) {
    const waiting = avg(point, "requestsWaiting");
    if (waiting == null) continue;
    binRows.get(binFor(Math.round(waiting)).id)?.push({
      waiting,
      running: avg(point, "requestsRunning"),
      perStream: avg(point, "perStreamTps"),
      gen: avg(point, "genTps"),
      ttft: perRequest(point, "ttftTime", "ttftCount"),
      prefill: perRequest(point, "prefillSeconds", "prefillCount"),
      decode: perRequest(point, "decodeSeconds", "decodeCount"),
      cache: avg(point, "cacheHitRate"),
      kv: avg(point, "kvUsage"),
      efficiency: avg(point, "decodeEfficiency"),
      prefillActive: avg(point, "prefillActive"),
      decodeActive: avg(point, "decodeActive"),
      prefillShare: avg(point, "prefillShare"),
      requests: total(point, "ttftCount") ?? 0,
    });
  }

  const queueBins = QUEUE_BINS.map((bin) => {
    const rows = binRows.get(bin.id) ?? [];
    return {
      id: bin.id,
      label: bin.label,
      buckets: rows.length,
      requests: round(rows.reduce((sum, r) => sum + (num(r.requests) ?? 0), 0), 0),
      waitingMean: round(mean(rows.map((r) => r.waiting))),
      runningMean: round(mean(rows.map((r) => r.running))),
      perStreamTps: round(median(rows.map((r) => r.perStream))),
      genTps: round(median(rows.map((r) => r.gen))),
      ttftSeconds: round(median(rows.map((r) => r.ttft)), 1),
      prefillSeconds: round(median(rows.map((r) => r.prefill)), 1),
      decodeSeconds: round(median(rows.map((r) => r.decode)), 1),
      cacheHitRate: round(mean(rows.map((r) => r.cache)), 3),
      kvUsage: round(mean(rows.map((r) => r.kv)), 3),
      decodeEfficiency: round(mean(rows.map((r) => r.efficiency)), 3),
      prefillActiveFraction: round(mean(rows.map((r) => r.prefillActive)), 3),
      decodeActiveFraction: round(mean(rows.map((r) => r.decodeActive)), 3),
      prefillShare: round(mean(rows.map((r) => r.prefillShare)), 3),
    };
  });

  const populated = queueBins.filter((b) => b.buckets > 0 && b.perStreamTps != null);
  let knee = null;
  if (populated.length > 0) {
    const baseline = populated[0];
    if (baseline.buckets >= MIN_KNEE_BUCKETS && populated.length > 1) {
      let reach = null;
      let collapse = null;
      for (const bin of populated) {
        if (bin.buckets < MIN_KNEE_BUCKETS) break;
        // TTFT/prefill growth is reported separately; the knee is decode-only.
        const decodeOk = bin.perStreamTps >= baseline.perStreamTps * KNEE_DECODE_RATIO;
        if (!decodeOk) {
          collapse = bin;
          break;
        }
        reach = bin;
      }
      knee = {
        waiting: reach?.label ?? baseline.label,
        baselineWaiting: baseline.label,
        baselinePerStreamTps: baseline.perStreamTps,
        baselinePrefillSeconds: baseline.prefillSeconds,
        perStreamTps: reach?.perStreamTps ?? baseline.perStreamTps,
        buckets: reach?.buckets ?? baseline.buckets,
        collapse: collapse
          ? {
              waiting: collapse.label,
              perStreamTps: collapse.perStreamTps,
              ttftSeconds: collapse.ttftSeconds,
              prefillSeconds: collapse.prefillSeconds,
            }
          : null,
      };
    }
  }

  let ttftTotal = 0;
  let ttftCount = 0;
  let prefillTotal = 0;
  let prefillCount = 0;
  let decodeTotal = 0;
  let decodeCount = 0;
  let latencyTotal = 0;
  let latencyCount = 0;
  let tpotTotal = 0;
  let tpotCount = 0;
  for (const point of buckets) {
    const ttft = total(point, "ttftTime");
    const prefill = total(point, "prefillSeconds");
    const decode = total(point, "decodeSeconds");
    const latency = total(point, "latencyTime");
    if (ttft != null) ttftTotal += ttft;
    ttftCount += total(point, "ttftCount") ?? 0;
    if (prefill != null) prefillTotal += prefill;
    prefillCount += total(point, "prefillCount") ?? 0;
    if (decode != null) decodeTotal += decode;
    decodeCount += total(point, "decodeCount") ?? 0;
    if (latency != null) latencyTotal += latency;
    latencyCount += total(point, "latencyCount") ?? 0;
    const tpot = total(point, "tpotTime");
    if (tpot != null) tpotTotal += tpot;
    tpotCount += total(point, "tpotCount") ?? 0;
  }

  let requestTime = null;
  if (latencyCount > 0 || ttftCount > 0) {
    const queueTotal = Math.max(0, ttftTotal - prefillTotal);
    const overheadTotal = Math.max(0, latencyTotal - ttftTotal - decodeTotal);
    const parts = queueTotal + prefillTotal + decodeTotal + overheadTotal;
    const share = (v) => (parts > 0 ? round(v / parts, 3) : null);
    requestTime = {
      requests: latencyCount || ttftCount,
      queueSecondsPerRequest: ttftCount > 0 ? round(queueTotal / ttftCount, 1) : null,
      prefillSecondsPerRequest: prefillCount > 0 ? round(prefillTotal / prefillCount, 1) : null,
      decodeSecondsPerRequest: decodeCount > 0 ? round(decodeTotal / decodeCount, 1) : null,
      ttftSecondsPerRequest: ttftCount > 0 ? round(ttftTotal / ttftCount, 1) : null,
      latencySecondsPerRequest: latencyCount > 0 ? round(latencyTotal / latencyCount, 1) : null,
      queueShare: share(queueTotal),
      prefillShare: share(prefillTotal),
      decodeShare: share(decodeTotal),
      overheadShare: share(overheadTotal),
      meanInterTokenSeconds: tpotCount > 0 ? round(tpotTotal / tpotCount, 4) : null,
      perStreamTpsFromTpot: tpotCount > 0 && tpotTotal > 0 ? round(tpotCount / tpotTotal, 2) : null,
    };
  }

  let promptTotal = 0;
  let cachedTotal = 0;
  let promptSeen = false;
  for (const point of buckets) {
    const prompt = total(point, "promptTokens");
    const cached = total(point, "cachedTokens");
    if (prompt != null) {
      promptTotal += prompt;
      promptSeen = true;
    }
    if (cached != null) cachedTotal += cached;
  }
  const hitRateGauge = mean(buckets.map((p) => avg(p, "cacheHitRate")));
  const hitRate = promptSeen && promptTotal > 0 ? cachedTotal / promptTotal : hitRateGauge;
  const cacheTelemetry = live?.cache?.status ?? null;
  let cache = null;
  if (hitRate != null || promptSeen || cacheTelemetry != null) {
    const savingsFactor =
      hitRate != null && hitRate < CACHE_TARGET && hitRate < 1
        ? (CACHE_TARGET - hitRate) / (1 - hitRate)
        : 0;
    const prefillPerRequest = requestTime?.prefillSecondsPerRequest ?? null;
    cache = {
      hitRate: round(hitRate, 3),
      hitRateGauge: round(hitRateGauge, 3),
      promptTokens: promptSeen ? round(promptTotal, 0) : null,
      cachedTokens: promptSeen ? round(cachedTotal, 0) : null,
      computedTokens: promptSeen ? round(Math.max(0, promptTotal - cachedTotal), 0) : null,
      targetHitRate: CACHE_TARGET,
      prefillSavedPerRequest: round(savingsFactor * (prefillPerRequest ?? 0), 1),
      prefillSavedTotal: round(savingsFactor * prefillTotal, 0),
      telemetry: cacheTelemetry,
    };
  }

  const kvValues = buckets.map((p) => avg(p, "kvUsage"));
  const deviceValues = buckets.map((p) => avg(p, "deviceMemory"));
  let preemptions = 0;
  let preemptionsSeen = false;
  for (const point of buckets) {
    const d = total(point, "preemptions");
    if (d != null) {
      preemptions += d;
      preemptionsSeen = true;
    }
  }
  const kvMean = mean(kvValues);
  const kvMax = Math.max(...kvValues.filter((v) => num(v) != null), Number.NEGATIVE_INFINITY);
  const deviceMean = mean(deviceValues);
  const deviceMax = Math.max(...deviceValues.filter((v) => num(v) != null), Number.NEGATIVE_INFINITY);
  const kv = {
    usageMean: round(kvMean, 3),
    usageMax: num(kvMax) != null && Number.isFinite(kvMax) ? round(kvMax, 3) : null,
    deviceMeanGb: round(deviceMean, 1),
    deviceMaxGb: num(deviceMax) != null && Number.isFinite(deviceMax) ? round(deviceMax, 1) : null,
    preemptions: preemptionsSeen ? round(preemptions, 0) : null,
    clientDisconnections: num(live?.clientDisconnectionsTotal),
  };

  let genTotal = 0;
  let genSeen = false;
  let roundsTotal = 0;
  let roundsSeen = false;
  for (const point of buckets) {
    const gen = total(point, "genTokens");
    if (gen != null) {
      genTotal += gen;
      genSeen = true;
    }
    const rounds = total(point, "decodeRounds");
    if (rounds != null) {
      roundsTotal += rounds;
      roundsSeen = true;
    }
  }
  const acceptanceGauge = mean(buckets.map((p) => avg(p, "mtpAcceptance")));
  const acceptanceLive = num(live?.mtpAcceptanceRate);
  const tokensPerRound =
    roundsSeen && roundsTotal > 0 && genSeen ? genTotal / roundsTotal : null;
  const decodeTps = decodeTotal > 0 && genSeen ? genTotal / decodeTotal : null;
  const mtp = {
    acceptance: round(acceptanceLive ?? acceptanceGauge, 3),
    tokensPerRound: round(tokensPerRound, 2),
    decodeTps: round(decodeTps, 2),
    rounds: roundsSeen ? round(roundsTotal, 0) : null,
  };

  let workload = null;
  if (promptSeen && genSeen) {
    const requests = requestTime?.requests ?? null;
    workload = {
      promptTokens: round(promptTotal, 0),
      completionTokens: round(genTotal, 0),
      promptPerCompletion: genTotal > 0 ? round(promptTotal / genTotal, 1) : null,
      cachedShare: promptTotal > 0 ? round(cachedTotal / promptTotal, 3) : null,
      promptPerRequest: requests ? round(promptTotal / requests, 0) : null,
      outputPerRequest: requests ? round(genTotal / requests, 0) : null,
    };
  }

  const runningValues = buckets.map((p) => avg(p, "requestsRunning"));
  const waitingValues = buckets.map((p) => avg(p, "requestsWaiting"));
  let idleCount = 0;
  let runningSeen = 0;
  for (let i = 0; i < buckets.length; i++) {
    const running = runningValues[i];
    if (num(running) == null) continue;
    runningSeen += 1;
    if (running === 0 && (num(waitingValues[i]) ?? 0) === 0) idleCount += 1;
  }
  const queuedSeen = waitingValues.filter((v) => num(v) != null).length;
  const queuedFlagFraction = mean(buckets.map((p) => avg(p, "queued")));
  const idleFlagFraction = mean(buckets.map((p) => avg(p, "idle")));
  const timeInState = {
    prefillFraction: round(mean(buckets.map((p) => avg(p, "prefillActive"))), 3),
    decodeFraction: round(mean(buckets.map((p) => avg(p, "decodeActive"))), 3),
    queuedFraction: round(
      queuedFlagFraction ??
        (queuedSeen > 0 ? waitingValues.filter((v) => num(v) > 0).length / queuedSeen : null),
      3,
    ),
    idleFraction: round(
      idleFlagFraction ?? (runningSeen > 0 ? idleCount / runningSeen : null),
      3,
    ),
    runningMean: round(mean(runningValues), 2),
    waitingMean: round(mean(waitingValues), 2),
    waitingMax: round(
      Math.max(...waitingValues.filter((v) => num(v) != null), Number.NEGATIVE_INFINITY),
      0,
    ),
  };
  if (timeInState.waitingMax != null && !Number.isFinite(timeInState.waitingMax)) timeInState.waitingMax = null;

  const insights = [];

  if (knee && knee.baselinePerStreamTps != null) {
    const collapsed = knee.collapse && knee.collapse.perStreamTps != null &&
      knee.collapse.perStreamTps < knee.baselinePerStreamTps * 0.7;
    insights.push({
      kind: "queueKnee",
      severity: collapsed ? "warn" : "info",
      params: {
        waiting: knee.waiting,
        baselineWaiting: knee.baselineWaiting,
        baselinePerStreamTps: knee.baselinePerStreamTps,
        perStreamTps: knee.perStreamTps,
        buckets: knee.buckets,
        collapseWaiting: knee.collapse?.waiting ?? null,
        collapsePerStreamTps: knee.collapse?.perStreamTps ?? null,
        collapseTtftSeconds: knee.collapse?.ttftSeconds ?? null,
      },
    });
  }

  const deepestPrefill = [...populated].reverse().find((b) => b.prefillSeconds != null);
  if (
    knee &&
    knee.baselinePrefillSeconds != null &&
    knee.baselinePrefillSeconds > 0 &&
    deepestPrefill?.prefillSeconds != null
  ) {
    const ratio = deepestPrefill.prefillSeconds / knee.baselinePrefillSeconds;
    if (ratio >= 1.5) {
      insights.push({
        kind: "queuePrefill",
        severity: ratio >= 2 ? "warn" : "info",
        params: {
          baselineWaiting: knee.baselineWaiting,
          collapseWaiting: deepestPrefill.label,
          baselinePrefillSeconds: knee.baselinePrefillSeconds,
          collapsePrefillSeconds: deepestPrefill.prefillSeconds,
          ratio: round(ratio, 2),
        },
      });
    }
  }

  if (requestTime) {
    insights.push({
      kind: "requestBreakdown",
      severity:
        (requestTime.queueShare ?? 0) >= 0.4 || (requestTime.prefillShare ?? 0) >= 0.4 ? "warn" : "info",
      params: {
        requests: requestTime.requests,
        queueShare: requestTime.queueShare,
        prefillShare: requestTime.prefillShare,
        decodeShare: requestTime.decodeShare,
        overheadShare: requestTime.overheadShare,
        queueSecondsPerRequest: requestTime.queueSecondsPerRequest,
        prefillSecondsPerRequest: requestTime.prefillSecondsPerRequest,
        decodeSecondsPerRequest: requestTime.decodeSecondsPerRequest,
        ttftSecondsPerRequest: requestTime.ttftSecondsPerRequest,
        latencySecondsPerRequest: requestTime.latencySecondsPerRequest,
      },
    });
  }

  if (cache && cache.hitRate != null && cache.hitRate < 0.8 && cache.prefillSavedPerRequest != null) {
    insights.push({
      kind: "cacheGap",
      severity: cache.hitRate < 0.5 ? "warn" : "info",
      params: {
        hitRate: cache.hitRate,
        targetHitRate: cache.targetHitRate,
        prefillSecondsPerRequest: requestTime?.prefillSecondsPerRequest ?? null,
        prefillSavedPerRequest: cache.prefillSavedPerRequest,
        prefillSavedTotal: cache.prefillSavedTotal,
        cachedTokens: cache.cachedTokens,
        computedTokens: cache.computedTokens,
      },
    });
  }

  if (cache?.telemetry === "unavailable" || live?.cache?.status === "unavailable") {
    insights.push({
      kind: "cacheTelemetryMissing",
      severity: "info",
      params: { reason: live?.cache?.reason ?? null },
    });
  }

  if (
    kv.usageMax != null &&
    (kv.usageMax >= 0.85 || (kv.preemptions != null && kv.preemptions > 0))
  ) {
    insights.push({
      kind: "kvPressure",
      severity:
        kv.preemptions != null && kv.preemptions > 0 ? "warn" : "info",
      params: {
        usageMean: kv.usageMean,
        usageMax: kv.usageMax,
        deviceMaxGb: kv.deviceMaxGb,
        preemptions: kv.preemptions,
      },
    });
  }

  if (mtp.acceptance != null && mtp.tokensPerRound != null) {
    insights.push({
      kind: "mtpEfficiency",
      severity: "info",
      params: {
        acceptance: mtp.acceptance,
        tokensPerRound: mtp.tokensPerRound,
        decodeTps: mtp.decodeTps,
      },
    });
  }

  if (workload && workload.promptPerCompletion != null && workload.promptPerCompletion >= 50) {
    insights.push({
      kind: "longContext",
      severity: "info",
      params: {
        promptPerCompletion: workload.promptPerCompletion,
        promptPerRequest: workload.promptPerRequest,
        outputPerRequest: workload.outputPerRequest,
        cachedShare: workload.cachedShare,
      },
    });
  }

  return {
    available: true,
    reason: null,
    stepMs,
    sampleBuckets: buckets.length,
    queueBins,
    knee,
    requestTime,
    cache,
    kv,
    mtp,
    workload,
    timeInState,
    insights,
  };
}
