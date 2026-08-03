import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, AlertTriangle, ArrowDown, ArrowRight, ArrowUp, BarChart3, Bell, ChartCandlestick, Check, Database, GripVertical, Keyboard, LayoutGrid, LayoutList, LoaderCircle, Move, Plus, Radio, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, Wallet, X, Zap } from "lucide-react";
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { api, type WhaleTx } from "./lib/api";
import { INSTRUMENTS, TIMEFRAMES, type ChartPanel as Panel, type ConnectionStatus, type Dashboard, type InsightResult, type Instrument, type Kline, type MarketSnapshot, type PortfolioHolding, type PriceAlert, type SentimentData, type Timeframe, type Workspace } from "./lib/types";
import "./styles.css";
import "./features.css";

const intervalMap: Record<Timeframe, string> = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1D": "D", "1W": "W" };
const money = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const instrumentBySymbol = new Map(INSTRUMENTS.map((instrument) => [instrument.symbol, instrument]));
const binanceWsSymbol = (symbol: string) => symbol.split(":")[1].toLowerCase();
const bitfinexWsSymbol = (symbol: string) => `t${symbol.split(":")[1].toUpperCase()}`;

function playAlertSound() {
  try {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    for (const [freq, start] of [[880, 0], [1174.66, 0.18], [880, 0.36]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.12, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + 0.2);
    }
    window.setTimeout(() => void ctx.close().catch(() => undefined), 1200);
  } catch { /* audio unavailable */ }
}

const SHORTCUTS: [string, string][] = [
  ["1", "View MONITOR (grid)"],
  ["2", "Chart analisis penuh (candlestick real)"],
  ["3", "View PAIRS (screener)"],
  ["A", "Buka Price Alerts"],
  ["P", "Buka Portfolio & P&L"],
  ["I", "Buka MASBRO AI"],
  ["/", "Tambah chart ke grid"],
  ["?", "Bantuan pintasan ini"],
];

function movingAverage(candles: Kline[], period: number): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
    out.push({ time: candles[i].time, value: sum / period });
  }
  return out;
}

function computeRsi(candles: Kline[], period = 14): { time: number; value: number }[] {
  if (candles.length <= period) return [];
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out: { time: number; value: number }[] = [];
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out.push({ time: candles[i].time, value: 100 - 100 / (1 + rs) });
  }
  return out;
}

function AssetLogo({ instrument, symbol, size = "normal" }: { instrument?: Instrument; symbol: string; size?: "normal" | "large" }) {
  const [failed, setFailed] = useState(false);
  const rawAsset = instrument?.base ?? symbol.split(":")[1] ?? "?";
  const fallback = rawAsset.replace(/[^A-Z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";
  const logoUrl = instrument?.logo ? `https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color/${instrument.logo}.svg` : null;
  useEffect(() => setFailed(false), [logoUrl]);
  return <span className={`asset-logo ${size === "large" ? "large" : ""} ${failed || !logoUrl ? "fallback" : ""}`} aria-hidden="true">
    {logoUrl && !failed ? <img src={logoUrl} alt="" loading="lazy" onError={() => setFailed(true)} /> : <span>{fallback}</span>}
  </span>;
}

function TradingViewChart({ panel, retryKey }: { panel: Panel; retryKey: number }) {
  const src = `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(panel.symbol)}&interval=${intervalMap[panel.timeframe]}&theme=dark&style=1&locale=id&hide_side_toolbar=1&allow_symbol_change=0&save_image=0&calendar=0&utm_source=defi-market-grid`;
  return <iframe key={`${panel.symbol}-${panel.timeframe}-${retryKey}`} className="chart-frame" title={`Chart ${panel.symbol}`} src={src} loading="lazy" allowFullScreen />;
}

function ConnectionBadge({ status, onRetry }: { status: ConnectionStatus; onRetry: () => void }) {
  const labels: Record<ConnectionStatus, string> = { connecting: "MENGHUBUNGKAN", live: "LIVE", reconnecting: "MENYAMBUNG ULANG", degraded: "TERBATAS", offline: "OFFLINE" };
  return <button className={`connection ${status}`} onClick={onRetry} title="Klik untuk sambungkan ulang"><span className="pulse" />{labels[status]}</button>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const modal = ref.current;
    modal?.querySelector<HTMLElement>("input,button,select")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab" && modal) {
        const items = [...modal.querySelectorAll<HTMLElement>("button,input,select,[tabindex]:not([tabindex='-1'])")];
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref}><div className="modal-head"><div><span className="eyebrow">GRID MODULE</span><h2 id="modal-title">{title}</h2></div><button className="icon-btn" onClick={onClose} aria-label="Tutup dialog"><X /></button></div>{children}</div></div>;
}

function InstrumentSearch({ onClose, onAdd, initial }: { onClose: () => void; onAdd: (instrument: Instrument, timeframe: Timeframe) => Promise<void>; initial?: Panel }) {
  const [query, setQuery] = useState(initial?.symbol.split(":")[1] ?? "");
  const [results, setResults] = useState<Instrument[]>(INSTRUMENTS);
  const [selected, setSelected] = useState<Instrument | null>(initial ? instrumentBySymbol.get(initial.symbol) ?? null : null);
  const [timeframe, setTimeframe] = useState<Timeframe>(initial?.timeframe ?? "1h");
  const [busySymbol, setBusySymbol] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setFailed("");
    const timer = window.setTimeout(() => api.instruments(query, controller.signal).then(setResults).catch((error: Error) => error.name !== "AbortError" && setFailed(error.message)).finally(() => setLoading(false)), 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);
  const add = async (instrument: Instrument) => {
    setBusySymbol(instrument.symbol); setFailed("");
    try { await onAdd(instrument, timeframe); onClose(); }
    catch (error) { setFailed(error instanceof Error ? error.message : "Gagal menyimpan."); setBusySymbol(null); }
  };
  return <Modal title={initial ? "ATUR CHART" : "TAMBAH CHART"} onClose={onClose}>
    {!initial && <p className="catalog-intro">Katalog pair TradingView-compatible. Pilih timeframe, lalu tambahkan dalam sekali klik.</p>}
    <div className="catalog-tools">
      <div><label className="field-label" htmlFor="instrument-query">Cari coin, pair, atau exchange</label><div className="search-box"><Search /><input id="instrument-query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="BTC, ETHUSDT, Binance…" /><span className="result-count">{loading ? "…" : results.length}</span></div></div>
      <div className="timeframe-field"><label className="field-label" htmlFor="add-timeframe">Timeframe</label><select id="add-timeframe" className="select-wide" value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)}>{TIMEFRAMES.map((tf) => <option key={tf}>{tf}</option>)}</select></div>
    </div>
    <div className="catalog-label"><span>INSTRUMEN TERSEDIA</span><span>SIMBOL / EXCHANGE</span></div>
    <div className="instrument-list catalog" role="listbox" aria-label="Katalog instrumen">
      {results.map((item) => <div key={item.symbol} className={`instrument-row ${selected?.symbol === item.symbol ? "selected" : ""}`}>
        <button className="instrument-select" role="option" aria-selected={selected?.symbol === item.symbol} onClick={() => initial ? setSelected(item) : void add(item)} disabled={busySymbol !== null}>
          <AssetLogo instrument={item} symbol={item.symbol} />
          <span className="instrument-copy"><strong>{item.base}<i> / {item.quote}</i></strong><small>{item.label}</small><em>{item.symbol}</em></span>
          <span className={`exchange-tag ${item.provider.toLowerCase()}`}>{item.provider}</span>
        </button>
        {!initial && <button className="quick-add" aria-label={`Tambahkan ${item.symbol}`} title="Tambah chart" onClick={() => void add(item)} disabled={busySymbol !== null}>{busySymbol === item.symbol ? <LoaderCircle className="spin" /> : <Plus />}</button>}
        {initial && selected?.symbol === item.symbol && <Check className="selected-check" />}
      </div>)}
      {!loading && !results.length && <div className="no-results"><Search /><strong>Tidak ditemukan</strong><span>Coba simbol, nama coin, atau exchange lain.</span></div>}
    </div>
    {failed && <p className="form-error"><AlertTriangle />{failed}</p>}
    {initial && <div className="modal-actions"><button className="btn ghost" onClick={onClose}>BATAL</button><button className="btn primary" disabled={!selected || busySymbol !== null} onClick={() => selected && void add(selected)}>{busySymbol ? <LoaderCircle className="spin" /> : <Check />} SIMPAN</button></div>}
  </Modal>;
}

