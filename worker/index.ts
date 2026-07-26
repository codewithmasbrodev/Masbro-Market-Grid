import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { chartPanels, dashboards } from "../src/db/schema";
import { INSTRUMENTS, TIMEFRAMES, type ChartPanel, type Dashboard, type MarketSnapshot, type Provider, type Timeframe } from "../src/lib/types";

interface Env {
  DB: D1Database;
  MARKET_HUB: DurableObjectNamespace;
  GLOBAL_METRICS_API_URL?: string;
  GLOBAL_METRICS_API_KEY?: string;
}

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

async function owner(request: Request): Promise<{ token: string; hash: string; cookie?: string }> {
  const found = request.headers.get("cookie")?.match(/(?:^|;\s*)dmg_owner=([^;]+)/)?.[1];
  const token = found ?? crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { token, hash, cookie: found ? undefined : `dmg_owner=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` };
}

async function findDashboard(env: Env, ownerHash: string) {
  const db = getDb(env);
  return (await db.select().from(dashboards).where(eq(dashboards.ownerHash, ownerHash)).limit(1))[0];
}

async function ensureDashboard(env: Env, ownerHash: string): Promise<typeof dashboards.$inferSelect> {
  const existing = await findDashboard(env, ownerHash);
  if (existing) return existing;
  const dashboardId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO dashboards (id, owner_hash, name, columns) VALUES (?, ?, ?, ?)").bind(dashboardId, ownerHash, "MY MARKET GRID", 2),
    ...DEFAULTS.map((item, index) => env.DB.prepare("INSERT INTO chart_panels (id, dashboard_id, provider, symbol, timeframe, position, span) VALUES (?, ?, ?, ?, ?, ?, 1)").bind(crypto.randomUUID(), dashboardId, item.provider, item.symbol, item.timeframe, index)),
  ]);
  const created = await findDashboard(env, ownerHash);
  if (!created) throw new Error("Dashboard gagal dibuat.");
  return created;
}

