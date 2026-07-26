import type { ChartPanel, Dashboard, Instrument, MarketSnapshot, Provider, Timeframe } from "./types";

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

export const api = {
  dashboard: () => request<Dashboard>("/api/dashboard"),
  instruments: (query: string, signal?: AbortSignal) =>
    request<Instrument[]>(`/api/instruments?q=${encodeURIComponent(query)}`, { signal }),
  snapshots: (symbols: string[]) =>
    request<MarketSnapshot[]>(`/api/market/snapshot?symbols=${encodeURIComponent(symbols.join(","))}`),
  addPanel: (provider: Provider, symbol: string, timeframe: Timeframe) =>
    request<ChartPanel>("/api/dashboard/panels", jsonInit("POST", { provider, symbol, timeframe })),
  updatePanel: (id: string, changes: Partial<Pick<ChartPanel, "provider" | "symbol" | "timeframe" | "span">>) =>
    request<ChartPanel>(`/api/dashboard/panels/${id}`, jsonInit("PATCH", changes)),
  removePanel: (id: string) => request<{ ok: true }>(`/api/dashboard/panels/${id}`, { method: "DELETE" }),
  saveLayout: (columns: number, panelIds: string[]) =>
    request<{ ok: true }>("/api/dashboard/layout", jsonInit("PUT", { columns, panelIds })),
};
