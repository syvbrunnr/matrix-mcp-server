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
