import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { chartPanels, dashboards, portfolioHoldings, priceAlerts } from "../src/db/schema";
import { INSTRUMENTS, TIMEFRAMES, type ChartPanel, type Dashboard, type MarketSnapshot, type Provider, type Timeframe } from "../src/lib/types";

// Runs as a Vercel Edge Function (standard Fetch API), so most of the original
// Cloudflare Worker logic ports over unchanged. The two Cloudflare-only pieces —
// the D1 binding and the MarketHub Durable Object (WebSocket stream) — are gone.
export const config = { runtime: "edge" };

const DEFAULT_SYMBOLS = new Set([
  "BITFINEX:BTCUSD", "BITFINEX:ETHUSD", "BITFINEX:LTCUSD", "BINANCE:SOLUSDT",
  "BINANCE:XRPUSDT", "BINANCE:DOGEUSDT", "CRYPTOCAP:TOTAL", "CRYPTOCAP:BTC.D",
]);
const DEFAULTS = INSTRUMENTS.filter((instrument) => DEFAULT_SYMBOLS.has(instrument.symbol)).map((instrument) => ({ ...instrument, timeframe: "1h" as Timeframe }));
const MAX_PANELS = 16;
const WS_COOKIE = (id: string) => `dmg_ws=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
const json = (data: unknown, status = 200, headers?: HeadersInit) => Response.json(data, { status, headers });
const error = (message: string, status = 400) => json({ error: message }, status);
const validInstrument = (provider: unknown, symbol: unknown) => INSTRUMENTS.find((item) => item.provider === provider && item.symbol === symbol);
const validTimeframe = (value: unknown): value is Timeframe => typeof value === "string" && TIMEFRAMES.includes(value as Timeframe);

// ── Whale Transaction Types ──
interface WhaleTx {
  id: string;
  chain: "BTC" | "ETH" | "SOL" | "ERC20";
  token: string;
  amount: number;
  usdValue: number | null;
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  timestamp: number;
  txHash: string;
  category: "exchange" | "unknown" | "whale" | "institutional";
}

// Simple exchange address heuristics (first few chars)
const EXCHANGE_MARKERS: [string, string][] = [
  ["3", "Binance"], ["bc1q", "Binance"], ["0x3", "Binance"],
  ["0x28", "Coinbase"], ["0xBE0", "Coinbase"],
  ["0x34", "Kraken"], ["0x47", "Kraken"],
  ["0x1db", "Bybit"], ["0xD621", "OKX"],
  ["0x2D6", "Uniswap"], ["0x7a25", "Uniswap"],
  ["0x5a5", "Arbitrum Bridge"], ["0x4D2", "Optimism Bridge"],
  ["0x8Ce", "Tether Treasury"],
];

function labelAddress(addr: string): string {
  const lower = addr.toLowerCase();
  for (const [prefix, label] of EXCHANGE_MARKERS) {
    if (lower.startsWith(prefix)) return label;
  }
  if (addr.length > 12) return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  return addr;
}

const ASSET_PRICES: Record<string, number> = { BTC: 64000, ETH: 1900, SOL: 185, USDT: 1, USDC: 1 };

// ── BTC Whales from mempool.space (FREE, no key needed) ──
async function fetchBtcWhales(): Promise<WhaleTx[]> {
  try {
    const resp = await fetch("https://mempool.space/api/mempool/recent", { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return [];
    const txs = await resp.json() as { txid: string; fee: number; value: number; time: number }[];
    const MIN_BTC = 3;
    const btcPrice = 64000;
    return txs
      .filter((tx) => tx.value >= MIN_BTC * 1e8)
      .slice(0, 15)
      .map((tx) => {
        const btcAmount = tx.value / 1e8;
        return {
          id: `btc-${tx.txid.slice(0, 12)}`,
          chain: "BTC" as const,
          token: "BTC",
          amount: btcAmount,
          usdValue: Math.round(btcAmount * btcPrice),
          from: "mempool",
          to: "mempool",
          fromLabel: "Pending Tx",
          toLabel: "Unconfirmed",
          timestamp: Date.now() - (Date.now() - tx.time * 1000),
          txHash: tx.txid,
          category: "whale" as const,
        };
      });
  } catch { return []; }
}

// ── ETH Whales from free public Ethereum RPC ──
async function fetchEthWhales(): Promise<WhaleTx[]> {
  try {
    const RPC = "https://ethereum-rpc.publicnode.com";
    const resp = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return [];
    const blockData = await resp.json() as { result: string };
    
    const blockResp = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: [blockData.result, true] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!blockResp.ok) return [];
    const block = await blockResp.json() as { result: { transactions: { hash: string; from: string; to: string; value: string }[] } };
    const txs = block.result?.transactions ?? [];
    const MIN_ETH = 10;
    const ethPrice = 1900;

    return txs
      .map((tx) => ({ tx, ethValue: parseInt(tx.value, 16) / 1e18 }))
      .filter(({ ethValue }) => ethValue >= MIN_ETH)
      .slice(0, 10)
      .map(({ tx, ethValue }) => ({
        id: `eth-${tx.hash.slice(2, 14)}`,
        chain: "ETH" as const,
        token: "ETH",
        amount: ethValue,
        usdValue: Math.round(ethValue * ethPrice),
        from: tx.from,
        to: tx.to ?? "0x0000…0000",
        fromLabel: labelAddress(tx.from),
        toLabel: labelAddress(tx.to ?? ""),
        timestamp: Date.now(),
        txHash: tx.hash,
        category: (tx.to && (tx.to.toLowerCase().startsWith("0x3") || tx.to.toLowerCase().startsWith("0x28"))) ? "exchange" as const : "whale" as const,
      }));
  } catch { return []; }
}

// ── SOL Whales from public Solana RPC ──
async function fetchSolWhales(): Promise<WhaleTx[]> {
  try {
    const resp = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getRecentPerformanceSamples", params: [1] }),
      signal: AbortSignal.timeout(5000),
    });
    return [];
  } catch { return []; }
}

// Aggregated whale fetch with dedup
async function fetchWhales(): Promise<WhaleTx[]> {
  const [btc, eth] = await Promise.all([fetchBtcWhales(), fetchEthWhales()]);
  const all = [...btc, ...eth];
  const seen = new Set<string>();
  return all.filter((tx) => {
    if (seen.has(tx.txHash.slice(0, 20))) return false;
    seen.add(tx.txHash.slice(0, 20));
    return true;
  }).sort((a, b) => b.timestamp - a.timestamp).slice(0, 30);
}

async function owner(request: Request): Promise<{ hash: string; cookie?: string; wsId?: string }> {
  const cookie = request.headers.get("cookie") ?? "";
  const found = cookie.match(/(?:^|;\s*)dmg_owner=([^;]+)/)?.[1];
  const wsId = cookie.match(/(?:^|;\s*)dmg_ws=([^;]+)/)?.[1] ?? undefined;
  const token = found ?? crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { hash, wsId, cookie: found ? undefined : `dmg_owner=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` };
}

async function findDashboardById(id: string) {
  return (await getDb().select().from(dashboards).where(eq(dashboards.id, id)).limit(1))[0];
}

// Resolve the active dashboard for an owner: explicit dmg_ws cookie, else first
// created, else create the default workspace (with seeded panels).
async function resolveDashboard(ownerHash: string, wsId?: string): Promise<{ dashboard: typeof dashboards.$inferSelect; newWsCookie?: string }> {
  const db = getDb();
  const owned = await db.select().from(dashboards).where(eq(dashboards.ownerHash, ownerHash)).orderBy(asc(dashboards.createdAt));
  if (!owned.length) {
    const id = crypto.randomUUID();
    await db.insert(dashboards).values({ id, ownerHash, name: "WORKSPACE 01", columns: 2 });
    await db.insert(chartPanels).values(DEFAULTS.map((item, index) => ({
      id: crypto.randomUUID(), dashboardId: id, provider: item.provider, symbol: item.symbol, timeframe: item.timeframe, position: index, span: 1,
    })));
    const created = await findDashboardById(id);
    return { dashboard: created!, newWsCookie: WS_COOKIE(id) };
  }
  if (wsId) {
    const match = owned.find((item) => item.id === wsId);
    if (match) return { dashboard: match };
  }
  const active = owned[0];
  return { dashboard: active, newWsCookie: active.id !== wsId ? WS_COOKIE(active.id) : undefined };
}

async function fullDashboardById(ownerHash: string, dashboardId: string): Promise<Dashboard> {
  const db = getDb();
  const dashboard = (await db.select().from(dashboards).where(and(eq(dashboards.id, dashboardId), eq(dashboards.ownerHash, ownerHash))).limit(1))[0];
  if (!dashboard) throw new Error("Dashboard tidak ditemukan.");
  const rows = await db.select().from(chartPanels).where(eq(chartPanels.dashboardId, dashboard.id)).orderBy(asc(chartPanels.position));
  return {
    id: dashboard.id,
    name: dashboard.name,
    columns: dashboard.columns,
    updatedAt: dashboard.updatedAt,
    panels: rows.map((row) => ({ id: row.id, provider: row.provider as Provider, symbol: row.symbol, timeframe: row.timeframe as Timeframe, position: row.position, span: row.span })),
  };
}

async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.includes("application/json")) return null;
  try { return await request.json() as Record<string, unknown>; } catch { return null; }
}

function panelResponse(row: typeof chartPanels.$inferSelect): ChartPanel {
  return { id: row.id, provider: row.provider as Provider, symbol: row.symbol, timeframe: row.timeframe as Timeframe, position: row.position, span: row.span };
}

async function marketSnapshot(symbol: string): Promise<MarketSnapshot> {
  const unavailable = (): MarketSnapshot => ({ symbol, price: null, change24h: null, volume24h: null, timestamp: Date.now(), stale: true, sourceStatus: "unavailable" });
  try {
    if (symbol.startsWith("BINANCE:")) {
      const pair = symbol.split(":")[1];
      const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`);
      if (!response.ok) return unavailable();
      const data = await response.json() as { lastPrice: string; priceChangePercent: string; quoteVolume: string; closeTime: number };
      return { symbol, price: Number(data.lastPrice), change24h: Number(data.priceChangePercent), volume24h: Number(data.quoteVolume), timestamp: data.closeTime, stale: Date.now() - data.closeTime > 60_000, sourceStatus: "live" };
    }
    if (symbol.startsWith("BITFINEX:")) {
      const pair = symbol.split(":")[1];
      const response = await fetch(`https://api-pub.bitfinex.com/v2/ticker/t${pair}`);
      if (!response.ok) return unavailable();
      const data = await response.json() as number[];
      return { symbol, price: data[6] ?? null, change24h: (data[5] ?? 0) * 100, volume24h: data[7] ?? null, timestamp: Date.now(), stale: false, sourceStatus: "live" };
    }
    const metricsUrl = process.env.GLOBAL_METRICS_API_URL;
    if (metricsUrl) {
      const response = await fetch(`${metricsUrl}?symbol=${encodeURIComponent(symbol)}`, {
        headers: process.env.GLOBAL_METRICS_API_KEY ? { authorization: `Bearer ${process.env.GLOBAL_METRICS_API_KEY}` } : undefined,
      });
      if (response.ok) {
        const data = await response.json() as { price: number; change24h?: number; timestamp?: number };
        return { symbol, price: data.price, change24h: data.change24h ?? null, volume24h: null, timestamp: data.timestamp ?? Date.now(), stale: false, sourceStatus: "live" };
      }
    }
    return unavailable();
  } catch { return unavailable(); }
}

