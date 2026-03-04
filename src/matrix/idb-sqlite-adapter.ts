/**
 * Minimal IndexedDB adapter backed by better-sqlite3.
 *
 * Purpose: give matrix-sdk-crypto-wasm a persistent store in Node.js.
 * The WASM module fails with `TransactionInactiveError` when using indexeddbshim
 * because shims commit transactions before cursor onsuccess callbacks fire.
 *
 * This implementation keeps transactions active while pending requests > 0,
 * using queueMicrotask (same queue as browser IDB) for all onsuccess callbacks.
 * cursor.continue() queues a new request synchronously inside onsuccess, keeping
 * the transaction alive until iteration is complete.
 *
 * Auto-commit uses setImmediate (not queueMicrotask) so WASM Waker continuations
 * drain before the commit fires — see _scheduleCommit().
 *
 * Schema: one SQLite file per IDB database, one SQLite table per object store.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toSqliteKey(key: IDBValidKey): string {
  if (key === null || key === undefined) return "";
  if (Array.isArray(key)) return JSON.stringify(key);
  if (key instanceof ArrayBuffer) return Buffer.from(key).toString("base64");
  return String(key);
}

function toIDBKey(raw: string): string {
  return raw;
}

function matchesRange(key: string, query: IDBValidKey | IDBKeyRange | null | undefined): boolean {
  if (query == null) return true;
  if (query instanceof SQLiteIDBKeyRange) return query.includes(key);
  return toSqliteKey(query as IDBValidKey) === key;
}

// ─────────────────────────────────────────────────────────────────────────────
// IDBKeyRange
// ─────────────────────────────────────────────────────────────────────────────

class SQLiteIDBKeyRange {
  lower?: string;
  upper?: string;
  lowerOpen: boolean;
  upperOpen: boolean;

  constructor(lower: string | undefined, upper: string | undefined, lowerOpen: boolean, upperOpen: boolean) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = lowerOpen;
    this.upperOpen = upperOpen;
  }

  includes(key: string): boolean {
    if (this.lower !== undefined) {
      if (this.lowerOpen ? key <= this.lower : key < this.lower) return false;
    }
    if (this.upper !== undefined) {
      if (this.upperOpen ? key >= this.upper : key > this.upper) return false;
    }
    return true;
  }

  static only(value: IDBValidKey): SQLiteIDBKeyRange {
    const k = toSqliteKey(value);
    return new SQLiteIDBKeyRange(k, k, false, false);
  }

  static bound(lower: IDBValidKey, upper: IDBValidKey, lowerOpen = false, upperOpen = false): SQLiteIDBKeyRange {
    return new SQLiteIDBKeyRange(toSqliteKey(lower), toSqliteKey(upper), lowerOpen, upperOpen);
  }

  static lowerBound(lower: IDBValidKey, open = false): SQLiteIDBKeyRange {
    return new SQLiteIDBKeyRange(toSqliteKey(lower), undefined, open, false);
  }

  static upperBound(upper: IDBValidKey, open = false): SQLiteIDBKeyRange {
    return new SQLiteIDBKeyRange(undefined, toSqliteKey(upper), false, open);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IDBRequest
// ─────────────────────────────────────────────────────────────────────────────

class SQLiteIDBRequest<T = any> {
  result: T | undefined = undefined;
  error: DOMException | null = null;
  readyState: "pending" | "done" = "pending";
  onsuccess: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  source: any = null;
  transaction: SQLiteIDBTransaction | null = null;

  _resolve(result: T) {
    this.result = result;
    this.readyState = "done";
    if (this.onsuccess) {
      this.onsuccess({ target: this, type: "success" });
    }
  }

  _reject(error: DOMException) {
    this.error = error;
    this.readyState = "done";
    if (this.onerror) {
      this.onerror({ target: this, type: "error" });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IDBCursor
// ─────────────────────────────────────────────────────────────────────────────

class SQLiteIDBCursor {
  value: any;
  key: string;
  primaryKey: string;
  direction: string;

  private _rows: Array<{ key: string; value: any }>;
  private _pos: number;
  private _store: SQLiteIDBObjectStore;
  private _req: SQLiteIDBRequest<SQLiteIDBCursor | null>;

  constructor(
    rows: Array<{ key: string; value: any }>,
    store: SQLiteIDBObjectStore,
    req: SQLiteIDBRequest<SQLiteIDBCursor | null>,
    direction = "next"
  ) {
    this._rows = rows;
    this._pos = 0;
    this._store = store;
    this._req = req;
    this.direction = direction;
    this.key = rows[0]?.key ?? "";
    this.primaryKey = this.key;
    this.value = rows[0]?.value;
  }

  continue(nextKey?: IDBValidKey) {
    const tx = this._store._tx;
    if (!tx._active) throw new DOMException("Transaction is not active", "TransactionInactiveError");
    tx._pendingRequests++;
    this._pos++;
    // Skip to specific key if provided
    if (nextKey !== undefined) {
      const k = toSqliteKey(nextKey);
      while (this._pos < this._rows.length && this._rows[this._pos].key < k) this._pos++;
    }
    const req = this._req;
    // Reset request so WASM Futures see it as pending again
    req.readyState = "pending";
    req.result = undefined;
    queueMicrotask(() => {
      tx._pendingRequests--;
      if (this._pos < this._rows.length) {
        this.key = this._rows[this._pos].key;
        this.primaryKey = this.key;
        this.value = this._rows[this._pos].value;
        req._resolve(this as SQLiteIDBCursor);
      } else {
        req._resolve(null);
      }
      tx._scheduleCommit();
    });
  }

  delete(): SQLiteIDBRequest<undefined> {
    const tx = this._store._tx;
    if (!tx._active) throw new DOMException("Transaction is not active", "TransactionInactiveError");
    tx._pendingRequests++;
    const req = new SQLiteIDBRequest<undefined>();
    req.transaction = tx;
    queueMicrotask(() => {
      tx._pendingRequests--;
      this._store._deleteByKey(this.key);
      req._resolve(undefined);
      tx._scheduleCommit();
    });
    return req;
  }

  update(value: any): SQLiteIDBRequest<IDBValidKey> {
    const tx = this._store._tx;
    if (!tx._active) throw new DOMException("Transaction is not active", "TransactionInactiveError");
    tx._pendingRequests++;
    const req = new SQLiteIDBRequest<IDBValidKey>();
    req.transaction = tx;
    queueMicrotask(() => {
      tx._pendingRequests--;
      this._store._putByKey(this.key, value);
      req._resolve(this.key as IDBValidKey);
      tx._scheduleCommit();
    });
    return req;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IDBObjectStore
// ─────────────────────────────────────────────────────────────────────────────

class SQLiteIDBObjectStore {
  name: string;
  keyPath: string | null;
  autoIncrement: boolean;
  _tx: SQLiteIDBTransaction;
  _db: SQLiteIDBDatabase;

  constructor(name: string, tx: SQLiteIDBTransaction, db: SQLiteIDBDatabase, keyPath: string | null, autoIncrement: boolean) {
    this.name = name;
    this._tx = tx;
    this._db = db;
    this.keyPath = keyPath;
    this.autoIncrement = autoIncrement;
  }

  private get _sqlite() { return this._db._sqlite; }

  private _ensureTable() {
    const tableName = this._safeName();
    this._sqlite.exec(`
      CREATE TABLE IF NOT EXISTS "${tableName}" (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    // Ensure index table exists
    this._sqlite.exec(`
      CREATE TABLE IF NOT EXISTS "${tableName}_indexes" (
        index_name TEXT NOT NULL,
        key TEXT NOT NULL,
        index_key TEXT NOT NULL
      )
    `);
  }

  private _safeName(): string {
    return this.name.replace(/[^a-zA-Z0-9_]/g, "_");
  }

  _deleteByKey(key: string) {
    this._ensureTable();
    this._sqlite.prepare(`DELETE FROM "${this._safeName()}" WHERE key = ?`).run(key);
  }

  _putByKey(key: string, value: any) {
    this._ensureTable();
    const serialized = JSON.stringify(value);
    this._sqlite.prepare(`INSERT OR REPLACE INTO "${this._safeName()}" (key, value) VALUES (?, ?)`).run(key, serialized);
  }

  private _extractKey(value: any): string {
    if (this.keyPath) {
      const parts = this.keyPath.split(".");
      let v: any = value;
      for (const p of parts) v = v?.[p];
      return toSqliteKey(v as IDBValidKey);
    }
    return "";
  }

  private _makeRequest<T>(fn: () => T): SQLiteIDBRequest<T> {
    if (!this._tx._active) throw new DOMException("Transaction is not active", "TransactionInactiveError");
    this._tx._pendingRequests++;
    const req = new SQLiteIDBRequest<T>();
    req.transaction = this._tx;
    req.source = this;
    queueMicrotask(() => {
      this._tx._pendingRequests--;
      try {
        const result = fn();
        req._resolve(result);
      } catch (e: any) {
        req._reject(new DOMException(e.message, "UnknownError"));
      }
      this._tx._scheduleCommit();
    });
    return req;
  }

  get(query: IDBValidKey | IDBKeyRange): SQLiteIDBRequest<any> {
    return this._makeRequest(() => {
      this._ensureTable();
      const key = query instanceof SQLiteIDBKeyRange
        ? this._sqlite.prepare(`SELECT key, value FROM "${this._safeName()}" ORDER BY key`).all()
            .find((r: any) => query.includes(r.key))
        : this._sqlite.prepare(`SELECT value FROM "${this._safeName()}" WHERE key = ?`).get(toSqliteKey(query as IDBValidKey)) as any;
      if (!key) return undefined;
      const row = query instanceof SQLiteIDBKeyRange ? key : key;
      return JSON.parse(row.value ?? "null");
    });
  }

  getAll(query?: IDBValidKey | IDBKeyRange | null, count?: number): SQLiteIDBRequest<any[]> {
    return this._makeRequest(() => {
      this._ensureTable();
      const rows = this._sqlite.prepare(`SELECT key, value FROM "${this._safeName()}" ORDER BY key`).all() as any[];
      let filtered = rows.filter((r: any) => matchesRange(r.key, query ?? null));
      if (count !== undefined) filtered = filtered.slice(0, count);
      return filtered.map((r: any) => JSON.parse(r.value));
    });
  }

  getAllKeys(query?: IDBValidKey | IDBKeyRange | null, count?: number): SQLiteIDBRequest<IDBValidKey[]> {
    return this._makeRequest(() => {
      this._ensureTable();
      const rows = this._sqlite.prepare(`SELECT key FROM "${this._safeName()}" ORDER BY key`).all() as any[];
      let filtered = rows.filter((r: any) => matchesRange(r.key, query ?? null));
      if (count !== undefined) filtered = filtered.slice(0, count);
      return filtered.map((r: any) => r.key as IDBValidKey);
    });
  }

  put(value: any, key?: IDBValidKey): SQLiteIDBRequest<IDBValidKey> {
    return this._makeRequest(() => {
      this._ensureTable();
      let k: string;
      if (key !== undefined) {
        k = toSqliteKey(key);
      } else if (this.keyPath) {
        k = this._extractKey(value);
      } else {
        k = String(Date.now()) + String(Math.random());
      }
      const serialized = JSON.stringify(value);
      this._sqlite.prepare(`INSERT OR REPLACE INTO "${this._safeName()}" (key, value) VALUES (?, ?)`).run(k, serialized);
      return toIDBKey(k) as IDBValidKey;
    });
  }

  add(value: any, key?: IDBValidKey): SQLiteIDBRequest<IDBValidKey> {
    return this._makeRequest(() => {
      this._ensureTable();
      let k: string;
      if (key !== undefined) {
        k = toSqliteKey(key);
      } else if (this.keyPath) {
        k = this._extractKey(value);
      } else {
        k = String(Date.now()) + String(Math.random());
      }
      const existing = this._sqlite.prepare(`SELECT key FROM "${this._safeName()}" WHERE key = ?`).get(k);
      if (existing) throw new DOMException("Key already exists", "ConstraintError");
      const serialized = JSON.stringify(value);
      this._sqlite.prepare(`INSERT INTO "${this._safeName()}" (key, value) VALUES (?, ?)`).run(k, serialized);
      return toIDBKey(k) as IDBValidKey;
    });
  }

  delete(query: IDBValidKey | IDBKeyRange): SQLiteIDBRequest<undefined> {
    return this._makeRequest(() => {
      this._ensureTable();
      if (query instanceof SQLiteIDBKeyRange) {
        const rows = this._sqlite.prepare(`SELECT key FROM "${this._safeName()}"`).all() as any[];
        for (const row of rows) {
          if (query.includes(row.key)) {
            this._sqlite.prepare(`DELETE FROM "${this._safeName()}" WHERE key = ?`).run(row.key);
          }
        }
      } else {
        this._sqlite.prepare(`DELETE FROM "${this._safeName()}" WHERE key = ?`).run(toSqliteKey(query as IDBValidKey));
      }
      return undefined;
    });
  }

  clear(): SQLiteIDBRequest<undefined> {
    return this._makeRequest(() => {
      this._ensureTable();
      this._sqlite.prepare(`DELETE FROM "${this._safeName()}"`).run();
      return undefined;
    });
  }

  count(query?: IDBValidKey | IDBKeyRange | null): SQLiteIDBRequest<number> {
    return this._makeRequest(() => {
      this._ensureTable();
      if (!query) {
        const r = this._sqlite.prepare(`SELECT COUNT(*) as c FROM "${this._safeName()}"`).get() as any;
        return r.c as number;
      }
      const rows = this._sqlite.prepare(`SELECT key FROM "${this._safeName()}"`).all() as any[];
      return rows.filter((r: any) => matchesRange(r.key, query)).length;
    });
  }

  openCursor(query?: IDBValidKey | IDBKeyRange | null, direction = "next"): SQLiteIDBRequest<SQLiteIDBCursor | null> {
    if (!this._tx._active) throw new DOMException("Transaction is not active", "TransactionInactiveError");
    this._tx._pendingRequests++;
    const req = new SQLiteIDBRequest<SQLiteIDBCursor | null>();
    req.transaction = this._tx;
    req.source = this;
    queueMicrotask(() => {
      this._tx._pendingRequests--;
      try {
        this._ensureTable();
        const order = direction === "prev" || direction === "prevunique" ? "DESC" : "ASC";
        const rows = (this._sqlite.prepare(`SELECT key, value FROM "${this._safeName()}" ORDER BY key ${order}`).all() as any[])
          .filter((r: any) => matchesRange(r.key, query ?? null))
          .map((r: any) => ({ key: r.key as string, value: JSON.parse(r.value) }));

        if (rows.length === 0) {
          req._resolve(null);
        } else {
          const cursor = new SQLiteIDBCursor(rows, this, req, direction);
          req._resolve(cursor);
        }
      } catch (e: any) {
        req._reject(new DOMException(e.message, "UnknownError"));
      }
      this._tx._scheduleCommit();
    });
    return req;
  }

  openKeyCursor(query?: IDBValidKey | IDBKeyRange | null, direction = "next"): SQLiteIDBRequest<SQLiteIDBCursor | null> {
    // Same as openCursor for our purposes
    return this.openCursor(query, direction);
  }

  createIndex(name: string, _keyPath: string | string[], _options?: IDBIndexParameters): SQLiteIDBIndex {
    return new SQLiteIDBIndex(name, this);
  }

  index(name: string): SQLiteIDBIndex {
    return new SQLiteIDBIndex(name, this);
  }

  get indexNames(): DOMStringList {
    return { length: 0, contains: () => false, item: () => null, [Symbol.iterator]: function*() {} } as any;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IDBIndex (simplified — falls back to full scan with key extraction)
// ─────────────────────────────────────────────────────────────────────────────

class SQLiteIDBIndex {
  name: string;
  objectStore: SQLiteIDBObjectStore;

  constructor(name: string, store: SQLiteIDBObjectStore) {
    this.name = name;
    this.objectStore = store;
  }

  get(query: IDBValidKey | IDBKeyRange): SQLiteIDBRequest<any> {
    return this.objectStore.get(query);
  }

  getAll(query?: IDBValidKey | IDBKeyRange | null, count?: number): SQLiteIDBRequest<any[]> {
    return this.objectStore.getAll(query, count);
  }

  getAllKeys(query?: IDBValidKey | IDBKeyRange | null, count?: number): SQLiteIDBRequest<IDBValidKey[]> {
    return this.objectStore.getAllKeys(query, count);
  }

  openCursor(query?: IDBValidKey | IDBKeyRange | null, direction?: string): SQLiteIDBRequest<SQLiteIDBCursor | null> {
    return this.objectStore.openCursor(query, direction);
  }

  count(query?: IDBValidKey | IDBKeyRange | null): SQLiteIDBRequest<number> {
    return this.objectStore.count(query);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IDBTransaction
// ─────────────────────────────────────────────────────────────────────────────

class SQLiteIDBTransaction {
  _active = true;
  _pendingRequests = 0;
  _committed = false;
  _aborted = false;
  _commitScheduled = false;
  db: SQLiteIDBDatabase;
  mode: IDBTransactionMode;
  _storeNames: string[];

  oncomplete: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onabort: ((event: any) => void) | null = null;

  constructor(db: SQLiteIDBDatabase, storeNames: string[], mode: IDBTransactionMode) {
    this.db = db;
    this._storeNames = storeNames;
    this.mode = mode;
  }

  objectStore(name: string): SQLiteIDBObjectStore {
    if (!this._active) throw new DOMException("Transaction is not active", "TransactionInactiveError");
    const meta = this.db._storeMeta.get(name) ?? { keyPath: null, autoIncrement: false };
    return new SQLiteIDBObjectStore(name, this, this.db, meta.keyPath, meta.autoIncrement);
  }

  commit() {
    this._maybeCommit(true);
  }

  abort() {
    this._active = false;
    this._aborted = true;
    if (this.onabort) this.onabort({ target: this, type: "abort" });
  }

  // Called immediately when we know we want to commit.
  _maybeCommit(force = false) {
    if (this._committed || this._aborted) return;
    if (force || this._pendingRequests === 0) {
      this._active = false;
      this._committed = true;
      if (this.oncomplete) {
        queueMicrotask(() => this.oncomplete!({ target: this, type: "complete" }));
      }
    }
  }

  // Schedule a commit check AFTER all pending microtasks (including WASM Waker continuations).
  // This matches browser IDB behaviour: transaction does not auto-commit until the current
  // task's microtask queue is fully drained, giving async continuations a chance to queue
  // new requests before the commit fires.
  _scheduleCommit() {
    if (this._committed || this._aborted || this._commitScheduled) return;
    this._commitScheduled = true;
    setImmediate(() => {
      this._commitScheduled = false;
      this._maybeCommit();
    });
  }

  get error(): DOMException | null { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// IDBDatabase
// ─────────────────────────────────────────────────────────────────────────────

class SQLiteIDBDatabase {
  name: string;
  version: number;
  _sqlite: Database.Database;
  _storeMeta: Map<string, { keyPath: string | null; autoIncrement: boolean }> = new Map();

  onversionchange: ((event: any) => void) | null = null;

  constructor(name: string, version: number, sqlite: Database.Database) {
    this.name = name;
    this.version = version;
    this._sqlite = sqlite;
    this._loadMeta();
  }

  private _loadMeta() {
    this._sqlite.exec(`
      CREATE TABLE IF NOT EXISTS __idb_meta__ (
        store_name TEXT PRIMARY KEY,
        key_path TEXT,
        auto_increment INTEGER NOT NULL DEFAULT 0
      )
    `);
    const rows = this._sqlite.prepare(`SELECT * FROM __idb_meta__`).all() as any[];
    for (const row of rows) {
      this._storeMeta.set(row.store_name, {
        keyPath: row.key_path ?? null,
        autoIncrement: row.auto_increment === 1,
      });
    }
  }

  get objectStoreNames(): DOMStringList {
    const names = Array.from(this._storeMeta.keys());
    return {
      length: names.length,
      contains: (name: string) => names.includes(name),
      item: (i: number) => names[i] ?? null,
      [Symbol.iterator]: function* () { yield* names; },
    } as any;
  }

  transaction(storeNames: string | string[], mode: IDBTransactionMode = "readonly"): SQLiteIDBTransaction {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const tx = new SQLiteIDBTransaction(this, names, mode);
    // Schedule auto-commit after all microtasks (including WASM continuations) drain
    setImmediate(() => tx._maybeCommit());
    return tx;
  }

  createObjectStore(name: string, options?: IDBObjectStoreParameters): SQLiteIDBObjectStore {
    const keyPath = (options?.keyPath as string | null) ?? null;
    const autoIncrement = options?.autoIncrement ?? false;
    this._storeMeta.set(name, { keyPath, autoIncrement });
    this._sqlite.prepare(
      `INSERT OR REPLACE INTO __idb_meta__ (store_name, key_path, auto_increment) VALUES (?, ?, ?)`
    ).run(name, keyPath, autoIncrement ? 1 : 0);
    // Create table immediately
    const safeName = name.replace(/[^a-zA-Z0-9_]/g, "_");
    this._sqlite.exec(`
      CREATE TABLE IF NOT EXISTS "${safeName}" (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    // Create dummy tx for the store constructor (upgrade tx)
    const dummyTx = new SQLiteIDBTransaction(this, [name], "versionchange");
    return new SQLiteIDBObjectStore(name, dummyTx, this, keyPath, autoIncrement);
  }

  deleteObjectStore(name: string) {
    this._storeMeta.delete(name);
    this._sqlite.prepare(`DELETE FROM __idb_meta__ WHERE store_name = ?`).run(name);
    const safeName = name.replace(/[^a-zA-Z0-9_]/g, "_");
    this._sqlite.exec(`DROP TABLE IF EXISTS "${safeName}"`);
  }

  close() {
    // Keep connection open — we reuse the same SQLite handle across calls
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IDBOpenDBRequest / IDBFactory
// ─────────────────────────────────────────────────────────────────────────────

class SQLiteIDBOpenDBRequest extends SQLiteIDBRequest<SQLiteIDBDatabase> {
  onupgradeneeded: ((event: any) => void) | null = null;
  onblocked: ((event: any) => void) | null = null;
}

// SQLite file cache — one file per database name
const dbCache = new Map<string, Database.Database>();
let dbDir = "/tmp";

function getSQLiteDb(name: string): Database.Database {
  if (!dbCache.has(name)) {
    const filePath = path.join(dbDir, `${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}.sqlite`);
    const db = new Database(filePath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    dbCache.set(name, db);
  }
  return dbCache.get(name)!;
}

class SQLiteIDBFactory {
  open(name: string, version?: number): SQLiteIDBOpenDBRequest {
    const req = new SQLiteIDBOpenDBRequest();
    const targetVersion = version ?? 1;

    queueMicrotask(() => {
      try {
        const sqlite = getSQLiteDb(name);

        // Read stored version
        sqlite.exec(`CREATE TABLE IF NOT EXISTS __idb_version__ (version INTEGER NOT NULL)`);
        const row = sqlite.prepare(`SELECT version FROM __idb_version__`).get() as any;
        const currentVersion = row?.version ?? 0;

        const idb = new SQLiteIDBDatabase(name, currentVersion, sqlite);

        if (targetVersion > currentVersion) {
          // Run upgrade
          const upgradeTx = new SQLiteIDBTransaction(idb, [], "versionchange");
          upgradeTx._active = true;
          idb.version = targetVersion;

          // Set req.result and req.transaction BEFORE firing onupgradeneeded.
          // The WASM code accesses event.target.result and event.target.transaction
          // (i.e. req.result and req.transaction), not event.result/event.transaction.
          req.result = idb as any;
          req.transaction = upgradeTx;

          const upgradeEvent = {
            target: req,
            type: "upgradeneeded",
            oldVersion: currentVersion,
            newVersion: targetVersion,
            transaction: upgradeTx,
          };

          if (req.onupgradeneeded) {
            req.onupgradeneeded(upgradeEvent);
          }
          // Persist new version
          if (currentVersion === 0) {
            sqlite.prepare(`INSERT INTO __idb_version__ (version) VALUES (?)`).run(targetVersion);
          } else {
            sqlite.prepare(`UPDATE __idb_version__ SET version = ?`).run(targetVersion);
          }
          // Commit upgrade tx and fire oncomplete
          upgradeTx._active = false;
          upgradeTx._committed = true;
          if (upgradeTx.oncomplete) {
            queueMicrotask(() => upgradeTx.oncomplete!({ target: upgradeTx, type: "complete" }));
          }
        }

        req._resolve(idb);
      } catch (e: any) {
        req._reject(new DOMException(e.message, "UnknownError"));
      }
    });

    return req;
  }

  deleteDatabase(name: string): SQLiteIDBOpenDBRequest {
    const req = new SQLiteIDBOpenDBRequest();
    queueMicrotask(() => {
      try {
        const sqlite = getSQLiteDb(name);
        // Drop all tables
        const tables = sqlite.prepare(
          `SELECT name FROM sqlite_master WHERE type='table'`
        ).all() as any[];
        for (const t of tables) {
          sqlite.exec(`DROP TABLE IF EXISTS "${t.name}"`);
        }
        dbCache.delete(name);
        req._resolve(undefined as any);
      } catch (e: any) {
        req._reject(new DOMException(e.message, "UnknownError"));
      }
    });
    return req;
  }

  cmp(first: IDBValidKey, second: IDBValidKey): number {
    const a = toSqliteKey(first);
    const b = toSqliteKey(second);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public install function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Install the SQLite-backed IndexedDB adapter at globalThis.indexedDB.
 * Must be called before initRustCrypto({ useIndexedDB: true }).
 *
 * @param dataDir  Directory where SQLite files will be stored (e.g. ".data/")
 */
export function installIDBAdapter(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  dbDir = dataDir;

  const factory = new SQLiteIDBFactory();

  // Install on globalThis — this is where matrix-sdk-crypto-wasm looks
  (globalThis as any).indexedDB = factory;
  (globalThis as any).IDBKeyRange = SQLiteIDBKeyRange;

  // Also expose on global for legacy compat
  (global as any).indexedDB = factory;
  (global as any).IDBKeyRange = SQLiteIDBKeyRange;
}
