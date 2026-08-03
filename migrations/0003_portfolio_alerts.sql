CREATE TABLE IF NOT EXISTS portfolio_holdings (
  id TEXT PRIMARY KEY NOT NULL,
  owner_hash TEXT NOT NULL,
  symbol TEXT NOT NULL,
  base TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  avg_price REAL NOT NULL CHECK (avg_price > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS portfolio_holdings_owner_symbol_idx
ON portfolio_holdings(owner_hash, symbol);

CREATE TABLE IF NOT EXISTS price_alerts (
  id TEXT PRIMARY KEY NOT NULL,
  owner_hash TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('above','below')),
  target_price REAL NOT NULL CHECK (target_price > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  triggered_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS price_alerts_owner_active_idx
ON price_alerts(owner_hash, active);