function ChartPanel({ panel, snapshot, onTimeframe, onRemove, onMove, onEdit, onChart, draggable, onDragStart, onDrop }: { panel: Panel; snapshot?: MarketSnapshot; onTimeframe: (tf: Timeframe) => void; onRemove: () => void; onMove: (direction: -1 | 1) => void; onEdit: () => void; onChart: () => void; draggable: boolean; onDragStart: () => void; onDrop: () => void }) {
  const [retryKey, setRetryKey] = useState(0);
  const pair = panel.symbol.split(":")[1];
  const instrument = instrumentBySymbol.get(panel.symbol);
  const change = snapshot?.change24h;
  const selectTimeframe = (timeframe: Timeframe) => {
    if (timeframe === panel.timeframe) return;
    onTimeframe(timeframe);
  };
  return <article className="market-panel" draggable={draggable} onDragStart={onDragStart} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
    <header className="panel-head">
      <button className="drag-handle" aria-label={`Seret ${panel.symbol}`} title="Seret untuk menyusun"><GripVertical /></button>
      <AssetLogo instrument={instrument} symbol={panel.symbol} />
      <div className="asset-title"><span>{panel.provider}</span><h2>{pair}</h2></div>
      <div className="price-block"><strong>{snapshot?.price == null ? "—" : instrument?.quote === "%" ? `${snapshot.price.toFixed(2)}%` : `${money.format(snapshot.price)}`}</strong><span className={change == null ? "muted" : change >= 0 ? "positive" : "negative"}>{change == null ? "DATA TERTUNDA" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</span></div>
      <div className="panel-actions"><button className="icon-btn" onClick={() => onMove(-1)} aria-label="Pindah ke atas"><ArrowUp /></button><button className="icon-btn" onClick={() => onMove(1)} aria-label="Pindah ke bawah"><ArrowDown /></button><button className="icon-btn" onClick={onEdit} aria-label={`Atur ${panel.symbol}`}><Settings2 /></button><button className="icon-btn danger" onClick={onRemove} aria-label={`Hapus ${panel.symbol}`}><Trash2 /></button></div>
    </header>
    <div className="panel-meta"><div className="timeframes" role="group" aria-label={`Timeframe ${panel.symbol}`}>{TIMEFRAMES.map((tf) => <button key={tf} type="button" className={panel.timeframe === tf ? "active" : ""} aria-pressed={panel.timeframe === tf} onPointerDown={(event) => event.stopPropagation()} onClick={() => selectTimeframe(tf)}>{tf}</button>)}</div><span className="volume">VOL 24H&nbsp; {snapshot?.volume24h == null ? "—" : compact.format(snapshot.volume24h)}</span><button className="icon-btn chart-analyze" onClick={onChart} title={`Analisis real ${panel.symbol}`} aria-label={`Analisis ${panel.symbol}`}><ChartCandlestick /></button></div>
    <div className="chart-wrap"><TradingViewChart panel={panel} retryKey={retryKey} />{snapshot?.sourceStatus === "unavailable" && <div className="data-warning"><AlertTriangle />Feed harga belum tersedia <button onClick={() => setRetryKey((v) => v + 1)}><RefreshCw /> Coba chart</button></div>}</div>
  </article>;
}

function Brand({ href = "/" }: { href?: string }) {
  return <a className="brand" href={href} aria-label="Market Grid intellegence"><span className="brand-mark"><BarChart3 /></span><span><strong>MARKET GRID</strong> INTELLEGENCE<small>REAL-TIME CRYPTO MONITOR</small></span></a>;
}

function CreatorCredit() {
  return <a className="creator-credit" href="https://www.instagram.com/masbro.web4/" target="_blank" rel="noopener noreferrer" aria-label="Created by Masbro — buka profil Instagram @masbro.web4">Created by Masbro</a>;
}

function LandingPreview() {
  const preview = ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT", "BINANCE:SOLUSDT"];
  return <div className="landing-preview" aria-label="Pratinjau dashboard Market Grid intellegence">
    <div className="preview-bar"><span><i /> LIVE MARKET GRID</span><div><b>1</b><b className="active">2</b><b>3</b></div></div>
    <div className="preview-grid">
      {preview.map((symbol, index) => {
        const instrument = instrumentBySymbol.get(symbol)!;
        const prices = ["104,284.20", "3,412.64", "188.37"];
        const changes = ["+2.41%", "+1.08%", "−0.62%"];
        return <div className={`preview-card preview-${index}`} key={symbol}>
          <div className="preview-card-head"><AssetLogo instrument={instrument} symbol={symbol} /><span><small>{instrument.provider}</small><strong>{instrument.base}<i>/{instrument.quote}</i></strong></span><em className={index === 2 ? "negative" : "positive"}>{changes[index]}</em></div>
          <div className="preview-price">${prices[index]}</div>
          <svg className="sparkline" viewBox="0 0 240 72" preserveAspectRatio="none" aria-hidden="true"><path className="spark-fill" d={index === 2 ? "M0 8 L30 18 L55 14 L80 32 L110 29 L140 50 L165 44 L195 62 L220 54 L240 68 L240 72 L0 72Z" : "M0 64 L25 55 L48 58 L70 39 L96 45 L120 25 L145 31 L170 17 L195 23 L218 9 L240 13 L240 72 L0 72Z"}/><path d={index === 2 ? "M0 8 L30 18 L55 14 L80 32 L110 29 L140 50 L165 44 L195 62 L220 54 L240 68" : "M0 64 L25 55 L48 58 L70 39 L96 45 L120 25 L145 31 L170 17 L195 23 L218 9 L240 13"}/></svg>
          <div className="preview-time"><b>1M</b><b>5M</b><b className="active">1H</b><b>1D</b></div>
        </div>;
      })}
    </div>
    <div className="preview-save"><Check /> LAYOUT TERSIMPAN <span>·</span> UPDATE 2 DETIK LALU</div>
  </div>;
}

const landingFeatures = [
  { icon: Radio, tag: "01 / LIVE", title: "DATA PASAR TANPA REFRESH", text: "Feed harga berjalan melalui koneksi live dengan status, reconnect otomatis, dan pembaruan 24 jam." },
  { icon: BarChart3, tag: "02 / CHART", title: "ANALISIS TRADINGVIEW", text: "Chart kompatibel TradingView untuk pair pilihan Anda, lengkap dengan tujuh pilihan timeframe." },
  { icon: Search, tag: "03 / DISCOVER", title: "CARI. KLIK. PANTAU.", text: "Temukan coin, pair, atau exchange beserta logo aset dan tambahkan chart dalam sekali klik." },
  { icon: Move, tag: "04 / GRID", title: "WORKSPACE MILIK ANDA", text: "Susun ulang panel, pilih jumlah kolom, dan simpan layout modular secara otomatis." },
];

function LandingPage() {
  return <div className="landing-shell">
    <div className="ticker-strip landing-ticker"><div className="ticker-track"><span className="ticker-group"><span>MARKET GRID INTELLEGENCE // MARKET INTELLIGENCE</span><span>BINANCE · BITFINEX · CRYPTOCAP · TRADINGVIEW</span><span><i className="dot live" /> SYSTEM ONLINE</span></span><span className="ticker-group" aria-hidden="true"><span>MARKET GRID INTELLEGENCE // MARKET INTELLIGENCE</span><span>BINANCE · BITFINEX · CRYPTOCAP · TRADINGVIEW</span><span><i className="dot live" /> SYSTEM ONLINE</span></span></div></div>
    <header className="landing-nav"><Brand /><nav aria-label="Navigasi utama"><a href="#fitur">FITUR</a><a href="#cara-kerja">CARA KERJA</a><a href="#market">MARKET</a></nav><a className="btn primary" href="/dashboard">BUKA DASHBOARD <ArrowRight /></a></header>
    <main className="landing-main">
      <section className="hero">
        <div className="hero-copy"><div className="hero-status"><span><i className="dot live" /> LIVE FEED AKTIF</span><span>31 INSTRUMEN</span></div><span className="eyebrow">CRYPTO MARKET COMMAND CENTER</span><h1>PASAR BERGERAK.<br/><em>ANDA LEBIH CEPAT.</em></h1><p>Pantau pasar kripto real-time, analisis chart, dan bangun workspace modular Anda—semua dalam satu grid yang fokus dan responsif.</p><div className="hero-actions"><a className="btn primary hero-cta" href="/dashboard">BUKA DASHBOARD <ArrowRight /></a><a className="btn ghost hero-cta" href="#fitur">JELAJAHI FITUR</a></div><div className="hero-trust"><span><ShieldCheck /> API PUBLIK & AMAN</span><span><Zap /> UPDATE TANPA REFRESH</span><span><Database /> LAYOUT TERSIMPAN</span></div></div>
        <div className="hero-visual"><div className="visual-label">// YOUR MARKET. YOUR GRID.</div><LandingPreview /><div className="float-chip chip-live"><i className="dot live" /> WEBSOCKET LIVE</div><div className="float-chip chip-pairs">31 PAIR <strong>+</strong></div></div>
      </section>
      <section className="market-ribbon" id="market" aria-label="Instrumen unggulan"><div className="ribbon-track">{["BTC / USDT", "ETH / USD", "SOL / USDT", "XRP / USDT", "DOGE / USDT", "TOTAL MARKET", "BTC / USDT", "ETH / USD", "SOL / USDT", "XRP / USDT", "DOGE / USDT", "TOTAL MARKET"].map((pair, i) => <span key={`${pair}-${i}`}><b>{pair}</b><em className={i % 6 === 4 ? "negative" : "positive"}>{i % 6 === 4 ? "−0.31%" : `+${(0.84 + (i % 6) * .43).toFixed(2)}%`}</em></span>)}</div></section>
      <section className="landing-section features" id="fitur"><div className="section-heading"><div><span className="eyebrow">BUILT FOR CLARITY / NOT NOISE</span><h2>SEMUA YANG ANDA BUTUHKAN.<br/><em>TANPA DISTRAKSI.</em></h2></div><p>Peralatan market esensial dalam antarmuka brutalist yang cepat, modular, dan tetap nyaman di setiap layar.</p></div><div className="feature-grid">{landingFeatures.map(({ icon: Icon, tag, title, text }) => <article className="feature-card" key={tag}><div><span>{tag}</span><Icon /></div><h3>{title}</h3><p>{text}</p><a href="/dashboard">COBA SEKARANG <ArrowRight /></a></article>)}</div></section>
      <section className="landing-section workflow" id="cara-kerja"><div className="workflow-copy"><span className="eyebrow">DARI NOL KE MARKET GRID</span><h2>TIGA LANGKAH.<br/><em>SATU WORKSPACE.</em></h2><p>Tidak perlu konfigurasi rumit. Dashboard siap dipakai dan tersimpan untuk kunjungan berikutnya.</p><a className="btn primary hero-cta" href="/dashboard">MULAI PANTAU PASAR <ArrowRight /></a></div><ol><li><span>01</span><div><Search /><h3>CARI INSTRUMEN</h3><p>Telusuri coin, pair, atau exchange dari katalog terintegrasi.</p></div></li><li><span>02</span><div><SlidersHorizontal /><h3>PILIH TIMEFRAME</h3><p>Tetapkan rentang dari 1 menit hingga 1 minggu.</p></div></li><li><span>03</span><div><LayoutGrid /><h3>SUSUN GRID</h3><p>Atur posisi dan kolom. Layout tersimpan otomatis.</p></div></li></ol></section>
      <section className="final-cta"><div><span className="eyebrow">MARKET TIDAK MENUNGGU</span><h2>BANGUN MARKET GRID<br/>ANDA SEKARANG.</h2></div><div><p>Feed live. Chart profesional. Workspace pribadi.</p><a className="btn primary hero-cta" href="/dashboard">BUKA DASHBOARD <ArrowRight /></a></div></section>
    </main>
    <footer className="landing-footer"><Brand href="/" /><p>Chart oleh TradingView. Data pasar dari Binance dan Bitfinex.<br/>Hanya untuk informasi, bukan nasihat finansial.<br/><CreatorCredit /></p><div><span>© 2026 MARKET GRID INTELLEGENCE</span><a href="/dashboard">DASHBOARD →</a></div></footer>
  </div>;
}

function PortfolioModal({ holdings, prices, onClose, onSave, onRemove }: { holdings: PortfolioHolding[]; prices: Record<string, MarketSnapshot>; onClose: () => void; onSave: (symbol: string, quantity: number, avgPrice: number) => Promise<void>; onRemove: (id: string) => Promise<void> }) {
  const [symbol, setSymbol] = useState("BINANCE:BTCUSDT");
  const [quantity, setQuantity] = useState("1");
  const [avgPrice, setAvgPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tradables = INSTRUMENTS.filter((item) => item.provider !== "CRYPTOCAP");
  const rows = holdings.map((h) => {
    const price = prices[h.symbol]?.price ?? null;
    const value = price != null ? price * h.quantity : null;
    const cost = h.avgPrice * h.quantity;
    const pnl = value != null ? value - cost : null;
    const pnlPct = cost > 0 && pnl != null ? (pnl / cost) * 100 : null;
    return { ...h, price, value, cost, pnl, pnlPct };
  });
  const totalValue = rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
  const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
  const totalPnl = totalValue - totalCost;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : null;
  const submit = async () => {
    const qty = Number(quantity);
    const avg = Number(avgPrice);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(avg) || avg <= 0) { setError("Jumlah dan harga beli harus angka positif."); return; }
    setBusy(true); setError("");
    try { await onSave(symbol, qty, avg); setQuantity(""); setAvgPrice(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Gagal menyimpan holding."); }
    finally { setBusy(false); }
  };
  return <Modal title="PORTFOLIO & P&L TRACKER" onClose={onClose}>
    <div className="portfolio-summary">
      <div><span>NILAI TOTAL</span><strong>${compact.format(totalValue)}</strong></div>
      <div><span>MODAL / COST</span><strong>${compact.format(totalCost)}</strong></div>
      <div className={totalPnl >= 0 ? "positive" : "negative"}><span>UNREALIZED P&L</span><strong>{totalPnl >= 0 ? "+" : ""}${compact.format(totalPnl)}<em>{totalPnlPct != null ? `${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(2)}%` : "—"}</em></strong></div>
    </div>
    <div className="holding-form">
      <div className="holding-fields">
        <div><label className="field-label" htmlFor="holding-symbol">INSTRUMEN</label><select id="holding-symbol" className="select-wide" value={symbol} onChange={(e) => setSymbol(e.target.value)}>{tradables.map((item) => <option key={item.symbol} value={item.symbol}>{item.base}/{item.quote} · {item.provider}</option>)}</select></div>
        <div><label className="field-label" htmlFor="holding-qty">JUMLAH</label><input id="holding-qty" className="input-dark" type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0.00" /></div>
        <div><label className="field-label" htmlFor="holding-avg">HARGA BELI</label><input id="holding-avg" className="input-dark" type="number" min="0" step="any" value={avgPrice} onChange={(e) => setAvgPrice(e.target.value)} placeholder="0.00" /></div>
        <button className="btn primary" onClick={() => void submit()} disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <Plus />} TAMBAH</button>
      </div>
      {error && <p className="form-error"><AlertTriangle />{error}</p>}
    </div>
    <div className="catalog-label"><span>HOLDINGS</span><span>P&L / POSISI</span></div>
    {rows.length ? <div className="holding-list">
      {rows.map((row) => <div className="holding-row" key={row.id}>
        <AssetLogo instrument={instrumentBySymbol.get(row.symbol)} symbol={row.symbol} />
        <div className="holding-main"><strong>{row.base}</strong><small>{row.symbol.split(":")[1]}</small></div>
        <div className="holding-num"><small>HARGA</small><strong>{row.price != null ? `$${money.format(row.price)}` : "—"}</strong></div>
        <div className="holding-num"><small>JUMLAH</small><strong>{row.quantity}</strong></div>
        <div className="holding-num"><small>HARGA BELI</small><strong>${money.format(row.avgPrice)}</strong></div>
        <div className="holding-num"><small>NILAI</small><strong>${compact.format(row.value ?? 0)}</strong></div>
        <div className={`holding-num ${row.pnl == null ? "muted" : row.pnl >= 0 ? "positive" : "negative"}`}><small>P&L</small><strong>{row.pnl == null ? "—" : `${row.pnl >= 0 ? "+" : ""}$${compact.format(row.pnl)}`}{row.pnlPct != null && <em>{`${row.pnlPct >= 0 ? "+" : ""}${row.pnlPct.toFixed(2)}%`}</em>}</strong></div>
        <button className="icon-btn danger" onClick={() => void onRemove(row.id)} aria-label={`Hapus ${row.symbol}`}><Trash2 /></button>
      </div>)}
    </div> : <p className="modal-empty">Belum ada holding. Tambahkan aset pertama Anda untuk mulai melacak P&L.</p>}
  </Modal>;
}

function AlertModal({ alerts, prices, onClose, onCreate, onToggle, onRemove }: { alerts: PriceAlert[]; prices: Record<string, MarketSnapshot>; onClose: () => void; onCreate: (symbol: string, direction: "above" | "below", targetPrice: number) => Promise<void>; onToggle: (alert: PriceAlert) => Promise<void>; onRemove: (id: string) => Promise<void> }) {
  const [symbol, setSymbol] = useState("BINANCE:BTCUSDT");
  const [direction, setDirection] = useState<"above" | "below">("above");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const currentPrice = prices[symbol]?.price;
  const tradables = INSTRUMENTS.filter((item) => item.provider !== "CRYPTOCAP");
  const askPermission = () => { if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission(); };
  const submit = async () => {
    const value = Number(target);
    if (!Number.isFinite(value) || value <= 0) { setError("Target harga harus angka positif."); return; }
    setBusy(true); setError("");
    try { await onCreate(symbol, direction, value); setTarget(""); askPermission(); }
    catch (e) { setError(e instanceof Error ? e.message : "Gagal membuat alert."); }
    finally { setBusy(false); }
  };
  return <Modal title="PRICE ALERTS" onClose={onClose}>
    <div className="alert-form">
      <div className="alert-fields">
        <div><label className="field-label" htmlFor="alert-symbol">INSTRUMEN</label><select id="alert-symbol" className="select-wide" value={symbol} onChange={(e) => setSymbol(e.target.value)}>{tradables.map((item) => <option key={item.symbol} value={item.symbol}>{item.base}/{item.quote}</option>)}</select>{currentPrice != null && <p className="alert-current">Harga saat ini: <strong>${money.format(currentPrice)}</strong></p>}</div>
        <div><label className="field-label" htmlFor="alert-direction">KONDISI</label><select id="alert-direction" className="select-wide" value={direction} onChange={(e) => setDirection(e.target.value as "above" | "below")}><option value="above">Tembus ke ATAS</option><option value="below">Tembus ke BAWAH</option></select></div>
        <div><label className="field-label" htmlFor="alert-target">HARGA TARGET</label><input id="alert-target" className="input-dark" type="number" min="0" step="any" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="0.00" /></div>
        <button className="btn primary" onClick={() => void submit()} disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <Bell />} BUAT ALERT</button>
      </div>
      {error && <p className="form-error"><AlertTriangle />{error}</p>}
      {typeof Notification !== "undefined" && Notification.permission === "default" && <div className="alert-perm"><button className="btn ghost" onClick={askPermission}><Bell /> AKTIFKAN NOTIFIKASI BROWSER</button><span>Dapatkan notifikasi walau tab di latar belakang.</span></div>}
      {typeof Notification !== "undefined" && Notification.permission === "granted" && <p className="alert-current positive">✓ Notifikasi browser AKTIF</p>}
    </div>
    <div className="catalog-label"><span>ALERTS</span><span>STATUS</span></div>
    {alerts.length ? <div className="alert-list">
      {alerts.map((alert) => {
        const current = prices[alert.symbol]?.price;
        const hit = current != null && (alert.direction === "above" ? current >= alert.targetPrice : current <= alert.targetPrice);
        return <div className={`alert-row ${!alert.active ? "inactive" : ""}`} key={alert.id}>
          <div className="alert-main"><strong>{alert.symbol.split(":")[1] ?? alert.symbol}</strong><small>{alert.direction === "above" ? "⬆ ATAS" : "⬇ BAWAH"} ${money.format(alert.targetPrice)}{current != null && <em> · SEKARANG ${money.format(current)}</em>}</small></div>
          <span className={`alert-state ${!alert.active ? "done" : hit ? "hit" : "armed"}`}>{!alert.active ? "TERPICU" : hit ? "TERPENUHI" : "SIAGA"}</span>
          <button className={`toggle ${alert.active ? "on" : ""}`} onClick={() => void onToggle(alert)} aria-label={alert.active ? "Nonaktifkan alert" : "Aktifkan alert"} title={alert.active ? "Nonaktifkan" : "Aktifkan"}><i /></button>
          <button className="icon-btn danger" onClick={() => void onRemove(alert.id)} aria-label={`Hapus alert ${alert.symbol}`}><Trash2 /></button>
        </div>;
      })}
    </div> : <p className="modal-empty">Belum ada alert. Atur target harga untuk mulai dipantau.</p>}
    {alerts.some((a) => a.triggeredAt) && <>
      <div className="catalog-label"><span>HISTORI TERPICU</span><span>TIME</span></div>
      <div className="alert-history">
        {alerts.filter((a) => a.triggeredAt).slice(0, 20).map((a) => (
          <div className="alert-row inactive" key={`hist-${a.id}`}>
            <div className="alert-main"><strong>{a.symbol.split(":")[1] ?? a.symbol}</strong><small>{a.direction === "above" ? "⬆ ATAS" : "⬇ BAWAH"} ${money.format(a.targetPrice)}</small></div>
            <span className="history-time">{new Date(a.triggeredAt!).toLocaleString("id-ID", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
            <span className="alert-state done">TERPICU</span>
          </div>
        ))}
      </div>
    </>}
  </Modal>;
}

function InsightModal({ insight, loading, error, onGenerate, onClose }: { insight: InsightResult | null; loading: boolean; error: string; onGenerate: () => void; onClose: () => void }) {
  return <Modal title="MASBRO AI — MARKET BRIEF" onClose={onClose}>
    <div className="insight-body">
      <p className="insight-intro">Rangkuman pasar real-time dari data grid Anda. <em>{insight?.provider === "openai" ? "Dibuat oleh OpenAI (gpt-4o-mini)." : "Analisis lokal — tambahkan OPENAI_API_KEY untuk brief AI penuh."}</em></p>
      {loading ? <div className="insight-loading"><LoaderCircle className="spin" /><span>MENGANALISIS PASAR…</span></div>
        : error ? <p className="form-error"><AlertTriangle />{error}</p>
        : insight ? <pre className="insight-text">{insight.summary}</pre>
        : <p className="modal-empty">Klik tombol di bawah untuk membuat market brief terbaru.</p>}
      <div className="modal-actions"><button className="btn ghost" onClick={onClose}>TUTUP</button><button className="btn primary" onClick={onGenerate} disabled={loading}><Sparkles /> {insight ? "BRIEF BARU" : "BUAT MARKET BRIEF"}</button></div>
    </div>
  </Modal>;
}

function SentimentStrip({ data }: { data: SentimentData | null }) {
  const fng = data?.fearGreed;
  const funding = data?.funding ?? [];
  const nextFunding = funding.length ? Math.min(...funding.map((f) => f.nextFundingTime)) : null;
  return <section className="sentiment-strip" aria-label="Sentimen pasar">
    <div className="fng-cell">
      <span className="sent-label">FEAR & GREED</span>
      {fng ? <>
        <div className="fng-bar"><i style={{ width: `${Math.max(2, Math.min(98, fng.value))}%` }} className={fng.value >= 55 ? "greedy" : fng.value <= 45 ? "fear" : ""} /></div>
        <strong className={fng.value >= 55 ? "positive" : fng.value <= 45 ? "negative" : ""}>{fng.value}</strong>
        <em>{fng.classification.toUpperCase()}</em>
      </> : <span className="sent-na">DATA TIDAK TERSEDIA</span>}
    </div>
    <div className="funding-cell">
      <span className="sent-label">FUNDING RATE PERP{nextFunding ? ` · NEXT ${new Date(nextFunding).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })} UTC` : ""}</span>
      <div className="funding-list">
        {funding.length ? funding.map((f) => (
          <span key={f.symbol}><b>{f.symbol.replace("USDT", "")}</b><em className={f.lastFundingRate >= 0 ? "positive" : "negative"}>{(f.lastFundingRate * 100).toFixed(3)}%</em></span>
        )) : <span className="sent-na">—</span>}
      </div>
    </div>
  </section>;
}

interface ScreenerRow { symbol: string; base: string; price: number; change24h: number; quoteVolume: number; }

function Screener({ onAdd }: { onAdd: (symbol: string) => Promise<void> }) {
  const [rows, setRows] = useState<ScreenerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<"quoteVolume" | "change24h" | "price">("quoteVolume");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true); setError("");
      try {
        const res = await fetch("https://api.binance.com/api/v3/ticker/24hr");
        if (!res.ok) throw new Error("HTTP");
        const all = await res.json() as { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string }[];
        const list = all
          .filter((t) => t.symbol.endsWith("USDT"))
          .map((t) => ({ symbol: `BINANCE:${t.symbol}`, base: t.symbol.replace("USDT", ""), price: Number(t.lastPrice), change24h: Number(t.priceChangePercent), quoteVolume: Number(t.quoteVolume) }))
          .sort((a, b) => b.quoteVolume - a.quoteVolume)
          .slice(0, 120);
        if (!cancelled) setRows(list);
      } catch { if (!cancelled) setError("Feed Binance tidak tersedia — cek koneksi."); }
      finally { if (!cancelled) setLoading(false); }
    };
    void load();
    const timer = window.setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? rows.filter((r) => r.base.toLowerCase().includes(q) || r.symbol.toLowerCase().includes(q)) : rows;
    return [...list].sort((a, b) => (dir === "desc" ? b[sortKey] - a[sortKey] : a[sortKey] - b[sortKey]));
  }, [rows, query, sortKey, dir]);
  const header = (key: "quoteVolume" | "change24h" | "price", label: string) => (
    <button className={`sort-btn ${sortKey === key ? "active" : ""}`} onClick={() => { if (sortKey === key) setDir((d) => (d === "desc" ? "asc" : "desc")); else { setSortKey(key); setDir("desc"); } }}>{label}{sortKey === key ? (dir === "desc" ? " ↓" : " ↑") : ""}</button>
  );
  const add = async (row: ScreenerRow) => {
    setAdding(row.symbol);
    try { await onAdd(row.symbol); }
    finally { setAdding(null); }
  };
  return <section className="screener">
    <div className="screener-toolbar">
      <div className="search-box"><Search /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cari pair… (mis. BTC)" /><span className="result-count">{loading ? "…" : visible.length}</span></div>
      <span className="screener-hint">KLIK BARIS UNTUK TAMBAH KE GRID · TOP {rows.length} PAIR USDT (BINANCE)</span>
    </div>
    <div className="screener-head"><span>#</span><span>PAIR</span>{header("price", "HARGA")}{header("change24h", "24J")}{header("quoteVolume", "VOLUME 24J (USD)")}<span /></div>
    {loading && !rows.length ? <div className="screener-empty"><LoaderCircle className="spin" /> MEMUAT FEED…</div>
      : error ? <div className="screener-empty"><AlertTriangle /> {error}</div>
      : <div className="screener-list">
          {visible.map((row, i) => (
            <button key={row.symbol} className="screener-row" disabled={adding !== null} onClick={() => void add(row)}>
              <span className="rank">{i + 1}</span>
              <span className="pair"><AssetLogo instrument={instrumentBySymbol.get(row.symbol)} symbol={row.symbol} /><b>{row.base}<i>/USDT</i></b></span>
              <span className="price">${row.price < 0.01 ? row.price.toFixed(6) : row.price < 1 ? row.price.toFixed(4) : money.format(row.price)}</span>
              <span className={row.change24h >= 0 ? "positive" : "negative"}>{row.change24h >= 0 ? "+" : ""}{row.change24h.toFixed(2)}%</span>
              <span className="volume">${compact.format(row.quoteVolume)}</span>
              <span className="add-hint">{adding === row.symbol ? <LoaderCircle className="spin" /> : "+"}</span>
            </button>
          ))}
          {!visible.length && !loading && <div className="screener-empty">Tidak ada pair yang cocok.</div>}
        </div>}
  </section>;
}

