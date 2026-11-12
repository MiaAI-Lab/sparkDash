// Copyright 2026 Maxrio9. SPDX-License-Identifier: Apache-2.0
import { authHeaders, reportAuthRequired } from "./authToken";

export interface TrainingStage {
  id: string;
  label: string;
  state: "running" | "waiting" | "complete" | "stopped" | "failed" | "unknown";
  completed: number | null;
  total: number | null;
  unit: string | null;
  etaSeconds?: number;
  metrics?: Array<{ label: string; value: number | string | null; unit?: string }>;
}

export interface TrainingSource {
  id: string;
  sparkId: string;
  label: string;
  status: "live" | "stale" | "unavailable";
  reportedAt: number | null;
  stages: Record<"data" | "training" | "evaluation", TrainingStage[]>;
}

export interface TrainingProgress {
  enabled: boolean;
  error: string | null;
  runs: Array<{ id: string; campaign: string; model: string | null; sources: TrainingSource[] }>;
  units: Array<{ sparkId: string; label: string; status: "live" | "unavailable" | "unsupported"; detail?: string }>;
  truncated: boolean;
}

export async function fetchTrainingProgress(signal: AbortSignal): Promise<TrainingProgress> {
  const response = await fetch("/api/training-progress", {
    headers: authHeaders(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });
  if (!response.ok) {
    if (response.status === 401) reportAuthRequired();
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}
