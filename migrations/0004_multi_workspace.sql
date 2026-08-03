-- Multi-workspace: allow multiple dashboards per device.
-- SQLite cannot drop a UNIQUE constraint or an FK reference, so recreate both
-- tables. chart_panels is recreated without REFERENCES because renaming
-- dashboards would leave its FK pointing at the dropped legacy table.
-- (Panels are deleted explicitly by the API; no FK enforcement needed.)

ALTER TABLE dashboards RENAME TO dashboards_legacy;

CREATE TABLE dashboards (
  id TEXT PRIMARY KEY NOT NULL,
  owner_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'MY MARKET GRID',
  columns INTEGER NOT NULL DEFAULT 2 CHECK (columns BETWEEN 1 AND 4),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO dashboards (id, owner_hash, name, columns, created_at, updated_at)
SELECT id, owner_hash, name, columns, created_at, updated_at FROM dashboards_legacy;

DROP TABLE dashboards_legacy;

ALTER TABLE chart_panels RENAME TO chart_panels_legacy;

CREATE TABLE chart_panels (
  id TEXT PRIMARY KEY NOT NULL,
  dashboard_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('BITFINEX', 'BINANCE', 'CRYPTOCAP')),
  symbol TEXT NOT NULL CHECK (length(symbol) BETWEEN 5 AND 40),
  timeframe TEXT NOT NULL DEFAULT '1h' CHECK (timeframe IN ('1m','5m','15m','1h','4h','1D','1W')),
  position INTEGER NOT NULL CHECK (position >= 0),
  span INTEGER NOT NULL DEFAULT 1 CHECK (span BETWEEN 1 AND 2),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO chart_panels (id, dashboard_id, provider, symbol, timeframe, position, span, created_at, updated_at)
SELECT id, dashboard_id, provider, symbol, timeframe, position, span, created_at, updated_at FROM chart_panels_legacy;

DROP TABLE chart_panels_legacy;

CREATE INDEX IF NOT EXISTS dashboards_owner_hash_idx ON dashboards(owner_hash);
CREATE INDEX IF NOT EXISTS chart_panels_dashboard_position_idx ON chart_panels(dashboard_id, position);
