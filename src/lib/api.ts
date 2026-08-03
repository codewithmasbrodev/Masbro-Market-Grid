import type { ChartPanel, Dashboard, InsightResult, Instrument, MarketSnapshot, PortfolioHolding, PriceAlert, Provider, Timeframe } from "./types";

export interface WhaleTx {
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Permintaan gagal." })) as { error?: string };
    throw new Error(body.error ?? `Permintaan gagal (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// All API endpoints use single-level paths to work around a Vercel edge
// function catch-all ([...path].ts) routing issue with multi-level paths.
export const api = {
  dashboard: () => request<Dashboard>("/api/dashboard"),
  instruments: (query: string, signal?: AbortSignal) =>
    request<Instrument[]>(`/api/instruments?q=${encodeURIComponent(query)}`, { signal }),
  snapshots: (symbols: string[]) =>
    request<MarketSnapshot[]>(`/api/snapshot?symbols=${encodeURIComponent(symbols.join(","))}`),
  whales: () => request<WhaleTx[]>("/api/whales"),
  addPanel: (provider: Provider, symbol: string, timeframe: Timeframe) =>
    request<ChartPanel>("/api/panels", jsonInit("POST", { provider, symbol, timeframe })),
  updatePanel: (id: string, changes: Partial<Pick<ChartPanel, "provider" | "symbol" | "timeframe" | "span">>) =>
    request<ChartPanel>(`/api/panel?id=${id}`, jsonInit("PUT", changes)),
  removePanel: (id: string) => request<{ ok: true }>(`/api/panel?id=${id}`, { method: "DELETE" }),
  saveLayout: (columns: number, panelIds: string[]) =>
    request<{ ok: true }>("/api/layout", jsonInit("PUT", { columns, panelIds })),
  portfolio: () => request<PortfolioHolding[]>("/api/portfolio"),
  saveHolding: (holding: { symbol: string; quantity: number; avgPrice: number }) =>
    request<PortfolioHolding>("/api/portfolio", jsonInit("POST", holding)),
  removeHolding: (id: string) => request<{ ok: true }>(`/api/portfolio?id=${id}`, { method: "DELETE" }),
  alerts: () => request<PriceAlert[]>("/api/alerts"),
  createAlert: (alert: { symbol: string; direction: "above" | "below"; targetPrice: number }) =>
    request<PriceAlert>("/api/alerts", jsonInit("POST", alert)),
  updateAlert: (id: string, changes: Partial<Pick<PriceAlert, "active" | "direction" | "targetPrice">>) =>
    request<PriceAlert>("/api/alerts", jsonInit("PUT", { id, ...changes })),
  removeAlert: (id: string) => request<{ ok: true }>(`/api/alerts?id=${id}`, { method: "DELETE" }),
  insight: (symbols: string[]) =>
    request<InsightResult>("/api/insight", jsonInit("POST", { symbols })),
};
