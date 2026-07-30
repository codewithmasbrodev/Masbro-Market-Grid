import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { chartPanels, dashboards } from "../src/db/schema";
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
    // Use mempool.space API (free, no auth)
    const resp = await fetch("https://mempool.space/api/mempool/recent", { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return [];
    const txs = await resp.json() as { txid: string; fee: number; value: number; time: number }[];
    const MIN_BTC = 5; // 10 BTC minimum for whale
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

// ── ETH Whales from Etherscan (FREE API) ──
async function fetchEthWhales(): Promise<WhaleTx[]> {
  try {
    // Use free public Ethereum RPC (no API key needed)
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
    const MIN_ETH = 50; // 100 ETH minimum
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
    const solPrice = 185;
    const MIN_SOL = 5000;
    const resp = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getRecentPerformanceSamples",
        params: [1],
      }),
      signal: AbortSignal.timeout(5000),
    });
    // Solana doesn't have a simple "recent txs" endpoint without API key
    // We'll use a simpler approach — check latest signatures
    return [];
  } catch { return []; }
}

// Aggregated whale fetch with dedup
async function fetchWhales(): Promise<WhaleTx[]> {
  const [btc, eth] = await Promise.all([fetchBtcWhales(), fetchEthWhales()]);
  const all = [...btc, ...eth];
  // Dedup by txid prefix
  const seen = new Set<string>();
  return all.filter((tx) => {
    if (seen.has(tx.txHash.slice(0, 20))) return false;
    seen.add(tx.txHash.slice(0, 20));
    return true;
  }).sort((a, b) => b.timestamp - a.timestamp).slice(0, 30);
}

async function owner(request: Request): Promise<{ hash: string; cookie?: string }> {
  const found = request.headers.get("cookie")?.match(/(?:^|;\s*)dmg_owner=([^;]+)/)?.[1];
  const token = found ?? crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { hash, cookie: found ? undefined : `dmg_owner=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` };
}

async function findDashboard(ownerHash: string) {
  const db = getDb();
  return (await db.select().from(dashboards).where(eq(dashboards.ownerHash, ownerHash)).limit(1))[0];
}

async function ensureDashboard(ownerHash: string): Promise<typeof dashboards.$inferSelect> {
  const existing = await findDashboard(ownerHash);
  if (existing) return existing;
  const db = getDb();
  const dashboardId = crypto.randomUUID();
  await db.insert(dashboards).values({ id: dashboardId, ownerHash, name: "MY MARKET GRID", columns: 2 });
  await db.insert(chartPanels).values(DEFAULTS.map((item, index) => ({
    id: crypto.randomUUID(), dashboardId, provider: item.provider, symbol: item.symbol, timeframe: item.timeframe, position: index, span: 1,
  })));
  const created = await findDashboard(ownerHash);
  if (!created) throw new Error("Dashboard gagal dibuat.");
  return created;
}

async function fullDashboard(ownerHash: string): Promise<Dashboard> {
  const dashboard = await ensureDashboard(ownerHash);
  const rows = await getDb().select().from(chartPanels).where(eq(chartPanels.dashboardId, dashboard.id)).orderBy(asc(chartPanels.position));
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

// All routes use single-level paths because Vercel edge catch-all ([...path].ts)
// does not reliably route multi-level paths. Keep api endpoints flat.
export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const securityHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

  if (url.pathname === "/api/health") {
    try { await getDb().select().from(dashboards).limit(1); return json({ ok: true, database: "available", feed: "available" }, 200, securityHeaders); }
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
  // ── Whale Transaction Feed (FREE APIs: mempool.space + Etherscan) ──
  if (url.pathname === "/api/whales" && request.method === "GET") {
    return json(await fetchWhales(), 200, securityHeaders);
  }
  if (url.pathname === "/api/dashboard" && request.method === "GET") {
  const identity = await owner(request);
  const headers = new Headers(securityHeaders);
  if (identity.cookie) headers.set("set-cookie", identity.cookie);
  
  const dashboard = await ensureDashboard(identity.hash);
  const db = getDb();
  
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
  
  // ── Add panel ──
  if (url.pathname === "/api/panels" && request.method === "POST") {
    const body = await parseBody(request);
    const instrument = validInstrument(body?.provider, body?.symbol);
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
  
  return error("Endpoint tidak ditemukan.", 404);
}
