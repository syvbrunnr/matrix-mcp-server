import * as sdk from "matrix-js-sdk";
import { MatrixClient, ClientEvent } from "matrix-js-sdk";
import https from "https";
import fetch from "node-fetch";
import path from "path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { exchangeToken, TokenExchangeConfig } from "../auth/tokenExchange.js";
import { getCachedClient, cacheClient, removeCachedClient } from "./clientCache.js";
import { installIDBAdapter } from "./idb-sqlite-adapter.js";
import { runMigrations } from "./migrations.js";
import { setPhase2Status, incrementRetry } from "./e2eeStatus.js";

// Install SQLite-backed IndexedDB before any crypto init.
// Uses MATRIX_DATA_DIR env var, defaults to .data/ in cwd.
const DATA_DIR = process.env.MATRIX_DATA_DIR ?? path.join(process.cwd(), ".data");
mkdirSync(DATA_DIR, { recursive: true });
runMigrations(DATA_DIR);
installIDBAdapter(DATA_DIR);

/**
 * Configuration for Matrix client creation
 */
export interface MatrixClientConfig {
  homeserverUrl: string;
  userId: string;
  accessToken: string;
  enableOAuth: boolean;
  tokenExchangeConfig?: TokenExchangeConfig;
  enableTokenExchange: boolean;
  syncToken?: string;
}

/**
 * Creates and initializes a Matrix client instance, using cache when possible
 *
 * @param config - Matrix client configuration
 * @returns Promise<MatrixClient> - Initialized Matrix client
 */