// ── Dev-friendly schema bootstrap (mirrors migrations/*.sql) ──
// Multi-workspace migration: legacy dashboards had UNIQUE owner_hash and
// chart_panels had a FK REFERENCES dashboards(id). SQLite cannot drop either
// constraint, so recreate both tables when detected. FKs are not needed here —
// panels are deleted explicitly everywhere.
let ensured = false;
async function ensureTables() {
  if (ensured) return;
  const db = getDb();
  try {
    const probe = await db.run(sql`SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('dashboards','chart_panels')`);
    const tables = new Map<string, string>((probe.rows ?? []).map((row) => [String((row as { name?: unknown }).name), String((row as { sql?: unknown }).sql)]));
    const legacyDash = (tables.get("dashboards") ?? "").includes("UNIQUE");
    const legacyPanel = (tables.get("chart_panels") ?? "").includes("REFERENCES");
    if (legacyDash) {
      await db.run(sql`ALTER TABLE dashboards RENAME TO dashboards_legacy`);
      await db.run(sql`CREATE TABLE dashboards (id TEXT PRIMARY KEY NOT NULL, owner_hash TEXT NOT NULL, name TEXT NOT NULL DEFAULT 'MY MARKET GRID', columns INTEGER NOT NULL DEFAULT 2, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await db.run(sql`INSERT INTO dashboards (id, owner_hash, name, columns, created_at, updated_at) SELECT id, owner_hash, name, columns, created_at, updated_at FROM dashboards_legacy`);
      await db.run(sql`DROP TABLE dashboards_legacy`);
    }
    if (legacyPanel) {
      await db.run(sql`ALTER TABLE chart_panels RENAME TO chart_panels_legacy`);
      await db.run(sql`CREATE TABLE chart_panels (id TEXT PRIMARY KEY NOT NULL, dashboard_id TEXT NOT NULL, provider TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL DEFAULT '1h', position INTEGER NOT NULL, span INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await db.run(sql`INSERT INTO chart_panels (id, dashboard_id, provider, symbol, timeframe, position, span, created_at, updated_at) SELECT id, dashboard_id, provider, symbol, timeframe, position, span, created_at, updated_at FROM chart_panels_legacy`);
      await db.run(sql`DROP TABLE chart_panels_legacy`);
    }
  } catch { /* fresh DB — CREATE IF NOT EXISTS below covers it */ }
  const statements = [
    sql`CREATE TABLE IF NOT EXISTS dashboards (id TEXT PRIMARY KEY NOT NULL, owner_hash TEXT NOT NULL, name TEXT NOT NULL DEFAULT 'MY MARKET GRID', columns INTEGER NOT NULL DEFAULT 2, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    sql`CREATE INDEX IF NOT EXISTS dashboards_owner_hash_idx ON dashboards(owner_hash)`,
    sql`CREATE TABLE IF NOT EXISTS chart_panels (id TEXT PRIMARY KEY NOT NULL, dashboard_id TEXT NOT NULL, provider TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL DEFAULT '1h', position INTEGER NOT NULL, span INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    sql`CREATE INDEX IF NOT EXISTS chart_panels_dashboard_position_idx ON chart_panels(dashboard_id, position)`,
    sql`CREATE TABLE IF NOT EXISTS portfolio_holdings (id TEXT PRIMARY KEY NOT NULL, owner_hash TEXT NOT NULL, symbol TEXT NOT NULL, base TEXT NOT NULL, quantity REAL NOT NULL, avg_price REAL NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    sql`CREATE UNIQUE INDEX IF NOT EXISTS portfolio_holdings_owner_symbol_idx ON portfolio_holdings(owner_hash, symbol)`,
    sql`CREATE TABLE IF NOT EXISTS price_alerts (id TEXT PRIMARY KEY NOT NULL, owner_hash TEXT NOT NULL, symbol TEXT NOT NULL, direction TEXT NOT NULL, target_price REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1, triggered_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    sql`CREATE INDEX IF NOT EXISTS price_alerts_owner_active_idx ON price_alerts(owner_hash, active)`,
  ];
  for (const statement of statements) await db.run(statement);
  ensured = true;
}

// ── AI Market Brief (optional OpenAI, local fallback without a key) ──
async function generateInsight(symbols: string[]): Promise<{ summary: string; provider: "openai" | "local"; generatedAt: number }> {
  const generatedAt = Date.now();
  const snapshots = await Promise.all(symbols.slice(0, 16).map((symbol) => marketSnapshot(symbol)));
  const priced = snapshots.filter((item) => item.price != null && item.change24h != null);
  const context = snapshots.map((s) => {
    const name = s.symbol.split(":")[1] ?? s.symbol;
    return `${name}: ${s.price == null ? "N/A" : "$" + s.price.toLocaleString("en-US", { maximumFractionDigits: 2 })} (${s.change24h == null ? "n/a" : (s.change24h >= 0 ? "+" : "") + s.change24h.toFixed(2) + "%"})`;
  }).join("\n");

  const localBrief = () => {
    const sorted = [...priced].sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0));
    const gainers = sorted.slice(0, 3).map((s) => `${s.symbol.split(":")[1] ?? s.symbol} +${(s.change24h ?? 0).toFixed(2)}%`).join(", ");
    const losers = [...sorted].reverse().slice(0, 3).map((s) => `${s.symbol.split(":")[1] ?? s.symbol} ${(s.change24h ?? 0).toFixed(2)}%`).join(", ");
    const avg = priced.length ? priced.reduce((sum, s) => sum + (s.change24h ?? 0), 0) / priced.length : 0;
    const trend = avg > 1 ? "bullish" : avg < -1 ? "bearish" : "sideways";
    return [
      `MARKET BRIEF // ${new Date(generatedAt).toLocaleString("id-ID", { timeZone: "UTC" })} UTC`,
      `Rata-rata pergerakan 24 jam ${priced.length} instrumen: ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}% (${trend.toUpperCase()}).`,
      gainers ? `PEMIMPIN: ${gainers}` : null,
      losers ? `TERTINGGAL: ${losers}` : null,
      "",
      "Catatan: ini analisis lokal real-time dari data grid Anda. Tambahkan OPENAI_API_KEY untuk market brief AI berbahasa Indonesia yang lebih dalam.",
    ].filter(Boolean).join("\n");
  };

  const key = process.env.OPENAI_API_KEY;
  if (!key) return { summary: localBrief(), provider: "local", generatedAt };
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.7,
        max_tokens: 600,
        messages: [
          { role: "system", content: "Kamu adalah analis pasar kripto yang ringkas dan tajam. Tulis dalam Bahasa Indonesia, gaya Bloomberg terminal: singkat, padat, tanpa basa-basi. Gunakan huruf kapital untuk label seksi." },
          { role: "user", content: `Berikut data harga terkini instrumen (nama: harga, perubahan 24 jam):\n${context}\n\nBuat "market brief" singkat (maks 150 kata): rangkum arah pasar, sebutkan aset paling kuat dan paling lemah, lalu beri 1-2 observasi singkat.` },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`OpenAI ${response.status}`);
    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary) throw new Error("OpenAI kosong.");
    return { summary, provider: "openai", generatedAt };
  } catch {
    return { summary: localBrief(), provider: "local", generatedAt };
  }
}

