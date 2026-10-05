import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallets (
  address        TEXT PRIMARY KEY,
  parent         TEXT,              -- who infected this wallet ('pool' for Meteora buys)
  gen            INTEGER,
  via            TEXT,              -- launch | liquidity | buy | transfer
  infected_at    INTEGER,           -- unix seconds; NULL = holder that is not infected
  infect_sig     TEXT,
  vaccinated_at  INTEGER,
  burned         REAL NOT NULL DEFAULT 0,
  balance        REAL NOT NULL DEFAULT 0,
  name           TEXT,
  name_checked_at INTEGER
);
CREATE INDEX IF NOT EXISTS wallets_parent ON wallets(parent);
CREATE INDEX IF NOT EXISTS wallets_infected ON wallets(infected_at);

CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  sig    TEXT,
  slot   INTEGER,
  t      INTEGER,
  kind   TEXT,     -- buy | transfer | burn | vax
  a      TEXT,     -- infector / burner
  b      TEXT,     -- infected wallet
  amount REAL
);
CREATE INDEX IF NOT EXISTS events_t ON events(t);
CREATE INDEX IF NOT EXISTS events_kind_t ON events(kind, t);

CREATE TABLE IF NOT EXISTS processed (sig TEXT PRIMARY KEY, slot INTEGER, t INTEGER);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch INTEGER, category TEXT, address TEXT, lamports INTEGER,
  sig TEXT, status TEXT, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS payouts_epoch ON payouts(epoch);

CREATE TABLE IF NOT EXISTS fee_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER, source TEXT, pool TEXT, quote REAL, quote_symbol TEXT, base REAL, sig TEXT
);
`;

export function openDb(cfg) {
  if (cfg.dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(cfg.dbPath)), { recursive: true });
  const db = new Database(cfg.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);

  // Patient zero and the pool node always exist.
  db.prepare(`INSERT OR IGNORE INTO wallets(address,parent,gen,via,infected_at) VALUES (?,NULL,0,'launch',0)`).run(cfg.devWallet);
  db.prepare(`INSERT OR IGNORE INTO wallets(address,parent,gen,via,infected_at) VALUES ('pool',?,1,'liquidity',0)`).run(cfg.devWallet);
  return db;
}

export function kv(db) {
  const g = db.prepare('SELECT v FROM kv WHERE k=?');
  const s = db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
  return {
    get: (k, d = null) => { const r = g.get(k); return r ? JSON.parse(r.v) : d; },
    set: (k, v) => s.run(k, JSON.stringify(v)),
  };
}