export async function createMatrixClient(
  config: MatrixClientConfig
): Promise<MatrixClient> {
  const {
    homeserverUrl,
    userId,
    accessToken,
    enableOAuth,
    tokenExchangeConfig,
    enableTokenExchange,
    syncToken,
  } = config;

  if (!homeserverUrl) {
    throw new Error("Homeserver URL is required to create a Matrix client.");
  }
  if (!userId) {
    throw new Error("User ID is required to create a Matrix client.");
  }

  // Check for cached client first
  const cachedClient = getCachedClient(userId, homeserverUrl);
  if (cachedClient) {
    return cachedClient;
  }

  // No cached client, create a new one
  let matrixAccessToken: string;

  if (enableOAuth && enableTokenExchange) {
    if (!accessToken) {
      throw new Error("Access token is required for OAuth token exchange.");
    }
    if (!tokenExchangeConfig) {
      throw new Error(
        "Token exchange configuration is required for OAuth mode."
      );
    }
    matrixAccessToken = await exchangeToken(tokenExchangeConfig, accessToken);
  } else {
    // In non-OAuth mode, expect a direct Matrix access token
    matrixAccessToken = accessToken;
  }

  const FETCH_TIMEOUT_MS = 15_000;
  const SYNC_FETCH_TIMEOUT_MS = 65_000; // sync long-poll can wait 30s server-side
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  const timedFetch = async (input: any, init?: any) => {
    // Use longer timeout for /sync long-poll requests
    const url = typeof input === "string" ? input : input?.url ?? "";
    const isSync = url.includes("/_matrix/client") && url.includes("/sync");
    const timeoutMs = isSync ? SYNC_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...(init || {}), agent: httpsAgent, signal: controller.signal as any }) as any;
    } catch (err: any) {
      if (isSync) console.error(`[Sync] /sync fetch failed: ${err.message}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  // --- Authentication & Device ID ---
  // When MATRIX_PASSWORD is set (non-OAuth), use password login to get a proper device.
  // The shared-secret registration device ID ("shared_secret_registration") is a Dendrite
  // placeholder that breaks E2EE key distribution — other clients can't query device keys
  // for it. Password login creates a real device with proper key upload.
  const matrixPassword = process.env.MATRIX_PASSWORD;
  const loginStateFile = path.join(DATA_DIR, "login-state.json");
  let deviceId: string | undefined;
  let effectiveAccessToken = matrixAccessToken;

  if (matrixPassword && !enableOAuth) {
    // Try to reuse a previous password-login session (same device, no device accumulation)
    let loginState: { userId: string; deviceId: string; accessToken: string } | null = null;
    try {
      const saved = JSON.parse(readFileSync(loginStateFile, "utf-8"));
      if (saved.userId === userId && saved.deviceId && saved.accessToken) {
        loginState = saved;
      }
    } catch { /* No saved state */ }

    if (loginState) {
      // Verify the saved token is still valid
      try {
        const whoamiRes = await timedFetch(`${homeserverUrl}/_matrix/client/v3/account/whoami`, {
          headers: { Authorization: `Bearer ${loginState.accessToken}` },
        });
        const whoami = await whoamiRes.json() as any;
        if (whoami.user_id === userId) {
          deviceId = loginState.deviceId;
          effectiveAccessToken = loginState.accessToken;
          console.error(`[Auth] Reusing saved login session (device: ${deviceId})`);
        } else {
          loginState = null; // Token valid but wrong user — re-login
        }
      } catch {
        loginState = null; // Token expired or invalid — re-login
        console.error("[Auth] Saved token invalid, will re-login with password");
      }
    }

    if (!loginState) {
      // Fresh password login — creates a real device with proper device ID
      console.error("[Auth] Logging in with password to get proper device ID");
      try {
        const loginRes = await timedFetch(`${homeserverUrl}/_matrix/client/v3/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "m.login.password",
            identifier: { type: "m.id.user", user: userId },
            password: matrixPassword,
          }),
        });
        const loginData = await loginRes.json() as any;
        if (loginData.access_token && loginData.device_id) {
          deviceId = loginData.device_id;
          effectiveAccessToken = loginData.access_token;
          // Persist so we reuse this device on restart
          writeFileSync(loginStateFile, JSON.stringify({
            userId,
            deviceId: loginData.device_id,
            accessToken: loginData.access_token,
          }), { mode: 0o600 });
          console.error(`[Auth] Password login successful (device: ${deviceId})`);
        } else {
          console.error("[Auth] Password login response missing token/device:", loginData);
          // Fall back to existing token
        }
      } catch (e: any) {
        console.error(`[Auth] Password login failed: ${e.message}, falling back to access token`);
      }
    }
  } else {
    // Non-password mode: fetch deviceId from whoami
    try {
      const whoamiRes = await timedFetch(`${homeserverUrl}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${matrixAccessToken}` },
      });
      const whoami = await whoamiRes.json() as any;
      deviceId = whoami.device_id;
    } catch (e: any) {
      console.warn("whoami failed, deviceId unknown:", e.message);
    }
  }

  // Load SSSS recovery key from disk — needed by getSecretStorageKey on second+ runs.
  const recoveryKeyFile = path.join(DATA_DIR, "ssss-recovery-key");
  let cachedRecoveryKey: Uint8Array | undefined = existsSync(recoveryKeyFile)
    ? new Uint8Array(Buffer.from(readFileSync(recoveryKeyFile, "utf-8").trim(), "hex"))
    : undefined;

  const client = sdk.createClient({
    baseUrl: homeserverUrl,
    userId,
    ...(deviceId ? { deviceId } : {}),
    fetchFn: timedFetch,
    cryptoCallbacks: {
      // Supplies the SSSS decryption key when the SDK needs to read/write secrets.
      getSecretStorageKey: async ({ keys }) => {
        if (!cachedRecoveryKey) return null;
        const keyId = Object.keys(keys)[0];
        if (!keyId) return null;
        return [keyId, cachedRecoveryKey];
      },
      // Called after bootstrapSecretStorage creates a new key — cache it immediately.
      cacheSecretStorageKey: (_keyId, _keyInfo, key) => {
        cachedRecoveryKey = key;
      },
    },
  });

  try {
    if (enableOAuth && effectiveAccessToken && enableTokenExchange) {
      // OAuth mode: use token exchange result to login
      const matrixLoginResponse = await client.loginRequest({
        type: "org.matrix.login.jwt",
        token: effectiveAccessToken,
      });
      client.setAccessToken(matrixLoginResponse.access_token);
    } else if (effectiveAccessToken) {
      // Non-OAuth mode: use access token (from password login or env var)
      client.setAccessToken(effectiveAccessToken);
    } else {
      throw new Error("No valid access token available for Matrix client.");
    }

    // Enable E2EE with persistent SQLite-backed crypto store (always-on).
    // Use userId as crypto DB prefix so each user gets their own SQLite file.
    const cryptoDbPrefix = userId.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+/, "");
    await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: cryptoDbPrefix });
    console.error(`[E2EE] Crypto initialised. Device ID: ${client.getDeviceId()}`);

    // Phase 2: SSSS + cross-signing — activated when MATRIX_PASSWORD env var is set.
    // IMPORTANT: Check cross-signing status BEFORE bootstrapping. If the user already
    // has cross-signing (e.g., from Element), creating new keys would reset their
    // identity and break trust with all previously verified devices.
    if (matrixPassword) {
      // Phase 2 runs in the background — don't block client creation.
      // E2EE will become available once bootstrap completes.
      // Status is tracked via e2eeStatus module so tools can query it.
      const runPhase2 = async () => {
      setPhase2Status(userId, homeserverUrl, "in_progress");
      try {
        const crypto = client.getCrypto();
        if (crypto) {
          // Load or generate a recovery key for SSSS.
          // Stored in DATA_DIR/ssss-recovery-key so it survives server restarts.
          let recoveryKeyBytes: Uint8Array;
          if (cachedRecoveryKey) {
            recoveryKeyBytes = cachedRecoveryKey;
            console.error("[E2EE] Using existing SSSS recovery key");
          } else {
            recoveryKeyBytes = new Uint8Array(randomBytes(32));
            writeFileSync(recoveryKeyFile, Buffer.from(recoveryKeyBytes).toString("hex"), { mode: 0o600 });
            cachedRecoveryKey = recoveryKeyBytes;
            console.error("[E2EE] Generated new SSSS recovery key — saved to", recoveryKeyFile);
          }

          const crossSigningStatus = await crypto.getCrossSigningStatus();
          if (crossSigningStatus.privateKeysCachedLocally.masterKey) {
            // Private keys already cached locally from persistent crypto store.
            // No bootstrap needed — this device already has its identity.
            console.error("[E2EE] Cross-signing private keys cached locally, skipping bootstrap");
          } else if (crossSigningStatus.publicKeysOnDevice) {
            // Public keys exist (fetched from server) but private keys not available locally.
            // The user already has cross-signing from another device (e.g., Element).
            // Try to restore private keys from SSSS — do NOT create new ones.
            console.error("[E2EE] Cross-signing exists but private keys not local. Restoring from SSSS...");
            let restored = false;
            try {
              await crypto.bootstrapSecretStorage({
                createSecretStorageKey: async () => ({
                  keyInfo: {},
                  privateKey: recoveryKeyBytes,
                }),
              });
              await crypto.bootstrapCrossSigning({});
              const afterRestore = await crypto.getCrossSigningStatus();
              restored = afterRestore.privateKeysCachedLocally.masterKey;
            } catch (e: any) {
              console.warn("[E2EE] SSSS restore failed:", e.message);
            }
            if (!restored) {
              // SSSS restore didn't work (e.g., recovery key mismatch after migration,
              // or SSSS contains stale keys from old broken bootstrap). Delete stale SSSS
              // account data from server so bootstrapSecretStorage creates fresh without
              // trying to migrate old (undecryptable) secrets.
              console.error("[E2EE] SSSS restore failed. Clearing stale SSSS data then creating fresh.");
              try {
                // Clear the default key pointer and any secret storage keys
                const accountData = client.store.accountData;
                const ssssKeys = Object.keys(accountData || {}).filter(k =>
                  k.startsWith("m.secret_storage.key.") || k === "m.secret_storage.default_key"
                );
                for (const key of ssssKeys) {
                  await (client as any).setAccountData(key, {});
                  console.error(`[E2EE] Cleared stale account data: ${key}`);
                }
                // Also clear cross-signing secrets from SSSS
                for (const secret of ["m.cross_signing.master", "m.cross_signing.self_signing", "m.cross_signing.user_signing"]) {
                  try { await (client as any).setAccountData(secret, {}); } catch (_) {}
                }
              } catch (e: any) {
                console.warn("[E2EE] Failed to clear stale SSSS data:", e.message);
              }
              // Now create fresh cross-signing + SSSS from scratch
              await crypto.bootstrapCrossSigning({
                authUploadDeviceSigningKeys: async (makeRequest) => {
                  await makeRequest({
                    type: "m.login.password",
                    identifier: { type: "m.id.user", user: userId },
                    password: matrixPassword,
                  });
                },
              });
            }
          } else {
            // No cross-signing at all — safe to create new keys for this user.
            console.error("[E2EE] No existing cross-signing, creating new keys");
            await crypto.bootstrapCrossSigning({
              authUploadDeviceSigningKeys: async (makeRequest) => {
                await makeRequest({
                  type: "m.login.password",
                  identifier: { type: "m.id.user", user: userId },
                  password: matrixPassword,
                });
              },
            });
            await crypto.bootstrapSecretStorage({
              createSecretStorageKey: async () => ({
                keyInfo: {},
                privateKey: recoveryKeyBytes,
              }),
            });
          }

          // Verify the local device is cross-signed. bootstrapCrossSigning only
          // signs the device when CREATING new keys — SSSS restore skips this step.
          const myDeviceId = client.getDeviceId();
          if (myDeviceId) {
            const devStatus = await crypto.getDeviceVerificationStatus(userId, myDeviceId);
            if (devStatus && !devStatus.crossSigningVerified) {
              console.error("[E2EE] Device not cross-signed after bootstrap, signing now...");
              // Re-run bootstrap with auth to force device signing
              await crypto.bootstrapCrossSigning({
                authUploadDeviceSigningKeys: async (makeRequest) => {
                  await makeRequest({
                    type: "m.login.password",
                    identifier: { type: "m.id.user", user: userId },
                    password: matrixPassword,
                  });
                },
              });
              const afterSign = await crypto.getDeviceVerificationStatus(userId, myDeviceId);
              console.error("[E2EE] Device cross-signed after fix: %s", afterSign?.crossSigningVerified);
            } else {
              console.error("[E2EE] Device already cross-signed: %s", devStatus?.crossSigningVerified);
            }
          }

          await crypto.checkKeyBackupAndEnable();
          const finalCrossSigningStatus = await crypto.getCrossSigningStatus();
          console.error("[E2EE] Phase 2 complete: cross-signing status: %j", finalCrossSigningStatus);
          setPhase2Status(userId, homeserverUrl, "complete");
          // Write diagnostic file so we can check status without seeing stderr
          const diagPath = path.join(DATA_DIR, "e2ee-diagnostic.json");
          const myDiagDeviceId = client.getDeviceId();
          let diagDevStatus: any = null;
          if (myDiagDeviceId) {
            try {
              diagDevStatus = await crypto.getDeviceVerificationStatus(userId, myDiagDeviceId);
            } catch (e: any) {
              diagDevStatus = { error: e.message };
            }
          }
          writeFileSync(diagPath, JSON.stringify({
            timestamp: new Date().toISOString(),
            userId,
            deviceId: myDiagDeviceId,
            crossSigningStatus: finalCrossSigningStatus,
            deviceVerificationStatus: diagDevStatus,
          }, null, 2));
        } else {
          // No crypto module available — mark as failed
          setPhase2Status(userId, homeserverUrl, "failed", "Crypto module not available");
        }
      } catch (e: any) {
        console.error("[E2EE] Phase 2 bootstrap failed:", e.message);
        setPhase2Status(userId, homeserverUrl, "failed", e.message);
        const diagPath = path.join(DATA_DIR, "e2ee-diagnostic.json");
        writeFileSync(diagPath, JSON.stringify({
          timestamp: new Date().toISOString(),
          phase2Error: e.message,
          stack: e.stack?.split("\n").slice(0, 5),
        }, null, 2));
      }
      };

      // Run Phase 2 with retry: if it fails, retry once after 5 seconds.
      // More room state may be available after initial sync completes.
      const MAX_RETRIES = 1;
      runPhase2().catch(async () => {
        const retryNum = incrementRetry(userId, homeserverUrl);
        if (retryNum <= MAX_RETRIES) {
          console.error(`[E2EE] Retrying Phase 2 bootstrap (attempt ${retryNum + 1}) in 5s...`);
          await new Promise(r => setTimeout(r, 5000));
          runPhase2().catch(() => {
            console.error("[E2EE] Phase 2 retry failed. E2EE may be degraded for this user.");
          });
        }
      });
    }

    // Resume from a persisted sync token so /sync starts from exactly where we left off.
    if (syncToken) {
      client.store.setSyncToken(syncToken);
      console.error(`[Sync] Resuming from stored sync token`);
    }

    // pollTimeout: server-side /sync long-poll timeout. Default is 30s, but reverse
    // proxies often have short idle timeouts that race with it. 10s is conservative
    // but ensures the /sync response arrives before any proxy kills the connection.
    await client.startClient({ initialSyncLimit: 20, pollTimeout: 10_000 });

    // Wait for the initial sync to complete (with 30s timeout to prevent indefinite hangs)
    const SYNC_TIMEOUT_MS = 30_000;
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        client.once(ClientEvent.Sync, (state) => {
          if (state === "PREPARED") resolve();
          else reject(new Error(`Sync failed with state: ${state}`));
        });
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Matrix initial sync timed out after ${SYNC_TIMEOUT_MS / 1000}s`)), SYNC_TIMEOUT_MS)
      ),
    ]);

    // Set presence to online so other users can see the bot is active.
    // The homeserver automatically marks offline when /sync stops (e.g., laptop closed).
    try {
      await client.setPresence({ presence: "online" });
    } catch (_) {
      // Presence may not be supported by all homeservers (e.g., Dendrite)
    }

    // Clean up stale devices: any device that isn't our current active device
    // has wrong/old crypto keys and confuses other clients' Megolm key sharing
    // (they send session keys to the ghost device instead of the real one).
    // Delete all non-current devices on startup so only one device remains.
    if (deviceId && matrixPassword) {
      try {
        const devices = await client.getDevices();
        const staleDevices = (devices?.devices || [])
          .filter((d: any) => d.device_id !== deviceId);
        for (const stale of staleDevices) {
          try {
            await client.deleteDevice(stale.device_id, {
              type: "m.login.password",
              identifier: { type: "m.id.user", user: userId },
              password: matrixPassword,
            });
            console.error(`[Auth] Deleted stale device: ${stale.device_id}`);
          } catch (delErr: any) {
            console.error(`[Auth] Failed to delete stale device ${stale.device_id}: ${delErr.message}`);
          }
        }
        if (staleDevices.length > 0) {
          console.error(`[Auth] Cleaned up ${staleDevices.length} stale device(s), keeping only ${deviceId}`);
        }
      } catch (_) {
        // Best-effort cleanup — don't block startup
      }
    }

    // Cache the successfully created and synced client
    cacheClient(client, userId, homeserverUrl);
    
    return client;
  } catch (error) {
    // If client creation failed, make sure to stop the client and don't cache it
    try {
      client.stopClient();
    } catch (stopError) {
      console.warn("Error stopping failed client:", stopError);
    }
    throw error;
  }
}

/**
 * Remove a client from cache and stop it (for error recovery)
 *
 * @param userId - Matrix user ID  
 * @param homeserverUrl - Matrix homeserver URL
 */
export function removeClientFromCache(userId: string, homeserverUrl: string): void {
  removeCachedClient(userId, homeserverUrl);
}
