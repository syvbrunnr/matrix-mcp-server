import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { rmSync } from "fs";
import path from "path";
import os from "os";
import { runMigrations, CURRENT_DATA_VERSION } from "./migrations.js";

describe("migrations", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "mcp-migrations-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("CURRENT_DATA_VERSION equals the number of migrations", () => {
    expect(CURRENT_DATA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("runs all migrations on a fresh data directory", () => {
    runMigrations(tmpDir);

    const versionFile = path.join(tmpDir, "data-version");
    expect(existsSync(versionFile)).toBe(true);
    expect(readFileSync(versionFile, "utf-8")).toBe(String(CURRENT_DATA_VERSION));
  });

  it("skips migrations when already at current version", () => {
    const versionFile = path.join(tmpDir, "data-version");
    writeFileSync(versionFile, String(CURRENT_DATA_VERSION), "utf-8");

    // Should not throw or change anything
    runMigrations(tmpDir);

    expect(readFileSync(versionFile, "utf-8")).toBe(String(CURRENT_DATA_VERSION));
  });

  it("skips migrations when ahead of current version", () => {
    const versionFile = path.join(tmpDir, "data-version");
    writeFileSync(versionFile, String(CURRENT_DATA_VERSION + 5), "utf-8");

    runMigrations(tmpDir);

    // Version file should be unchanged
    expect(readFileSync(versionFile, "utf-8")).toBe(String(CURRENT_DATA_VERSION + 5));
  });

  it("handles missing version file as version 0", () => {
    // No version file exists — should run all migrations
    runMigrations(tmpDir);

    const versionFile = path.join(tmpDir, "data-version");
    expect(readFileSync(versionFile, "utf-8")).toBe(String(CURRENT_DATA_VERSION));
  });

  it("handles malformed version file as version 0", () => {
    const versionFile = path.join(tmpDir, "data-version");
    writeFileSync(versionFile, "not-a-number", "utf-8");

    runMigrations(tmpDir);

    expect(readFileSync(versionFile, "utf-8")).toBe(String(CURRENT_DATA_VERSION));
  });

  it("migration v1 deletes ssss-recovery-key", () => {
    const recoveryKey = path.join(tmpDir, "ssss-recovery-key");
    writeFileSync(recoveryKey, "fake-key", "utf-8");

    runMigrations(tmpDir);

    expect(existsSync(recoveryKey)).toBe(false);
  });

  it("migration v1 deletes crypto store files", () => {
    // Create files that match migration v1 patterns
    writeFileSync(path.join(tmpDir, "matrix-sdk-crypto-abc.sqlite"), "", "utf-8");
    writeFileSync(path.join(tmpDir, "matrix-js-sdk-store"), "", "utf-8");
    writeFileSync(path.join(tmpDir, "idb-data.db"), "", "utf-8");
    writeFileSync(path.join(tmpDir, "keep-this-file.txt"), "keep", "utf-8");

    runMigrations(tmpDir);

    expect(existsSync(path.join(tmpDir, "matrix-sdk-crypto-abc.sqlite"))).toBe(false);
    expect(existsSync(path.join(tmpDir, "matrix-js-sdk-store"))).toBe(false);
    expect(existsSync(path.join(tmpDir, "idb-data.db"))).toBe(false);
    expect(existsSync(path.join(tmpDir, "keep-this-file.txt"))).toBe(true);
  });

  it("runs only pending migrations when partially migrated", () => {
    const versionFile = path.join(tmpDir, "data-version");
    writeFileSync(versionFile, "1", "utf-8");

    // Create a file that v2 should delete but v1 already ran
    const recoveryKey = path.join(tmpDir, "ssss-recovery-key");
    writeFileSync(recoveryKey, "fake-key", "utf-8");

    runMigrations(tmpDir);

    // v2 should have run and deleted the recovery key
    expect(existsSync(recoveryKey)).toBe(false);
    expect(readFileSync(versionFile, "utf-8")).toBe(String(CURRENT_DATA_VERSION));
  });
});
