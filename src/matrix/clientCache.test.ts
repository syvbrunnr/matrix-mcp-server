import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  getCachedClient,
  cacheClient,
  removeCachedClient,
  shutdownAllClients,
  stopCleanupInterval,
  getCacheStats,
} from "./clientCache.js";

function mockClient(syncState: string | null = "SYNCING") {
  return {
    stopClient: () => {},
    getSyncState: () => syncState,
  } as any;
}

import { afterEach } from "@jest/globals";

describe("clientCache", () => {
  beforeEach(() => {
    shutdownAllClients(); // Clear state between tests
  });

  afterEach(() => {
    stopCleanupInterval(); // Prevent open timer from blocking Jest exit
  });

  it("returns null for uncached client", () => {
    expect(getCachedClient("@user:ex.com", "https://ex.com")).toBeNull();
  });

  it("caches and retrieves a client", () => {
    const client = mockClient();
    cacheClient(client, "@user:ex.com", "https://ex.com");

    const retrieved = getCachedClient("@user:ex.com", "https://ex.com");
    expect(retrieved).toBe(client);
  });

  it("returns null for different userId", () => {
    cacheClient(mockClient(), "@alice:ex.com", "https://ex.com");

    expect(getCachedClient("@bob:ex.com", "https://ex.com")).toBeNull();
  });

  it("removes a cached client", () => {
    cacheClient(mockClient(), "@user:ex.com", "https://ex.com");
    removeCachedClient("@user:ex.com", "https://ex.com");

    expect(getCachedClient("@user:ex.com", "https://ex.com")).toBeNull();
  });

  it("evicts client with unhealthy sync state", () => {
    cacheClient(mockClient("STOPPED"), "@user:ex.com", "https://ex.com");

    // Should return null and evict because sync state is STOPPED
    expect(getCachedClient("@user:ex.com", "https://ex.com")).toBeNull();
  });

  it("keeps client with PREPARED sync state", () => {
    const client = mockClient("PREPARED");
    cacheClient(client, "@user:ex.com", "https://ex.com");

    expect(getCachedClient("@user:ex.com", "https://ex.com")).toBe(client);
  });

  it("replaces existing client on re-cache", () => {
    const client1 = mockClient();
    const client2 = mockClient();

    cacheClient(client1, "@user:ex.com", "https://ex.com");
    cacheClient(client2, "@user:ex.com", "https://ex.com");

    expect(getCachedClient("@user:ex.com", "https://ex.com")).toBe(client2);
  });

  it("shutdownAllClients clears all clients", () => {
    cacheClient(mockClient(), "@a:ex.com", "https://ex.com");
    cacheClient(mockClient(), "@b:ex.com", "https://ex.com");

    expect(getCacheStats().size).toBe(2);

    shutdownAllClients();

    expect(getCacheStats().size).toBe(0);
  });

  it("getCacheStats returns correct structure", () => {
    cacheClient(mockClient(), "@user:ex.com", "https://ex.com");

    const stats = getCacheStats();
    expect(stats.size).toBe(1);
    expect(stats.clients[0].userId).toBe("@user:ex.com");
    expect(stats.clients[0].homeserverUrl).toBe("https://ex.com");
    expect(stats.clients[0].lastAccessed).toBeInstanceOf(Date);
  });
});
