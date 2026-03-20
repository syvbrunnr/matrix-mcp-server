/**
 * Classifies Matrix errors to determine whether the shared client cache
 * should be evicted. Only auth and sync errors warrant cache eviction —
 * transient errors (rate limits, not-found, conflicts) should NOT destroy
 * the client that other concurrent callers depend on.
 */

const EVICT_PATTERNS = [
  "M_UNKNOWN_TOKEN",
  "M_FORBIDDEN",
  "No access token",
  "initial sync timed out",
];

export function shouldEvictClientCache(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return EVICT_PATTERNS.some((pattern) => msg.includes(pattern));
}

/**
 * Returns a prescriptive diagnostic hint based on the error type.
 * Helps agents self-diagnose by suggesting the right next tool to call.
 */
export function getDiagnosticHint(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (lower.includes("m_forbidden") || lower.includes("forbidden")) {
    return "Check your power level with get-room-members, or verify room membership with list-joined-rooms.";
  }
  if (lower.includes("m_not_found") || lower.includes("not found")) {
    return "Room or resource may not exist. Use list-joined-rooms to see available rooms.";
  }
  if (lower.includes("m_unknown_token") || lower.includes("no access token")) {
    return "Authentication may have expired. Call get-server-health to check sync state.";
  }
  if (lower.includes("encrypted") || lower.includes("olm") || lower.includes("megolm") || lower.includes("crypto")) {
    return "E2EE issue detected. Call get-server-health to check E2EE bootstrap status.";
  }
  if (lower.includes("timeout") || lower.includes("econnrefused") || lower.includes("network")) {
    return "Connection issue. Call get-server-health to check if sync is running.";
  }
  return "Call get-server-health for diagnostics if this persists.";
}
