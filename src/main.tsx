import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, AlertTriangle, ArrowDown, ArrowRight, ArrowUp, BarChart3, Check, Database, GripVertical, LayoutGrid, LoaderCircle, Move, Plus, Radio, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Trash2, X, Zap } from "lucide-react";
import { api, type WhaleTx } from "./lib/api";
import { INSTRUMENTS, TIMEFRAMES, type ChartPanel as Panel, type ConnectionStatus, type Dashboard, type Instrument, type MarketSnapshot, type Timeframe } from "./lib/types";
import "./styles.css";

const intervalMap: Record<Timeframe, string> = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1D": "D", "1W": "W" };
const money = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const instrumentBySymbol = new Map(INSTRUMENTS.map((instrument) => [instrument.symbol, instrument]));

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

function ChartPanel({ panel, snapshot, onTimeframe, onRemove, onMove, onEdit, draggable, onDragStart, onDrop }: { panel: Panel; snapshot?: MarketSnapshot; onTimeframe: (tf: Timeframe) => void; onRemove: () => void; onMove: (direction: -1 | 1) => void; onEdit: () => void; draggable: boolean; onDragStart: () => void; onDrop: () => void }) {
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
    <div className="panel-meta"><div className="timeframes" role="group" aria-label={`Timeframe ${panel.symbol}`}>{TIMEFRAMES.map((tf) => <button key={tf} type="button" className={panel.timeframe === tf ? "active" : ""} aria-pressed={panel.timeframe === tf} onPointerDown={(event) => event.stopPropagation()} onClick={() => selectTimeframe(tf)}>{tf}</button>)}</div><span className="volume">VOL 24H&nbsp; {snapshot?.volume24h == null ? "—" : compact.format(snapshot.volume24h)}</span></div>
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
    <div className="ticker-strip landing-ticker"><span>MARKET GRID INTELLEGENCE // MARKET INTELLIGENCE</span><span>BINANCE · BITFINEX · CRYPTOCAP · TRADINGVIEW</span><span><i className="dot live" /> SYSTEM ONLINE</span></div>
    <header className="landing-nav"><Brand /><nav aria-label="Navigasi utama"><a href="#fitur">FITUR</a><a href="#cara-kerja">CARA KERJA</a><a href="#market">MARKET</a></nav><a className="btn primary" href="/dashboard">BUKA DASHBOARD <ArrowRight /></a></header>
    <main className="landing-main">
      <section className="hero">
        <div className="hero-copy"><div className="hero-status"><span><i className="dot live" /> LIVE FEED AKTIF</span><span>31 INSTRUMEN</span></div><span className="eyebrow">CRYPTO MARKET COMMAND CENTER</span><h1>PASAR BERGERAK.<br/><em>ANDA LEBIH CEPAT.</em></h1><p>Pantau pasar kripto real-time, analisis chart, dan bangun workspace modular Anda—semua dalam satu grid yang fokus dan responsif.</p><div className="hero-actions"><a className="btn primary hero-cta" href="/dashboard">BUKA DASHBOARD <ArrowRight /></a><a className="btn ghost hero-cta" href="#fitur">JELAJAHI FITUR</a></div><div className="hero-trust"><span><ShieldCheck /> API PUBLIK & AMAN</span><span><Zap /> UPDATE TANPA REFRESH</span><span><Database /> LAYOUT TERSIMPAN</span></div></div>
        <div className="hero-visual"><div className="visual-label">// YOUR MARKET. YOUR GRID.</div><LandingPreview /><div className="float-chip chip-live"><i className="dot live" /> WEBSOCKET LIVE</div><div className="float-chip chip-pairs">31 PAIR <strong>+</strong></div></div>
      </section>
      <section className="market-ribbon" id="market" aria-label="Instrumen unggulan">{["BTC / USDT", "ETH / USD", "SOL / USDT", "XRP / USDT", "DOGE / USDT", "TOTAL MARKET"].map((pair, i) => <span key={pair}><b>{pair}</b><em className={i === 4 ? "negative" : "positive"}>{i === 4 ? "−0.31%" : `+${(0.84 + i * .43).toFixed(2)}%`}</em></span>)}</section>
      <section className="landing-section features" id="fitur"><div className="section-heading"><div><span className="eyebrow">BUILT FOR CLARITY / NOT NOISE</span><h2>SEMUA YANG ANDA BUTUHKAN.<br/><em>TANPA DISTRAKSI.</em></h2></div><p>Peralatan market esensial dalam antarmuka brutalist yang cepat, modular, dan tetap nyaman di setiap layar.</p></div><div className="feature-grid">{landingFeatures.map(({ icon: Icon, tag, title, text }) => <article className="feature-card" key={tag}><div><span>{tag}</span><Icon /></div><h3>{title}</h3><p>{text}</p><a href="/dashboard">COBA SEKARANG <ArrowRight /></a></article>)}</div></section>
      <section className="landing-section workflow" id="cara-kerja"><div className="workflow-copy"><span className="eyebrow">DARI NOL KE MARKET GRID</span><h2>TIGA LANGKAH.<br/><em>SATU WORKSPACE.</em></h2><p>Tidak perlu konfigurasi rumit. Dashboard siap dipakai dan tersimpan untuk kunjungan berikutnya.</p><a className="btn primary hero-cta" href="/dashboard">MULAI PANTAU PASAR <ArrowRight /></a></div><ol><li><span>01</span><div><Search /><h3>CARI INSTRUMEN</h3><p>Telusuri coin, pair, atau exchange dari katalog terintegrasi.</p></div></li><li><span>02</span><div><SlidersHorizontal /><h3>PILIH TIMEFRAME</h3><p>Tetapkan rentang dari 1 menit hingga 1 minggu.</p></div></li><li><span>03</span><div><LayoutGrid /><h3>SUSUN GRID</h3><p>Atur posisi dan kolom. Layout tersimpan otomatis.</p></div></li></ol></section>
      <section className="final-cta"><div><span className="eyebrow">MARKET TIDAK MENUNGGU</span><h2>BANGUN MARKET GRID<br/>ANDA SEKARANG.</h2></div><div><p>Feed live. Chart profesional. Workspace pribadi.</p><a className="btn primary hero-cta" href="/dashboard">BUKA DASHBOARD <ArrowRight /></a></div></section>
    </main>
    <footer className="landing-footer"><Brand href="/" /><p>Chart oleh TradingView. Data pasar dari Binance dan Bitfinex.<br/>Hanya untuk informasi, bukan nasihat finansial.<br/><CreatorCredit /></p><div><span>© 2026 MARKET GRID INTELLEGENCE</span><a href="/dashboard">DASHBOARD →</a></div></footer>
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
  const panelMutationVersion = useRef<Record<string, number>>({});
  const panelMutationQueue = useRef<Record<string, Promise<unknown>>>({});

  const load = useCallback(() => { setLoadingError(""); api.dashboard().then(setDashboard).catch((error: Error) => setLoadingError(error.message)); }, []);
  useEffect(load, [load]);
  const symbols = useMemo(() => [...new Set(dashboard?.panels.map((p) => p.symbol) ?? [])], [dashboard]);
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
        setSnapshots((current) => ({ ...current, ...Object.fromEntries(data.map((item) => [item.symbol, item])) }));
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
  }, [symbols, streamKey]);
  
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

    {/* Bloomberg Tab Navigation */}
    <div className="bb-tabs">
      <span className="tab active"><span className="key">[1]</span> MONITOR</span>
      <span className="tab"><span className="key">[2]</span> CHARTS</span>
      <span className="tab"><span className="key">[3]</span> {dashboard?.panels.length ?? 0} PAIRS</span>
    </div>

    {/* Compact Topbar */}
    <header className="topbar">
      <Brand href="/" />
      <div className="top-actions">
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
        <div className="layout-control">
          <label><LayoutGrid /> COL</label>
          {[1, 2, 3, 4].map((count) => <button key={count} aria-label={`${count} kolom`} className={dashboard.columns === count ? "active" : ""} onClick={() => void saveLayout(dashboard.panels, count)}>{count}</button>)}
          <span className={saving ? "saving active" : "saving"}>{saving ? "SAVE…" : "SAVED"}</span>
        </div>
      </section>

      {/* Market Grid */}
      {dashboard.panels.length ? (
        <section className="market-grid" style={{ "--columns": dashboard.columns } as React.CSSProperties}>
          {dashboard.panels.map((panel) => <ChartPanel key={panel.id} panel={panel} snapshot={snapshots[panel.symbol]} draggable onDragStart={() => setDragged(panel.id)} onDrop={() => { if (!dragged || dragged === panel.id) return; const next = [...dashboard.panels]; const from = next.findIndex((p) => p.id === dragged), to = next.findIndex((p) => p.id === panel.id); const [item] = next.splice(from, 1); next.splice(to, 0, item); setDragged(null); void saveLayout(next); }} onMove={(d) => move(panel.id, d)} onTimeframe={(tf) => { void mutatePanel(panel, { timeframe: tf }).catch(() => undefined); }} onEdit={() => { setActivePanel(panel); setModal("edit"); }} onRemove={() => { setActivePanel(panel); setModal("delete"); }} />)}
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
  </div>;
}

function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  return path === "/dashboard" ? <DashboardApp /> : <LandingPage />;
}

createRoot(document.getElementById("root") as HTMLElement).render(<StrictMode><App /></StrictMode>);
