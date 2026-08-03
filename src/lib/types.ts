export type Provider = "BITFINEX" | "BINANCE" | "CRYPTOCAP";
export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1D" | "1W";
export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "degraded" | "offline";

export interface Instrument {
  provider: Provider;
  symbol: string;
  label: string;
  base: string;
  quote: string;
  logo: string | null;
}

export interface ChartPanel {
  id: string;
  provider: Provider;
  symbol: string;
  timeframe: Timeframe;
  position: number;
  span: number;
}

export interface Dashboard {
  id: string;
  name: string;
  columns: number;
  panels: ChartPanel[];
  updatedAt: string;
}

export interface MarketSnapshot {
  symbol: string;
  price: number | null;
  change24h: number | null;
  volume24h: number | null;
  timestamp: number;
  stale: boolean;
  sourceStatus: "live" | "stale" | "unavailable";
}

export interface PortfolioHolding {
  id: string;
  symbol: string;
  base: string;
  quantity: number;
  avgPrice: number;
  createdAt: string;
  updatedAt: string;
}

export type AlertDirection = "above" | "below";

export interface PriceAlert {
  id: string;
  symbol: string;
  direction: AlertDirection;
  targetPrice: number;
  active: boolean;
  triggeredAt: string | null;
  createdAt: string;
}

export interface InsightResult {
  summary: string;
  provider: "openai" | "local";
  generatedAt: number;
}

export type ClientStreamMessage =
  | { type: "subscribe"; symbols: string[] }
  | { type: "ping" };

export type ServerStreamMessage =
  | { type: "snapshot" | "tick"; data: MarketSnapshot[] }
  | { type: "status"; status: ConnectionStatus; message?: string }
  | { type: "pong" };

export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1D", "1W"];

export const INSTRUMENTS: Instrument[] = [
  { provider: "BITFINEX", symbol: "BITFINEX:BTCUSD", label: "Bitcoin / US Dollar", base: "BTC", quote: "USD", logo: "btc" },
  { provider: "BITFINEX", symbol: "BITFINEX:ETHUSD", label: "Ethereum / US Dollar", base: "ETH", quote: "USD", logo: "eth" },
  { provider: "BITFINEX", symbol: "BITFINEX:LTCUSD", label: "Litecoin / US Dollar", base: "LTC", quote: "USD", logo: "ltc" },
  { provider: "BITFINEX", symbol: "BITFINEX:XRPUSD", label: "XRP / US Dollar", base: "XRP", quote: "USD", logo: "xrp" },
  { provider: "BITFINEX", symbol: "BITFINEX:SOLUSD", label: "Solana / US Dollar", base: "SOL", quote: "USD", logo: "sol" },
  { provider: "BITFINEX", symbol: "BITFINEX:ADAUSD", label: "Cardano / US Dollar", base: "ADA", quote: "USD", logo: "ada" },
  { provider: "BINANCE", symbol: "BINANCE:SOLUSDT", label: "Solana / Tether", base: "SOL", quote: "USDT", logo: "sol" },
  { provider: "BINANCE", symbol: "BINANCE:XRPUSDT", label: "XRP / Tether", base: "XRP", quote: "USDT", logo: "xrp" },
  { provider: "BINANCE", symbol: "BINANCE:DOGEUSDT", label: "Dogecoin / Tether", base: "DOGE", quote: "USDT", logo: "doge" },
  { provider: "BINANCE", symbol: "BINANCE:BTCUSDT", label: "Bitcoin / Tether", base: "BTC", quote: "USDT", logo: "btc" },
  { provider: "BINANCE", symbol: "BINANCE:ETHUSDT", label: "Ethereum / Tether", base: "ETH", quote: "USDT", logo: "eth" },
  { provider: "BINANCE", symbol: "BINANCE:BNBUSDT", label: "BNB / Tether", base: "BNB", quote: "USDT", logo: "bnb" },
  { provider: "BINANCE", symbol: "BINANCE:ADAUSDT", label: "Cardano / Tether", base: "ADA", quote: "USDT", logo: "ada" },
  { provider: "BINANCE", symbol: "BINANCE:AVAXUSDT", label: "Avalanche / Tether", base: "AVAX", quote: "USDT", logo: "avax" },
  { provider: "BINANCE", symbol: "BINANCE:LINKUSDT", label: "Chainlink / Tether", base: "LINK", quote: "USDT", logo: "link" },
  { provider: "BINANCE", symbol: "BINANCE:DOTUSDT", label: "Polkadot / Tether", base: "DOT", quote: "USDT", logo: "dot" },
  { provider: "BINANCE", symbol: "BINANCE:TRXUSDT", label: "TRON / Tether", base: "TRX", quote: "USDT", logo: "trx" },
  { provider: "BINANCE", symbol: "BINANCE:SUIUSDT", label: "Sui / Tether", base: "SUI", quote: "USDT", logo: "sui" },
  { provider: "BINANCE", symbol: "BINANCE:NEARUSDT", label: "NEAR Protocol / Tether", base: "NEAR", quote: "USDT", logo: "near" },
  { provider: "BINANCE", symbol: "BINANCE:UNIUSDT", label: "Uniswap / Tether", base: "UNI", quote: "USDT", logo: "uni" },
  { provider: "BINANCE", symbol: "BINANCE:AAVEUSDT", label: "Aave / Tether", base: "AAVE", quote: "USDT", logo: "aave" },
  { provider: "BINANCE", symbol: "BINANCE:SHIBUSDT", label: "Shiba Inu / Tether", base: "SHIB", quote: "USDT", logo: "shib" },
  { provider: "BINANCE", symbol: "BINANCE:PEPEUSDT", label: "Pepe / Tether", base: "PEPE", quote: "USDT", logo: "pepe" },
  { provider: "BINANCE", symbol: "BINANCE:ARBUSDT", label: "Arbitrum / Tether", base: "ARB", quote: "USDT", logo: "arb" },
  { provider: "BINANCE", symbol: "BINANCE:OPUSDT", label: "Optimism / Tether", base: "OP", quote: "USDT", logo: "op" },
  { provider: "BINANCE", symbol: "BINANCE:INJUSDT", label: "Injective / Tether", base: "INJ", quote: "USDT", logo: "inj" },
  { provider: "CRYPTOCAP", symbol: "CRYPTOCAP:TOTAL", label: "Total Crypto Market Cap", base: "TOTAL", quote: "USD", logo: null },
  { provider: "CRYPTOCAP", symbol: "CRYPTOCAP:TOTAL2", label: "Market Cap Excluding Bitcoin", base: "TOTAL2", quote: "USD", logo: null },
  { provider: "CRYPTOCAP", symbol: "CRYPTOCAP:TOTAL3", label: "Market Cap Excluding BTC & ETH", base: "TOTAL3", quote: "USD", logo: null },
  { provider: "CRYPTOCAP", symbol: "CRYPTOCAP:BTC.D", label: "Bitcoin Dominance", base: "BTC.D", quote: "%", logo: "btc" },
  { provider: "CRYPTOCAP", symbol: "CRYPTOCAP:ETH.D", label: "Ethereum Dominance", base: "ETH.D", quote: "%", logo: "eth" },
];
