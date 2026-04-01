import { MatrixClient } from "matrix-js-sdk";

/**
 * Cached Matrix client entry
 */
interface CachedMatrixClient {
  client: MatrixClient;
  lastAccessed: number;
  userId: string;
  homeserverUrl: string;
}

/**
 * Global cache for Matrix clients
 * Key: ${userId}:${homeserverUrl}
 */
const clientCache = new Map<string, CachedMatrixClient>();

/**
 * Cache TTL in milliseconds (15 minutes)
 */
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Cleanup interval in milliseconds (5 minutes)
 */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Generate cache key for a client
 */
function getCacheKey(userId: string, homeserverUrl: string): string {
  return `${userId}:${homeserverUrl}`;
}

/**
 * Clean up expired clients from the cache
 */
function cleanupExpiredClients(): void {
  const now = Date.now();
  for (const [key, cached] of clientCache.entries()) {
    if (now - cached.lastAccessed > CACHE_TTL_MS) {
      console.error(`Cleaning up expired Matrix client for ${cached.userId}`);
      try {
        cached.client.stopClient();
      } catch (error) {
        console.warn(`Error stopping expired client: ${error}`);
      }
      clientCache.delete(key);
    }
  }
}

/**
 * Start periodic cleanup of expired clients
 */
let cleanupInterval: NodeJS.Timeout | null = null;

function startCleanupInterval(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(cleanupExpiredClients, CLEANUP_INTERVAL_MS);
}

/**
 * Stop periodic cleanup (for shutdown)
 */
export function stopCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

/**
 * Get a cached Matrix client or return null if not found/expired
 */
export function getCachedClient(userId: string, homeserverUrl: string): MatrixClient | null {
  startCleanupInterval(); // Ensure cleanup is running
  
  const key = getCacheKey(userId, homeserverUrl);
  const cached = clientCache.get(key);
  
  if (!cached) {
    return null;
  }
  
  // Check if expired
  if (Date.now() - cached.lastAccessed > CACHE_TTL_MS) {
    console.error(`Cached client expired for ${userId}`);
    try {
      cached.client.stopClient();
    } catch (error) {
      console.warn(`Error stopping expired client: ${error}`);
    }
    clientCache.delete(key);
    return null;
  }
  
  // Check sync health: if the client's sync connection is unhealthy (STOPPED, ERROR,
  // RECONNECTING, null), evict it so the caller gets a fresh one. This prevents stale
  // clients from returning null for getRoom() while getRooms() still works from the
  // local store. wait-for-messages already had this check; now all tools benefit.
  // NOTE: Do NOT call stopClient() here — the evicted client may be the autoSync
  // client which still holds event listeners. stopClient() kills the crypto backend
  // permanently (cryptoBackend.stop() is irreversible). Just remove from cache and
  // let the caller create a fresh client. autoSync manages its own client lifecycle.
  const syncState = cached.client.getSyncState();
  if (syncState && syncState !== "SYNCING" && syncState !== "PREPARED") {
    console.error(`Cached client sync unhealthy (${syncState}) for ${userId}, evicting from cache (not stopping)`);
    clientCache.delete(key);
    return null;
  }

  // Update last accessed time
  cached.lastAccessed = Date.now();
  console.error(`Using cached Matrix client for ${userId}`);
  return cached.client;
}

/**
 * Cache a Matrix client
 */
export function cacheClient(client: MatrixClient, userId: string, homeserverUrl: string): void {
  startCleanupInterval(); // Ensure cleanup is running
  
  const key = getCacheKey(userId, homeserverUrl);
  
  // If there's already a cached client, stop it first
  const existing = clientCache.get(key);
  if (existing) {
    try {
      existing.client.stopClient();
    } catch (error) {
      console.warn(`Error stopping existing cached client: ${error}`);
    }
  }
  
  clientCache.set(key, {
    client,
    lastAccessed: Date.now(),
    userId,
    homeserverUrl
  });
  
  console.error(`Cached Matrix client for ${userId}`);
}

/**
 * Touch the cache entry to prevent expiry without health checks.
 * Used by autoSync keepalive — must NEVER call stopClient() because
 * killing the crypto backend is irreversible and breaks E2EE permanently.
 */
export function touchCachedClient(userId: string, homeserverUrl: string): void {
  const key = getCacheKey(userId, homeserverUrl);
  const cached = clientCache.get(key);
  if (cached) {
    cached.lastAccessed = Date.now();
  }
}

/**
 * Remove a specific client from cache (e.g., on error)
 */
export function removeCachedClient(userId: string, homeserverUrl: string): void {
  const key = getCacheKey(userId, homeserverUrl);
  const cached = clientCache.get(key);
  
  if (cached) {
    try {
      cached.client.stopClient();
    } catch (error) {
      console.warn(`Error stopping client during removal: ${error}`);
    }
    clientCache.delete(key);
    console.error(`Removed cached Matrix client for ${userId}`);
  }
}

/**
 * Shutdown all cached clients (for graceful shutdown)
 */
export function shutdownAllClients(): void {
  stopCleanupInterval();
  
  for (const cached of clientCache.values()) {
    try {
      cached.client.stopClient();
    } catch (error) {
      console.warn(`Error stopping client during shutdown: ${error}`);
    }
  }
  
  clientCache.clear();
  console.error("Shutdown all cached Matrix clients");
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { size: number; clients: Array<{ userId: string; homeserverUrl: string; lastAccessed: Date }> } {
  return {
    size: clientCache.size,
    clients: Array.from(clientCache.values()).map(cached => ({
      userId: cached.userId,
      homeserverUrl: cached.homeserverUrl,
      lastAccessed: new Date(cached.lastAccessed)
    }))
  };
}