async function fullDashboard(env: Env, ownerHash: string): Promise<Dashboard> {
  const dashboard = await ensureDashboard(env, ownerHash);
  const rows = await getDb(env).select().from(chartPanels).where(eq(chartPanels.dashboardId, dashboard.id)).orderBy(asc(chartPanels.position));
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

async function marketSnapshot(symbol: string, env?: Env): Promise<MarketSnapshot> {
  const unavailable = (): MarketSnapshot => ({ symbol, price: null, change24h: null, volume24h: null, timestamp: Date.now(), stale: true, sourceStatus: "unavailable" });
  try {
    if (symbol.startsWith("BINANCE:")) {
      const pair = symbol.split(":")[1];
      const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`, { cf: { cacheTtl: 0 } });
      if (!response.ok) return unavailable();
      const data = await response.json() as { lastPrice: string; priceChangePercent: string; quoteVolume: string; closeTime: number };
      return { symbol, price: Number(data.lastPrice), change24h: Number(data.priceChangePercent), volume24h: Number(data.quoteVolume), timestamp: data.closeTime, stale: Date.now() - data.closeTime > 60_000, sourceStatus: "live" };
    }
    if (symbol.startsWith("BITFINEX:")) {
      const pair = symbol.split(":")[1];
      const response = await fetch(`https://api-pub.bitfinex.com/v2/ticker/t${pair}`, { cf: { cacheTtl: 0 } });
      if (!response.ok) return unavailable();
      const data = await response.json() as number[];
      return { symbol, price: data[6] ?? null, change24h: (data[5] ?? 0) * 100, volume24h: data[7] ?? null, timestamp: Date.now(), stale: false, sourceStatus: "live" };
    }
    if (env?.GLOBAL_METRICS_API_URL) {
      const response = await fetch(`${env.GLOBAL_METRICS_API_URL}?symbol=${encodeURIComponent(symbol)}`, { headers: env.GLOBAL_METRICS_API_KEY ? { authorization: `Bearer ${env.GLOBAL_METRICS_API_KEY}` } : undefined });
      if (response.ok) {
        const data = await response.json() as { price: number; change24h?: number; timestamp?: number };
        return { symbol, price: data.price, change24h: data.change24h ?? null, volume24h: null, timestamp: data.timestamp ?? Date.now(), stale: false, sourceStatus: "live" };
      }
    }
    return unavailable();
  } catch { return unavailable(); }
}

export class MarketHub implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return error("WebSocket diperlukan.", 426);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ symbols: [] });
    server.send(JSON.stringify({ type: "status", status: "connecting" }));
    await this.state.storage.setAlarm(Date.now() + 250);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string" || message.length > 4096) return socket.close(1009, "Pesan terlalu besar");
    try {
      const parsed = JSON.parse(message) as { type?: string; symbols?: unknown };
      if (parsed.type === "ping") return socket.send(JSON.stringify({ type: "pong" }));
      if (parsed.type === "subscribe" && Array.isArray(parsed.symbols)) {
        const symbols = [...new Set(parsed.symbols.filter((value): value is string => typeof value === "string" && INSTRUMENTS.some((item) => item.symbol === value)))].slice(0, MAX_PANELS);
        socket.serializeAttachment({ symbols });
        const data = await Promise.all(symbols.map((symbol) => marketSnapshot(symbol, this.env)));
        socket.send(JSON.stringify({ type: "snapshot", data }));
        socket.send(JSON.stringify({ type: "status", status: data.some((item) => item.sourceStatus === "live") ? "live" : "degraded" }));
        await this.state.storage.setAlarm(Date.now() + 8_000);
      }
    } catch { socket.send(JSON.stringify({ type: "status", status: "degraded", message: "Pesan stream tidak valid." })); }
  }

  async alarm() {
    const sockets = this.state.getWebSockets();
    if (!sockets.length) return;
    const all = new Set<string>();
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment() as { symbols?: string[] } | null;
      attachment?.symbols?.forEach((symbol) => all.add(symbol));
    }
    const snapshots = await Promise.all([...all].map((symbol) => marketSnapshot(symbol, this.env)));
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment() as { symbols?: string[] } | null;
      const subscribed = new Set(attachment?.symbols ?? []);
      socket.send(JSON.stringify({ type: "tick", data: snapshots.filter((item) => subscribed.has(item.symbol)) }));
    }
    await this.state.storage.setAlarm(Date.now() + 8_000);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const securityHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (url.pathname === "/api/health") {
      try { await env.DB.prepare("SELECT 1").first(); return json({ ok: true, database: "available", feed: "available" }, 200, securityHeaders); }
      catch { return json({ ok: false, database: "unavailable", feed: "available" }, 503, securityHeaders); }
    }
    if (url.pathname === "/api/instruments" && request.method === "GET") {
      const query = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 60);
      const results = INSTRUMENTS.filter((item) => `${item.symbol} ${item.provider} ${item.label} ${item.base} ${item.quote}`.toLowerCase().includes(query)).slice(0, 40);
      return json(results, 200, securityHeaders);
    }
    if (url.pathname === "/api/market/snapshot" && request.method === "GET") {
      const symbols = [...new Set((url.searchParams.get("symbols") ?? "").split(","))].filter((symbol) => INSTRUMENTS.some((item) => item.symbol === symbol)).slice(0, MAX_PANELS);
      return json(await Promise.all(symbols.map((symbol) => marketSnapshot(symbol, env))), 200, securityHeaders);
    }
    if (url.pathname === "/api/market/stream") {
      const id = env.MARKET_HUB.idFromName("global-market-hub");
      return env.MARKET_HUB.get(id).fetch(request);
    }
    if (!url.pathname.startsWith("/api/dashboard")) return error("Endpoint tidak ditemukan.", 404);

    const identity = await owner(request);
    const headers = new Headers(securityHeaders);
    if (identity.cookie) headers.set("set-cookie", identity.cookie);
    try {
      if (url.pathname === "/api/dashboard" && request.method === "GET") return json(await fullDashboard(env, identity.hash), 200, headers);
      const dashboard = await ensureDashboard(env, identity.hash);
      const db = getDb(env);
      if (url.pathname === "/api/dashboard/layout" && request.method === "PUT") {
        const body = await parseBody(request);
        const columns = body?.columns;
        const panelIds = body?.panelIds;
        const owned = await db.select({ id: chartPanels.id }).from(chartPanels).where(eq(chartPanels.dashboardId, dashboard.id));
        if (!Number.isInteger(columns) || Number(columns) < 1 || Number(columns) > 4 || !Array.isArray(panelIds) || panelIds.length !== owned.length || new Set(panelIds).size !== panelIds.length || panelIds.some((id) => typeof id !== "string" || !owned.some((row) => row.id === id))) return error("Susunan dashboard tidak valid.", 422);
        await env.DB.batch([
          env.DB.prepare("UPDATE dashboards SET columns = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(columns, dashboard.id),
          ...panelIds.map((id, index) => env.DB.prepare("UPDATE chart_panels SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND dashboard_id = ?").bind(index, id, dashboard.id)),
        ]);
        return json({ ok: true }, 200, headers);
      }
      if (url.pathname === "/api/dashboard/panels" && request.method === "POST") {
        const body = await parseBody(request);
        const instrument = validInstrument(body?.provider, body?.symbol);
        if (!instrument || !validTimeframe(body?.timeframe)) return error("Instrumen atau timeframe tidak valid.", 422);
        const rows = await db.select().from(chartPanels).where(eq(chartPanels.dashboardId, dashboard.id));
        if (rows.length >= MAX_PANELS) return error("Maksimum 16 chart.", 429);
        const row = { id: crypto.randomUUID(), dashboardId: dashboard.id, provider: instrument.provider, symbol: instrument.symbol, timeframe: body.timeframe, position: rows.length, span: 1 };
        await db.insert(chartPanels).values(row);
        return json(panelResponse({ ...row, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), 201, headers);
      }
      const match = url.pathname.match(/^\/api\/dashboard\/panels\/([\w-]+)$/);
      if (match) {
        const panelId = match[1];
        const current = (await db.select().from(chartPanels).where(and(eq(chartPanels.id, panelId), eq(chartPanels.dashboardId, dashboard.id))).limit(1))[0];
        if (!current) return error("Panel tidak ditemukan.", 404);
        if (request.method === "DELETE") {
          await db.delete(chartPanels).where(and(eq(chartPanels.id, panelId), eq(chartPanels.dashboardId, dashboard.id)));
          return json({ ok: true }, 200, headers);
        }
        if (request.method === "PATCH") {
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
    } catch (cause) {
      console.error("Dashboard request failed", cause);
      return error("Layanan dashboard sedang bermasalah. Coba lagi.", 500);
    }
  },
} satisfies ExportedHandler<Env>;