function BigChartModal({ panel, price, onClose }: { panel: Panel; price?: number | null; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{ candle?: ISeriesApi<"Candlestick">; volume?: ISeriesApi<"Histogram">; ma20?: ISeriesApi<"Line">; ma50?: ISeriesApi<"Line">; rsi?: ISeriesApi<"Line"> }>({});
  const indicatorState = useRef<{ length: number; showMA: boolean; showRSI: boolean }>({ length: 0, showMA: false, showRSI: false });
  const [timeframe, setTimeframe] = useState<Timeframe>(panel.timeframe);
  const [candles, setCandles] = useState<Kline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showMA, setShowMA] = useState(true);
  const [showRSI, setShowRSI] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    api.klines(panel.symbol, timeframe, 300)
      .then((data) => { if (!cancelled) setCandles(data); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [panel.symbol, timeframe]);

  // Live-update the last candle with the current tick price.
  useEffect(() => {
    if (price == null) return;
    setCandles((current) => {
      if (!current.length) return current;
      const last = current[current.length - 1];
      if (Math.abs(last.close - price) < 1e-9) return current;
      const updated = [...current];
      updated[updated.length - 1] = { ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price) };
      return updated;
    });
  }, [price]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: "#050505" }, textColor: "#7d8a7d", fontFamily: "'Courier New', monospace", fontSize: 10 },
      grid: { vertLines: { color: "#101010" }, horzLines: { color: "#101010" } },
      rightPriceScale: { borderColor: "#222" },
      timeScale: { borderColor: "#222", timeVisible: true, secondsVisible: false, borderVisible: true },
      crosshair: { mode: CrosshairMode.Normal },
      width: container.clientWidth,
      height: 330,
    });
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = {}; indicatorState.current = { length: 0, showMA: false, showRSI: false }; };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !candles.length) return;
    const s = seriesRef.current;
    let candle = s.candle;
    if (!candle) {
      candle = chart.addSeries(CandlestickSeries, {
        upColor: "#33ff33", downColor: "#ff4444", borderUpColor: "#33ff33", borderDownColor: "#ff4444", wickUpColor: "#33ff33", wickDownColor: "#ff4444",
      });
      s.candle = candle;
      const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol" });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      s.volume = volume;
    }
    candle.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    s.volume?.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? "rgba(51,255,51,.35)" : "rgba(255,68,68,.35)" })));
    const prev = indicatorState.current;
    const rebuild = candles.length !== prev.length || showMA !== prev.showMA || showRSI !== prev.showRSI;
    indicatorState.current = { length: candles.length, showMA, showRSI };
    if (rebuild) {
      for (const key of ["ma20", "ma50", "rsi"] as const) { const existing = s[key]; if (existing) { chart.removeSeries(existing); s[key] = undefined; } }
      if (showMA) {
        s.ma20 = chart.addSeries(LineSeries, { color: "#00ccff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        s.ma20.setData(movingAverage(candles, 20).map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
        s.ma50 = chart.addSeries(LineSeries, { color: "#ffb000", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        s.ma50.setData(movingAverage(candles, 50).map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
      }
      if (showRSI && candles.length > 20) {
        const rsi = chart.addSeries(LineSeries, { color: "#cc66ff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceScaleId: "rsi" });
        rsi.priceScale().applyOptions({ scaleMargins: { top: 0.72, bottom: 0.06 } });
        rsi.setData(computeRsi(candles).map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
        s.rsi = rsi;
      }
      chart.timeScale().fitContent();
    }
  }, [candles, showMA, showRSI]);

  return <Modal title={`ANALISIS REAL — ${panel.symbol.split(":")[1] ?? panel.symbol}`} onClose={onClose}>
    <div className="big-chart">
      <div className="indicator-bar">
        <span className="ind-label">INDIKATOR</span>
        <button className={`toggle-chip ${showMA ? "on" : ""}`} onClick={() => setShowMA((v) => !v)}>MA 20/50</button>
        <button className={`toggle-chip ${showRSI ? "on" : ""}`} onClick={() => setShowRSI((v) => !v)}>RSI 14</button>
        <span className="ind-spacer" />
        <span className="ind-label">TIMEFRAME</span>
        {TIMEFRAMES.map((tf) => <button key={tf} className={`tf-chip ${timeframe === tf ? "active" : ""}`} onClick={() => setTimeframe(tf)}>{tf}</button>)}
      </div>
      <div className="chart-stage" ref={containerRef}>
        {loading && <div className="chart-placeholder"><LoaderCircle className="spin" /> MEMUAT KANDEL…</div>}
        {!loading && error && <div className="chart-placeholder error"><AlertTriangle /> {error}</div>}
        {!loading && !error && !candles.length && <div className="chart-placeholder">BELUM ADA DATA</div>}
      </div>
      <p className="big-chart-note">Kandle real dari {panel.provider}. MA & RSI dihitung di sisi klien; harga live meng-update kandle terakhir.</p>
    </div>
  </Modal>;
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return <div className="help-backdrop" onClick={onClose}>
    <div className="help-panel" role="dialog" aria-label="Pintasan keyboard" onClick={(e) => e.stopPropagation()}>
      <div className="modal-head"><div><span className="eyebrow">KEYBOARD</span><h2>PINTASAN TERMINAL</h2></div><button className="icon-btn" onClick={onClose} aria-label="Tutup"><X /></button></div>
      <div className="shortcut-grid">{SHORTCUTS.map(([key, label]) => <div key={key}><kbd>{key}</kbd><span>{label}</span></div>)}</div>
      <p className="shortcut-note">Pintasan aktif saat tidak mengetik di kolom input. <kbd>ESC</kbd> menutup dialog.</p>
    </div>
  </div>;
}

function DashboardApp() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, MarketSnapshot>>({});
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [loadingError, setLoadingError] = useState("");
  const [modal, setModal] = useState<"add" | "edit" | "delete" | null>(null);
  const [activePanel, setActivePanel] = useState<Panel | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [streamKey, setStreamKey] = useState(0);
  const [dragged, setDragged] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [whales, setWhales] = useState<WhaleTx[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioHolding[]>([]);
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [showPortfolio, setShowPortfolio] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const [showInsight, setShowInsight] = useState(false);
  const [insight, setInsight] = useState<InsightResult | null>(null);
  const [insightError, setInsightError] = useState("");
  const [insightLoading, setInsightLoading] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: "info" | "alert" | "error" }[]>([]);
  const panelMutationVersion = useRef<Record<string, number>>({});
  const panelMutationQueue = useRef<Record<string, Promise<unknown>>>({});
  const alertsRef = useRef<PriceAlert[]>([]);
  const triggeredRef = useRef<Set<string>>(new Set());
  const toastId = useRef(0);
  const [view, setView] = useState<"monitor" | "screener">("monitor");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sentiment, setSentiment] = useState<SentimentData | null>(null);
  const [showChart, setShowChart] = useState(false);
  const [chartPanel, setChartPanel] = useState<Panel | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [confirmDeleteWs, setConfirmDeleteWs] = useState<string | null>(null);

  const load = useCallback(() => { setLoadingError(""); api.dashboard().then(setDashboard).catch((error: Error) => setLoadingError(error.message)); }, []);
  useEffect(load, [load]);
  const symbols = useMemo(() => [...new Set(dashboard?.panels.map((p) => p.symbol) ?? [])], [dashboard]);

  const pushToast = useCallback((text: string, kind: "info" | "alert" | "error" = "info") => {
    const id = ++toastId.current;
    setToasts((current) => [...current.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 6000);
  }, []);

  // Merge fresh market data into state and check price-alert triggers.
  const applyLive = useCallback((data: MarketSnapshot[]) => {
    if (!data.length) return;
    setSnapshots((current) => ({ ...current, ...Object.fromEntries(data.map((item) => [item.symbol, item])) }));
    const active = alertsRef.current.filter((alert) => alert.active);
    if (!active.length) return;
    for (const alert of active) {
      const snapshot = data.find((item) => item.symbol === alert.symbol);
      const price = snapshot?.price;
      if (price == null || triggeredRef.current.has(alert.id)) continue;
      const hit = alert.direction === "above" ? price >= alert.targetPrice : price <= alert.targetPrice;
      if (!hit) continue;
      triggeredRef.current.add(alert.id);
      const label = alert.symbol.split(":")[1] ?? alert.symbol;
      const text = `${label} ${alert.direction === "above" ? "menembus ATAS" : "turun menembus BAWAH"} target $${alert.targetPrice.toLocaleString("en-US")} — sekarang $${price.toLocaleString("en-US")}`;
      pushToast(text, "alert");
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try { new Notification(`⚠ PRICE ALERT — ${label}`, { body: text }); } catch { /* ignore */ }
      }
      playAlertSound();
      setAlerts((current) => current.map((a) => a.id === alert.id ? { ...a, active: false, triggeredAt: new Date().toISOString() } : a));
      void api.updateAlert(alert.id, { active: false, triggeredAt: new Date().toISOString() }).catch(() => undefined);
    }
  }, [pushToast]);
  // Vercel has no persistent WebSocket / Durable Object equivalent, so we poll the
  // existing /api/market/snapshot endpoint instead of streaming over a socket.
  useEffect(() => {
    if (!symbols.length) { setStatus("offline"); return; }
    let cancelled = false, failures = 0;
    const tick = async (isFirst: boolean) => {
      if (cancelled) return;
      setStatus((current) => (isFirst ? "connecting" : current === "live" || current === "degraded" ? current : "connecting"));
      try {
        const data = await api.snapshots(symbols);
        if (cancelled) return;
        failures = 0;
        applyLive(data);
        setLastUpdate(Date.now());
        setStatus(data.some((item) => item.sourceStatus === "live") ? "live" : "degraded");
      } catch {
        if (cancelled) return;
        failures++;
        setStatus(failures > 2 ? "degraded" : "reconnecting");
      }
    };
    void tick(true);
    const poll = window.setInterval(() => void tick(false), 8_000);
    return () => { cancelled = true; clearInterval(poll); };
  }, [symbols, streamKey, applyLive]);
  
  // Poll whale transactions
  useEffect(() => {
    let cancelled = false;
    const fetchWhales = async () => {
      try {
        const data = await api.whales();
        if (!cancelled) setWhales(data.slice(0, 10));
      } catch {}
    };
    void fetchWhales();
    const interval = window.setInterval(fetchWhales, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Load portfolio holdings + price alerts for this device
  useEffect(() => {
    api.portfolio().then(setPortfolio).catch(() => undefined);
    api.alerts().then((data) => { setAlerts(data); alertsRef.current = data; }).catch(() => undefined);
  }, []);
  useEffect(() => { alertsRef.current = alerts; }, [alerts]);

  const loadWorkspaces = useCallback(() => { api.workspaces().then(setWorkspaces).catch(() => undefined); }, []);
  useEffect(loadWorkspaces, [loadWorkspaces]);

  // Fear & Greed + funding rate widgets
  useEffect(() => {
    let cancelled = false;
    const loadSentiment = async () => {
      try { const data = await api.sentiment(); if (!cancelled) setSentiment(data); } catch { /* ignore */ }
    };
    void loadSentiment();
    const timer = window.setInterval(loadSentiment, 120000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // Real-time WebSocket feeds (Binance + Bitfinex) straight from the browser,
  // with the 8s polling above kept as an automatic fallback.
  useEffect(() => {
    if (!symbols.length) return;
    let closed = false;
    let currentSockets: WebSocket[] = [];
    let bitfinexChannels = new Map<number, string>();
    const binanceSymbols = symbols.filter((s) => s.startsWith("BINANCE:"));
    const bitfinexSymbols = symbols.filter((s) => s.startsWith("BITFINEX:"));
    if (!binanceSymbols.length && !bitfinexSymbols.length) return;

    const connect = () => {
      for (const ws of currentSockets) { try { ws.close(); } catch { /* ignore */ } }
      currentSockets = [];
      bitfinexChannels = new Map();
      if (binanceSymbols.length) {
        try {
          const stream = binanceSymbols.map((s) => `${binanceWsSymbol(s)}@miniTicker`).join("/");
          const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${stream}`);
          currentSockets.push(ws);
          let opened = false;
          ws.onopen = () => { opened = true; setStatus("live"); };
          ws.onmessage = (event) => {
            try {
              const message = JSON.parse(event.data as string) as { stream?: string; data?: { s?: string; c?: string; o?: string; v?: string } };
              const data = message.data;
              if (!message.stream || !data?.s || !data.c) return;
              const price = Number(data.c);
              if (!Number.isFinite(price) || price <= 0) return;
              const open = Number(data.o);
              const change = open > 0 ? ((price - open) / open) * 100 : null;
              applyLive([{ symbol: `BINANCE:${data.s}`, price, change24h: change, volume24h: Number(data.v ?? 0), timestamp: Date.now(), stale: false, sourceStatus: "live" }]);
            } catch { /* malformed frame */ }
          };
          ws.onerror = () => { if (opened) setStatus("reconnecting"); };
          ws.onclose = () => { if (!closed && opened) setStatus("reconnecting"); };
        } catch { /* ws unavailable */ }
      }
      if (bitfinexSymbols.length) {
        try {
          const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
          currentSockets.push(ws);
          ws.onopen = () => {
            setStatus("live");
            for (const symbol of bitfinexSymbols) {
              ws.send(JSON.stringify({ event: "subscribe", channel: "ticker", symbol: bitfinexWsSymbol(symbol) }));
            }
          };
          ws.onmessage = (event) => {
            try {
              const message = JSON.parse(event.data as string) as unknown;
              if (Array.isArray(message) && typeof message[0] === "number") {
                const symbol = bitfinexChannels.get(message[0]);
                const tick = message[1] as number[] | undefined;
                if (!symbol || !Array.isArray(tick)) return;
                const price = tick[6];
                const change = tick[5];
                if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return;
                applyLive([{ symbol, price, change24h: typeof change === "number" ? change * 100 : null, volume24h: typeof tick[7] === "number" ? tick[7] : null, timestamp: Date.now(), stale: false, sourceStatus: "live" }]);
              } else if (message && typeof message === "object" && (message as { event?: string }).event === "subscribed" && typeof (message as { chanId?: number }).chanId === "number") {
                const sub = message as { chanId: number; symbol: string };
                bitfinexChannels.set(sub.chanId, sub.symbol.replace("t", "BITFINEX:"));
              }
            } catch { /* malformed frame */ }
          };
          ws.onerror = () => setStatus("reconnecting");
          ws.onclose = () => { if (!closed) setStatus("reconnecting"); };
        } catch { /* ws unavailable */ }
      }
    };

    connect();
    const keepalive = window.setInterval(() => {
      if (currentSockets.length && currentSockets.every((ws) => ws.readyState === WebSocket.CLOSED)) connect();
    }, 12000);
    return () => {
      closed = true;
      clearInterval(keepalive);
      for (const ws of currentSockets) { try { ws.close(); } catch { /* ignore */ } }
    };
  }, [symbols, streamKey, applyLive]);

  const saveLayout = async (panels: Panel[], columns = dashboard?.columns ?? 2) => {
    if (!dashboard) return;
    const old = dashboard;
    const positioned = panels.map((panel, position) => ({ ...panel, position }));
    setDashboard({ ...dashboard, panels: positioned, columns }); setSaving(true);
    try { await api.saveLayout(columns, positioned.map((p) => p.id)); }
    catch (error) { setDashboard(old); setAnnouncement(error instanceof Error ? error.message : "Gagal menyimpan susunan."); }
    finally { setSaving(false); }
  };
  const move = (id: string, direction: -1 | 1) => {
    if (!dashboard) return;
    const index = dashboard.panels.findIndex((p) => p.id === id), target = index + direction;
    if (target < 0 || target >= dashboard.panels.length) return;
    const next = [...dashboard.panels]; [next[index], next[target]] = [next[target], next[index]];
    setAnnouncement(`${dashboard.panels[index].symbol} dipindahkan ke posisi ${target + 1}.`); void saveLayout(next);
  };
  const mutatePanel = async (panel: Panel, changes: Partial<Panel>) => {
    if (!dashboard) return;
    const version = (panelMutationVersion.current[panel.id] ?? 0) + 1;
    panelMutationVersion.current[panel.id] = version;
    const previous = panel;
    setDashboard((current) => current ? { ...current, panels: current.panels.map((item) => item.id === panel.id ? { ...item, ...changes } : item) } : current);
    setSaving(true);
    try {
      const request = (panelMutationQueue.current[panel.id] ?? Promise.resolve()).catch(() => undefined).then(() => api.updatePanel(panel.id, changes));
      panelMutationQueue.current[panel.id] = request;
      const updated = await request;
      if (panelMutationVersion.current[panel.id] !== version) return;
      setDashboard((current) => current ? { ...current, panels: current.panels.map((item) => item.id === panel.id ? updated : item) } : current);
      if (changes.timeframe) setAnnouncement(`${panel.symbol} sekarang menggunakan timeframe ${changes.timeframe}.`);
    } catch (error) {
      if (panelMutationVersion.current[panel.id] === version) {
        setDashboard((current) => current ? { ...current, panels: current.panels.map((item) => item.id === panel.id ? previous : item) } : current);
        setAnnouncement(error instanceof Error ? error.message : "Perubahan gagal.");
      }
      throw error;
    } finally {
      if (panelMutationVersion.current[panel.id] === version) setSaving(false);
    }
  };
  const remove = async () => {
    if (!dashboard || !activePanel) return; const old = dashboard; setModal(null); setDashboard({ ...dashboard, panels: dashboard.panels.filter((p) => p.id !== activePanel.id) }); setSaving(true);
    try { await api.removePanel(activePanel.id); setAnnouncement(`${activePanel.symbol} dihapus.`); }
    catch (error) { setDashboard(old); setAnnouncement(error instanceof Error ? error.message : "Gagal menghapus."); }
    finally { setSaving(false); setActivePanel(null); }
  };

  const portfolioValue = useMemo(() => portfolio.reduce((sum, h) => sum + (snapshots[h.symbol]?.price ?? 0) * h.quantity, 0), [portfolio, snapshots]);
  const portfolioCost = useMemo(() => portfolio.reduce((sum, h) => sum + h.avgPrice * h.quantity, 0), [portfolio]);
  const portfolioPnl = portfolioValue - portfolioCost;
  const portfolioPnlPct = portfolioCost > 0 ? (portfolioPnl / portfolioCost) * 100 : null;
  const activeAlertCount = alerts.filter((alert) => alert.active).length;

  const saveHolding = useCallback(async (symbol: string, quantity: number, avgPrice: number) => {
    const saved = await api.saveHolding({ symbol, quantity, avgPrice });
    setPortfolio((current) => [...current.filter((h) => h.symbol !== symbol), saved].sort((a, b) => a.symbol.localeCompare(b.symbol)));
    pushToast(`${symbol.split(":")[1] ?? symbol} tersimpan di portfolio.`, "info");
  }, [pushToast]);

  const removeHolding = useCallback(async (id: string) => {
    await api.removeHolding(id);
    setPortfolio((current) => current.filter((h) => h.id !== id));
    pushToast("Holding dihapus.", "info");
  }, [pushToast]);

  const createAlert = useCallback(async (symbol: string, direction: "above" | "below", targetPrice: number) => {
    const created = await api.createAlert({ symbol, direction, targetPrice });
    setAlerts((current) => [...current, created]);
    pushToast(`Alert ${symbol.split(":")[1] ?? symbol} dibuat.`, "info");
  }, [pushToast]);

  const toggleAlert = useCallback(async (alert: PriceAlert) => {
    const updated = await api.updateAlert(alert.id, { active: !alert.active });
    if (updated.active) triggeredRef.current.delete(alert.id);
    setAlerts((current) => current.map((a) => a.id === alert.id ? updated : a));
    pushToast(updated.active ? "Alert diaktifkan kembali." : "Alert dinonaktifkan.", "info");
  }, [pushToast]);

  const removeAlert = useCallback(async (id: string) => {
    await api.removeAlert(id);
    setAlerts((current) => current.filter((a) => a.id !== id));
    triggeredRef.current.delete(id);
    pushToast("Alert dihapus.", "info");
  }, [pushToast]);

  const generateInsight = useCallback(async () => {
    setInsightLoading(true); setInsightError("");
    try { setInsight(await api.insight(symbols)); }
    catch (error) { setInsightError(error instanceof Error ? error.message : "Gagal menghasilkan brief."); }
    finally { setInsightLoading(false); }
  }, [symbols]);

  const switchWorkspace = useCallback(async (id: string) => {
    if (id === dashboard?.id) return;
    try {
      await api.switchWorkspace(id);
      loadWorkspaces();
      load();
    } catch (e) { pushToast(e instanceof Error ? e.message : "Gagal berpindah workspace.", "error"); }
  }, [dashboard?.id, load, loadWorkspaces, pushToast]);

  const createWorkspace = useCallback(async () => {
    try {
      const created = await api.createWorkspace();
      loadWorkspaces();
      load();
      pushToast(`Workspace baru dibuat: ${created.name}`, "info");
    } catch (e) { pushToast(e instanceof Error ? e.message : "Gagal membuat workspace.", "error"); }
  }, [load, loadWorkspaces, pushToast]);

  const deleteWorkspace = useCallback(async () => {
    if (!confirmDeleteWs) return;
    try {
      await api.deleteWorkspace(confirmDeleteWs);
      pushToast("Workspace dihapus.", "info");
    } catch (e) { pushToast(e instanceof Error ? e.message : "Gagal menghapus workspace.", "error"); }
    setConfirmDeleteWs(null);
    loadWorkspaces();
    load();
  }, [confirmDeleteWs, load, loadWorkspaces, pushToast]);

  const addFromScreener = useCallback(async (symbol: string) => {
    try {
      const added = await api.addPanel("BINANCE", symbol, "1h");
      setDashboard((cur) => cur ? { ...cur, panels: [...cur.panels, added] } : cur);
      pushToast(`${symbol.split(":")[1] ?? symbol} ditambahkan ke grid.`, "info");
      setView("monitor");
    } catch (e) { pushToast(e instanceof Error ? e.message : "Gagal menambahkan pair.", "error"); }
  }, [pushToast]);

  // Bloomberg-style keyboard shortcuts
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
      const anyModalOpen = modal !== null || confirmDeleteWs !== null || showPortfolio || showAlerts || showInsight || showChart || showHelp;
      if (anyModalOpen) return;
      const key = event.key.toLowerCase();
      if (key === "1") setView("monitor");
      else if (key === "2") { const first = dashboard?.panels[0]; if (first) { setChartPanel(first); setShowChart(true); } }
      else if (key === "3") setView("screener");
      else if (key === "/") { event.preventDefault(); setModal("add"); }
      else if (key === "a") setShowAlerts(true);
      else if (key === "p") setShowPortfolio(true);
      else if (key === "i") { setShowInsight(true); void generateInsight(); }
      else if (key === "?") setShowHelp((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, confirmDeleteWs, showPortfolio, showAlerts, showInsight, showChart, showHelp, dashboard?.panels, generateInsight]);

  if (loadingError) return <main className="center-state"><AlertTriangle /><h1>DASHBOARD TIDAK TERJANGKAU</h1><p>{loadingError}</p><button className="btn primary" onClick={load}><RefreshCw /> COBA LAGI</button></main>;
  if (!dashboard) return <main className="center-state"><LoaderCircle className="spin" /><h1>MENYUSUN MARKET GRID</h1><p>Memuat panel dan menghubungkan feed pasar…</p></main>;

  return <div className="app-shell">
    {/* Bloomberg Amber Command Bar */}
    <div className="bb-bar">
      <span className="bb-title"><strong>MARKET GRID</strong> INTELLIGENCE</span>
      <span className="bb-status">
        <span><span className="dot green" /> SYS:{status === "live" ? "OK" : status.toUpperCase()}</span>
        <span className="live">FEED:{(symbols.length > 0 && Object.keys(snapshots).length > 0) ? "LIVE" : "IDLE"}</span>
        <span>UTC {new Date().toISOString().slice(11, 19)}</span>
      </span>
    </div>

    {/* Bloomberg Tab Navigation (keyboard: 1 / 2 / 3) */}
    <div className="bb-tabs">
      <button className={`tab ${view === "monitor" ? "active" : ""}`} onClick={() => setView("monitor")}><span className="key">[1]</span> MONITOR</button>
      <button className="tab" onClick={() => { const first = dashboard.panels[0]; if (first) { setChartPanel(first); setShowChart(true); } }}><span className="key">[2]</span> CHARTS</button>
      <button className={`tab ${view === "screener" ? "active" : ""}`} onClick={() => setView("screener")}><span className="key">[3]</span> PAIRS</button>
      <span className="tab hint"><Keyboard /> [1]GRID [2]CHART [3]PAIRS · A ALERTS · P PORTFOLIO · I AI · / ADD · ? HELP</span>
    </div>

    {/* Compact Topbar */}
    <header className="topbar">
      <Brand href="/" />
      <div className="top-actions">
        <button className="btn ghost alert-bell" onClick={() => setShowAlerts(true)} title="Price alerts"><Bell /><span className="btn-label">ALERTS</span>{activeAlertCount > 0 && <span className="badge">{activeAlertCount}</span>}</button>
        <button className="btn ghost" onClick={() => setShowPortfolio(true)} title="Portfolio & PnL"><Wallet /><span className="btn-label">PORTFOLIO</span></button>
        <button className="btn ghost ai-btn" onClick={() => { setShowInsight(true); void generateInsight(); }} title="MASBRO AI — Market brief"><Sparkles /><span className="btn-label">MASBRO AI</span></button>
        <ConnectionBadge status={status} onRetry={() => setStreamKey((v) => v + 1)} />
        <span className="updated">LAST<strong>{lastUpdate ? new Date(lastUpdate).toLocaleTimeString("id-ID") : "—"}</strong></span>
        <button className="btn primary" onClick={() => setModal("add")}><Plus /> <span>ADD</span></button>
      </div>
    </header>

    {/* Main Workspace */}
    <main id="top">
      <section className="workspace-head">
        <div>
          <span className="eyebrow">WORKSPACE / 01</span>
          <h1>{dashboard.name}</h1>
          <p>{dashboard.panels.length} MODULES · REAL-TIME</p>
        </div>
        <div className="workspace-control">
          <label><LayoutList /> WS</label>
          <select value={dashboard.id} onChange={(e) => void switchWorkspace(e.target.value)} title="Ganti workspace" aria-label="Ganti workspace">
            {workspaces.map((ws) => <option key={ws.id} value={ws.id}>{ws.name}</option>)}
          </select>
          <button className="icon-btn" onClick={() => void createWorkspace()} title="Buat workspace baru" aria-label="Buat workspace baru"><Plus /></button>
          <button className="icon-btn danger" onClick={() => setConfirmDeleteWs(dashboard.id)} title="Hapus workspace ini" aria-label="Hapus workspace" disabled={workspaces.length <= 1}><Trash2 /></button>
        </div>
        <div className="layout-control">
          <label><LayoutGrid /> COL</label>
          {[1, 2, 3, 4].map((count) => <button key={count} aria-label={`${count} kolom`} className={dashboard.columns === count ? "active" : ""} onClick={() => void saveLayout(dashboard.panels, count)}>{count}</button>)}
          <span className={saving ? "saving active" : "saving"}>{saving ? "SAVE…" : "SAVED"}</span>
        </div>
      </section>

      {portfolio.length > 0 && (
        <section className="portfolio-strip" aria-label="Ringkasan portfolio">
          <div><span>NILAI PORTFOLIO</span><strong>${compact.format(portfolioValue)}</strong></div>
          <div><span>MODAL / COST</span><strong>${compact.format(portfolioCost)}</strong></div>
          <div className={portfolioPnl >= 0 ? "positive" : "negative"}><span>UNREALIZED P&L</span><strong>{portfolioPnl >= 0 ? "+" : ""}{compact.format(portfolioPnl)}<em>{portfolioPnlPct == null ? "" : `${portfolioPnlPct >= 0 ? "+" : ""}${portfolioPnlPct.toFixed(2)}%`}</em></strong></div>
          <div className="portfolio-open"><button className="btn ghost" onClick={() => setShowPortfolio(true)}><Wallet /> KELOLA</button></div>
        </section>
      )}

      <SentimentStrip data={sentiment} />

      {/* Market Grid */}
      {view === "screener" ? (
        <Screener onAdd={addFromScreener} />
      ) : dashboard.panels.length ? (
        <section className="market-grid" style={{ "--columns": dashboard.columns } as React.CSSProperties}>
          {dashboard.panels.map((panel) => <ChartPanel key={panel.id} panel={panel} snapshot={snapshots[panel.symbol]} draggable onDragStart={() => setDragged(panel.id)} onDrop={() => { if (!dragged || dragged === panel.id) return; const next = [...dashboard.panels]; const from = next.findIndex((p) => p.id === dragged), to = next.findIndex((p) => p.id === panel.id); const [item] = next.splice(from, 1); next.splice(to, 0, item); setDragged(null); void saveLayout(next); }} onMove={(d) => move(panel.id, d)} onTimeframe={(tf) => { void mutatePanel(panel, { timeframe: tf }).catch(() => undefined); }} onEdit={() => { setActivePanel(panel); setModal("edit"); }} onChart={() => { setChartPanel(panel); setShowChart(true); }} onRemove={() => { setActivePanel(panel); setModal("delete"); }} />)}
        </section>
      ) : (
        <section className="empty-state">
          <Activity /><span className="eyebrow">GRID EMPTY</span>
          <h2>START MONITORING</h2>
          <p>Add your first instrument to build the workspace.</p>
          <button className="btn primary" onClick={() => setModal("add")}><Plus /> ADD CHART</button>
        </section>
      )}
    </main>

    {/* Bloomberg Bottom Status Bar */}
    <div className="bb-bottom">
      <span>DATA: BITFINEX <span className="dot green" style={{ display: "inline-block", width: 4, height: 4, borderRadius: "50%", background: "var(--green)", margin: "0 4px" }} /> LIVE</span>
      <span className="ticker-msg">BTC {snapshots["BITFINEX:BTCUSD"]?.price != null ? `$${money.format(snapshots["BITFINEX:BTCUSD"].price!)}` : "—"} · ETH {snapshots["BITFINEX:ETHUSD"]?.price != null ? `$${money.format(snapshots["BITFINEX:ETHUSD"].price!)}` : "—"} · {whales.slice(0, 3).map((w) => `WHALE: ${w.amount.toFixed(1)} ${w.token} ($${(w.usdValue ?? 0).toLocaleString("en-US")}) → ${w.toLabel}`).join(" │ ")} — MARKET GRID INTELLIGENCE v1.0</span>
      <span className="creator"><CreatorCredit /></span>
    </div>

    <p className="sr-only" aria-live="polite">{announcement}</p>
    {modal === "add" && <InstrumentSearch onClose={() => setModal(null)} onAdd={async (instrument, timeframe) => { const added = await api.addPanel(instrument.provider, instrument.symbol, timeframe); setDashboard((current) => current ? { ...current, panels: [...current.panels, added] } : current); setAnnouncement(`${instrument.symbol} ditambahkan.`); }} />}
    {modal === "edit" && activePanel && <InstrumentSearch initial={activePanel} onClose={() => setModal(null)} onAdd={async (instrument, timeframe) => mutatePanel(activePanel, { provider: instrument.provider, symbol: instrument.symbol, timeframe })} />}
    {modal === "delete" && activePanel && <Modal title="HAPUS CHART?" onClose={() => setModal(null)}><div className="confirm-copy"><AssetLogo instrument={instrumentBySymbol.get(activePanel.symbol)} symbol={activePanel.symbol} size="large" /><p><strong>{activePanel.symbol}</strong> akan dihapus dari grid. Tindakan ini tidak dapat dibatalkan.</p></div><div className="modal-actions"><button className="btn ghost" onClick={() => setModal(null)}>BATAL</button><button className="btn destructive" onClick={() => void remove()}><Trash2 /> HAPUS</button></div></Modal>}
    {showPortfolio && <PortfolioModal holdings={portfolio} prices={snapshots} onClose={() => setShowPortfolio(false)} onSave={saveHolding} onRemove={removeHolding} />}
    {showAlerts && <AlertModal alerts={alerts} prices={snapshots} onClose={() => setShowAlerts(false)} onCreate={createAlert} onToggle={toggleAlert} onRemove={removeAlert} />}
    {showInsight && <InsightModal insight={insight} loading={insightLoading} error={insightError} onGenerate={() => void generateInsight()} onClose={() => setShowInsight(false)} />}
    {showChart && chartPanel && <BigChartModal panel={chartPanel} price={snapshots[chartPanel.symbol]?.price} onClose={() => setShowChart(false)} />}
    {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
    {confirmDeleteWs && <Modal title="HAPUS WORKSPACE?" onClose={() => setConfirmDeleteWs(null)}><div className="confirm-copy"><p><strong>{workspaces.find((w) => w.id === confirmDeleteWs)?.name ?? "Workspace"}</strong> dan semua chart di dalamnya akan dihapus permanen. Tindakan ini tidak dapat dibatalkan.</p></div><div className="modal-actions"><button className="btn ghost" onClick={() => setConfirmDeleteWs(null)}>BATAL</button><button className="btn destructive" onClick={() => void deleteWorkspace()}><Trash2 /> HAPUS</button></div></Modal>}
    {toasts.length > 0 && <div className="toast-stack" role="status" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast ${toast.kind}`}>{toast.kind === "alert" ? <Bell /> : toast.kind === "error" ? <AlertTriangle /> : <Check />}<span>{toast.text}</span></div>)}</div>}
  </div>;
}

function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  return path === "/dashboard" ? <DashboardApp /> : <LandingPage />;
}

createRoot(document.getElementById("root") as HTMLElement).render(<StrictMode><App /></StrictMode>);