// ── Fear & Greed Index (free public API) ──
async function fetchFearGreed(): Promise<{ value: number; classification: string; updatedAt: number } | null> {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json() as { data?: { value?: string; value_classification?: string; timestamp?: string }[] };
    const row = data.data?.[0];
    if (!row) return null;
    return { value: Number(row.value), classification: row.value_classification ?? "", updatedAt: Number(row.timestamp ?? 0) * 1000 };
  } catch { return null; }
}

// ── Perpetual funding rates (Binance futures, free public API) ──
async function fetchFunding(): Promise<{ symbol: string; lastFundingRate: number; markPrice: number; nextFundingTime: number }[]> {
  const majors = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  try {
    const rows = await Promise.all(majors.map(async (symbol) => {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return null;
      const data = await res.json() as { symbol: string; lastFundingRate: string; markPrice: string; nextFundingTime: number };
      return { symbol, lastFundingRate: Number(data.lastFundingRate), markPrice: Number(data.markPrice), nextFundingTime: data.nextFundingTime };
    }));
    return rows.filter((row): row is NonNullable<typeof row> => row != null);
  } catch { return []; }
}

// ── Real candlestick data (Binance + Bitfinex) ──
async function fetchKlines(symbol: string, provider: Provider, timeframe: Timeframe, limit: number) {
  if (provider === "BINANCE") {
    const pair = symbol.split(":")[1];
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${timeframe}&limit=${limit}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error("Binance klines unavailable");
    const rows = await res.json() as [number, string, string, string, string, string][];
    return rows.map((r) => ({ time: Math.floor(r[0] / 1000), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }));
  }
  if (provider === "BITFINEX") {
    const pair = symbol.split(":")[1];
    const res = await fetch(`https://api-pub.bitfinex.com/v2/candles/trade:${timeframe}:t${pair}/hist?limit=${limit}&sort=1`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error("Bitfinex klines unavailable");
    const rows = await res.json() as [number, number, number, number, number, number][];
    return rows.map((r) => ({ time: Math.floor(r[0] / 1000), open: r[1], high: r[3], low: r[4], close: r[2], volume: r[5] }));
  }
  throw new Error("Provider tidak mendukung klines.");
}

// All routes use single-level paths because Vercel edge catch-all ([...path].ts)
// does not reliably route multi-level paths. Keep api endpoints flat.
export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const securityHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

  if (url.pathname === "/api/health") {
    try { await ensureTables(); await getDb().select().from(dashboards).limit(1); return json({ ok: true, database: "available", feed: "available" }, 200, securityHeaders); }
    catch { return json({ ok: false, database: "unavailable", feed: "available" }, 503, securityHeaders); }
  }
  if (url.pathname === "/api/instruments" && request.method === "GET") {
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 60);
    const results = INSTRUMENTS.filter((item) => `${item.symbol} ${item.provider} ${item.label} ${item.base} ${item.quote}`.toLowerCase().includes(query)).slice(0, 40);
    return json(results, 200, securityHeaders);
  }
  if (url.pathname === "/api/snapshot" && request.method === "GET") {
    const symbols = [...new Set((url.searchParams.get("symbols") ?? "").split(","))].filter((symbol) => INSTRUMENTS.some((item) => item.symbol === symbol)).slice(0, MAX_PANELS);
    return json(await Promise.all(symbols.map((symbol) => marketSnapshot(symbol))), 200, securityHeaders);
  }
  // ── Whale Transaction Feed (FREE APIs: mempool.space + Ethereum RPC) ──
  if (url.pathname === "/api/whales" && request.method === "GET") {
    return json(await fetchWhales(), 200, securityHeaders);
  }
  if (url.pathname === "/api/sentiment" && request.method === "GET") {
    const [fearGreed, funding] = await Promise.all([fetchFearGreed(), fetchFunding()]);
    return json({ fearGreed, funding }, 200, securityHeaders);
  }
  if (url.pathname === "/api/klines" && request.method === "GET") {
    const symbol = url.searchParams.get("symbol") ?? "";
    const timeframe = url.searchParams.get("interval") ?? "1h";
    const limit = Math.min(500, Math.max(50, Number(url.searchParams.get("limit") ?? 200)));
    const instrument = INSTRUMENTS.find((item) => item.symbol === symbol);
    if (!instrument || !validTimeframe(timeframe)) return error("Parameter klines tidak valid.", 422);
    try { return json(await fetchKlines(symbol, instrument.provider, timeframe, limit), 200, securityHeaders); }
    catch { return error("Data klines tidak tersedia.", 502); }
  }
  if (url.pathname === "/api/dashboard" && request.method === "GET") {
    const identity = await owner(request);
    const headers = new Headers(securityHeaders);
    if (identity.cookie) headers.append("set-cookie", identity.cookie);
    await ensureTables();
    const resolved = await resolveDashboard(identity.hash, identity.wsId);
    if (resolved.newWsCookie) headers.append("set-cookie", resolved.newWsCookie);
    return json(await fullDashboardById(identity.hash, resolved.dashboard.id), 200, headers);
  }
  
  // ── Auth for dashboard mutations ──
  const identity = await owner(request);
  const headers = new Headers(securityHeaders);
  if (identity.cookie) headers.append("set-cookie", identity.cookie);
  
  await ensureTables();
  const resolved = await resolveDashboard(identity.hash, identity.wsId);
  if (resolved.newWsCookie) headers.append("set-cookie", resolved.newWsCookie);
  const dashboard = resolved.dashboard;
  const db = getDb();

  // ── Workspace management ──
  if (url.pathname === "/api/workspaces") {
    if (request.method === "GET") {
      const rows = await db.select().from(dashboards).where(eq(dashboards.ownerHash, identity.hash)).orderBy(asc(dashboards.createdAt));
      const ids = rows.map((row) => row.id);
      const panels = ids.length ? await db.select({ dashboardId: chartPanels.dashboardId, id: chartPanels.id }).from(chartPanels).where(inArray(chartPanels.dashboardId, ids)) : [];
      const counts = new Map<string, number>();
      for (const panel of panels) counts.set(panel.dashboardId, (counts.get(panel.dashboardId) ?? 0) + 1);
      return json(rows.map((row) => ({ id: row.id, name: row.name, columns: row.columns, panelCount: counts.get(row.id) ?? 0, updatedAt: row.updatedAt })), 200, headers);
    }
    if (request.method === "POST") {
      const body = await parseBody(request);
      const existing = await db.select({ id: dashboards.id }).from(dashboards).where(eq(dashboards.ownerHash, identity.hash));
      const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 40) : `WORKSPACE ${String(existing.length + 1).padStart(2, "0")}`;
      const id = crypto.randomUUID();
      await db.insert(dashboards).values({ id, ownerHash: identity.hash, name, columns: 2 });
      headers.append("set-cookie", WS_COOKIE(id));
      return json({ id, name }, 201, headers);
    }
    if (request.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return error("Parameter workspace id diperlukan.", 422);
      const owned = await db.select().from(dashboards).where(eq(dashboards.ownerHash, identity.hash));
      if (owned.length <= 1) return error("Minimal satu workspace harus ada.", 422);
      const target = owned.find((row) => row.id === id);
      if (!target) return error("Workspace tidak ditemukan.", 404);
      await db.delete(chartPanels).where(eq(chartPanels.dashboardId, id));
      await db.delete(dashboards).where(eq(dashboards.id, id));
      if (dashboard.id === id) {
        const remaining = (await db.select().from(dashboards).where(eq(dashboards.ownerHash, identity.hash)).orderBy(asc(dashboards.createdAt)))[0];
        if (remaining) headers.append("set-cookie", WS_COOKIE(remaining.id));
      }
      return json({ ok: true }, 200, headers);
    }
  }
  if (url.pathname === "/api/workspace-switch" && request.method === "POST") {
    const body = await parseBody(request);
    const id = typeof body?.id === "string" ? body.id : null;
    const owned = await db.select({ id: dashboards.id }).from(dashboards).where(eq(dashboards.ownerHash, identity.hash));
    if (!id || !owned.some((row) => row.id === id)) return error("Workspace tidak valid.", 422);
    headers.append("set-cookie", WS_COOKIE(id));
    return json({ ok: true }, 200, headers);
  }
  
  // ── Save layout ──
  if (url.pathname === "/api/layout" && request.method === "PUT") {
    const body = await parseBody(request);
    const columns = body?.columns;
    const panelIds = body?.panelIds;
    const owned = await db.select({ id: chartPanels.id }).from(chartPanels).where(eq(chartPanels.dashboardId, dashboard.id));
    if (!Number.isInteger(columns) || Number(columns) < 1 || Number(columns) > 4 || !Array.isArray(panelIds) || panelIds.length !== owned.length || new Set(panelIds).size !== panelIds.length || panelIds.some((id) => typeof id !== "string" || !owned.some((row) => row.id === id))) return error("Susunan dashboard tidak valid.", 422);
    await db.update(dashboards).set({ columns: Number(columns), updatedAt: new Date().toISOString() }).where(eq(dashboards.id, dashboard.id));
    for (const [index, id] of (panelIds as string[]).entries()) {
      await db.update(chartPanels).set({ position: index, updatedAt: new Date().toISOString() }).where(and(eq(chartPanels.id, id), eq(chartPanels.dashboardId, dashboard.id)));
    }
    return json({ ok: true }, 200, headers);
  }
  
  // ── Add panel (BINANCE USDT pairs beyond the catalog allowed too) ──
  if (url.pathname === "/api/panels" && request.method === "POST") {
    const body = await parseBody(request);
    const instrument = validInstrument(body?.provider, body?.symbol)
      ?? (body?.provider === "BINANCE" && typeof body?.symbol === "string" && /^BINANCE:[A-Z0-9]{2,12}USDT$/.test(body.symbol)
        ? { provider: "BINANCE" as Provider, symbol: body.symbol, label: body.symbol, base: body.symbol.split(":")[1].replace("USDT", ""), quote: "USDT", logo: null }
        : undefined);
    if (!instrument || !validTimeframe(body?.timeframe)) return error("Instrumen atau timeframe tidak valid.", 422);
    const rows = await db.select().from(chartPanels).where(eq(chartPanels.dashboardId, dashboard.id));
    if (rows.length >= MAX_PANELS) return error("Maksimum 16 chart.", 429);
    const row = { id: crypto.randomUUID(), dashboardId: dashboard.id, provider: instrument.provider, symbol: instrument.symbol, timeframe: body.timeframe as Timeframe, position: rows.length, span: 1 };
    await db.insert(chartPanels).values(row);
    return json(panelResponse({ ...row, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), 201, headers);
  }
  
  // ── Delete / Update panel by query param id ──
  if (url.pathname === "/api/panel") {
    const panelId = url.searchParams.get("id");
    if (!panelId) return error("Parameter panel id diperlukan.", 422);
    const current = (await db.select().from(chartPanels).where(and(eq(chartPanels.id, panelId), eq(chartPanels.dashboardId, dashboard.id))).limit(1))[0];
    if (!current) return error("Panel tidak ditemukan.", 404);
    if (request.method === "DELETE") {
      await db.delete(chartPanels).where(and(eq(chartPanels.id, panelId), eq(chartPanels.dashboardId, dashboard.id)));
      return json({ ok: true }, 200, headers);
    }
    if (request.method === "PUT") {
      const body = await parseBody(request);
      const provider = body?.provider ?? current.provider;
      const symbol = body?.symbol ?? current.symbol;
      const timeframe = body?.timeframe ?? current.timeframe;
      const span = body?.span ?? current.span;
      if (!validInstrument(provider, symbol) || !validTimeframe(timeframe) || !Number.isInteger(span) || Number(span) < 1 || Number(span) > 2) return error("Perubahan panel tidak valid.", 422);
      await db.update(chartPanels).set({ provider: String(provider), symbol: String(symbol), timeframe, span: Number(span), updatedAt: new Date().toISOString() }).where(and(eq(chartPanels.id, panelId), eq(chartPanels.dashboardId, dashboard.id)));
      const updated = (await db.select().from(chartPanels).where(eq(chartPanels.id, panelId)).limit(1))[0];
      return json(panelResponse(updated), 200, headers);
    }
  }

  // ── Portfolio holdings (PnL tracker) ──
  if (url.pathname === "/api/portfolio") {
    if (request.method === "GET") {
      const rows = await db.select().from(portfolioHoldings).where(eq(portfolioHoldings.ownerHash, identity.hash)).orderBy(asc(portfolioHoldings.symbol));
      return json(rows.map((row) => ({ id: row.id, symbol: row.symbol, base: row.base, quantity: row.quantity, avgPrice: row.avgPrice, createdAt: row.createdAt, updatedAt: row.updatedAt })), 200, headers);
    }
    if (request.method === "POST") {
      const body = await parseBody(request);
      const instrument = INSTRUMENTS.find((item) => item.symbol === body?.symbol);
      const quantity = Number(body?.quantity);
      const avgPrice = Number(body?.avgPrice);
      if (!instrument || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(avgPrice) || avgPrice <= 0) return error("Data holding tidak valid.", 422);
      const now = new Date().toISOString();
      const existing = (await db.select().from(portfolioHoldings).where(and(eq(portfolioHoldings.ownerHash, identity.hash), eq(portfolioHoldings.symbol, instrument.symbol))).limit(1))[0];
      let row;
      if (existing) {
        await db.update(portfolioHoldings).set({ quantity, avgPrice, updatedAt: now }).where(eq(portfolioHoldings.id, existing.id));
        row = { ...existing, quantity, avgPrice, updatedAt: now };
      } else {
        row = { id: crypto.randomUUID(), ownerHash: identity.hash, symbol: instrument.symbol, base: instrument.base, quantity, avgPrice, createdAt: now, updatedAt: now };
        await db.insert(portfolioHoldings).values(row);
      }
      return json({ id: row.id, symbol: row.symbol, base: row.base, quantity: row.quantity, avgPrice: row.avgPrice, createdAt: row.createdAt, updatedAt: row.updatedAt }, 200, headers);
    }
    if (request.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return error("Parameter holding id diperlukan.", 422);
      await db.delete(portfolioHoldings).where(and(eq(portfolioHoldings.id, id), eq(portfolioHoldings.ownerHash, identity.hash)));
      return json({ ok: true }, 200, headers);
    }
  }

  // ── Price alerts (GET/POST/PUT/DELETE) ──
  if (url.pathname === "/api/alerts") {
    if (request.method === "GET") {
      const rows = await db.select().from(priceAlerts).where(eq(priceAlerts.ownerHash, identity.hash)).orderBy(asc(priceAlerts.createdAt));
      return json(rows.map((row) => ({ id: row.id, symbol: row.symbol, direction: row.direction, targetPrice: row.targetPrice, active: row.active === 1, triggeredAt: row.triggeredAt, createdAt: row.createdAt })), 200, headers);
    }
    if (request.method === "POST") {
      const body = await parseBody(request);
      const instrument = INSTRUMENTS.find((item) => item.symbol === body?.symbol);
      const direction = body?.direction;
      const targetPrice = Number(body?.targetPrice);
      if (!instrument || (direction !== "above" && direction !== "below") || !Number.isFinite(targetPrice) || targetPrice <= 0) return error("Data alert tidak valid.", 422);
      const row = { id: crypto.randomUUID(), ownerHash: identity.hash, symbol: instrument.symbol, direction, targetPrice, active: 1, triggeredAt: null, createdAt: new Date().toISOString() };
      await db.insert(priceAlerts).values(row);
      return json({ id: row.id, symbol: row.symbol, direction: row.direction, targetPrice: row.targetPrice, active: true, triggeredAt: null, createdAt: row.createdAt }, 201, headers);
    }
    if (request.method === "PUT") {
      const body = await parseBody(request);
      const id = typeof body?.id === "string" ? body.id : null;
      if (!id) return error("Parameter alert id diperlukan.", 422);
      const current = (await db.select().from(priceAlerts).where(and(eq(priceAlerts.id, id), eq(priceAlerts.ownerHash, identity.hash))).limit(1))[0];
      if (!current) return error("Alert tidak ditemukan.", 404);
      const direction = body?.direction ?? current.direction;
      const targetPrice = body?.targetPrice === undefined ? current.targetPrice : Number(body?.targetPrice);
      const active = body?.active === undefined ? current.active : (body?.active ? 1 : 0);
      const triggeredAt = body?.triggeredAt !== undefined ? (typeof body?.triggeredAt === "string" ? body.triggeredAt : null) : (active === 1 ? null : current.triggeredAt);
      if ((direction !== "above" && direction !== "below") || !Number.isFinite(targetPrice) || targetPrice <= 0 || (active !== 0 && active !== 1)) return error("Perubahan alert tidak valid.", 422);
      await db.update(priceAlerts).set({ direction, targetPrice, active, triggeredAt }).where(eq(priceAlerts.id, id));
      const updated = (await db.select().from(priceAlerts).where(eq(priceAlerts.id, id)).limit(1))[0];
      return json({ id: updated.id, symbol: updated.symbol, direction: updated.direction, targetPrice: updated.targetPrice, active: updated.active === 1, triggeredAt: updated.triggeredAt, createdAt: updated.createdAt }, 200, headers);
    }
    if (request.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return error("Parameter alert id diperlukan.", 422);
      await db.delete(priceAlerts).where(and(eq(priceAlerts.id, id), eq(priceAlerts.ownerHash, identity.hash)));
      return json({ ok: true }, 200, headers);
    }
  }

  // ── AI Market Brief ──
  if (url.pathname === "/api/insight" && request.method === "POST") {
    const body = await parseBody(request);
    const requested = Array.isArray(body?.symbols) ? body.symbols.filter((item): item is string => typeof item === "string") : [];
    const symbols = [...new Set(requested)].filter((symbol) => INSTRUMENTS.some((item) => item.symbol === symbol)).slice(0, 16);
    return json(await generateInsight(symbols), 200, securityHeaders);
  }
  
  return error("Endpoint tidak ditemukan.", 404);
}
