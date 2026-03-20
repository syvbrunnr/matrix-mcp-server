/**
 * Tracks E2EE Phase 2 (SSSS + cross-signing) bootstrap status per user.
 * Phase 1 (Olm/Megolm init) is synchronous and errors propagate normally.
 * Phase 2 runs in the background and can fail silently — this module
 * makes that status queryable so tools can surface it.
 */

export type Phase2State = "pending" | "in_progress" | "complete" | "failed";

interface Phase2Status {
  state: Phase2State;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  retryCount: number;
}

const statusMap = new Map<string, Phase2Status>();

function key(userId: string, homeserverUrl: string): string {
  return `${userId}@${homeserverUrl}`;
}

export function setPhase2Status(userId: string, homeserverUrl: string, state: Phase2State, error?: string): void {
  const k = key(userId, homeserverUrl);
  const existing: Phase2Status = statusMap.get(k) || { state: "pending", retryCount: 0 };
  statusMap.set(k, {
    ...existing,
    state,
    error: state === "failed" ? error : undefined,
    startedAt: state === "in_progress" ? Date.now() : existing.startedAt,
    completedAt: state === "complete" || state === "failed" ? Date.now() : undefined,
  });
}

export function incrementRetry(userId: string, homeserverUrl: string): number {
  const k = key(userId, homeserverUrl);
  const existing = statusMap.get(k) || { state: "pending" as Phase2State, retryCount: 0 };
  existing.retryCount += 1;
  statusMap.set(k, existing);
  return existing.retryCount;
}

export function getPhase2Status(userId: string, homeserverUrl: string): Phase2Status | undefined {
  return statusMap.get(key(userId, homeserverUrl));
}

export function isPhase2Complete(userId: string, homeserverUrl: string): boolean {
  const status = statusMap.get(key(userId, homeserverUrl));
  return status?.state === "complete";
}
