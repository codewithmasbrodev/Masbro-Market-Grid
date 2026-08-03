import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const dashboards = sqliteTable("dashboards", {
  id: text("id").primaryKey(),
  ownerHash: text("owner_hash").notNull().unique(),
  name: text("name").notNull().default("MY MARKET GRID"),
  columns: integer("columns").notNull().default(2),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const chartPanels = sqliteTable("chart_panels", {
  id: text("id").primaryKey(),
  dashboardId: text("dashboard_id").notNull().references(() => dashboards.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull().default("1h"),
  position: integer("position").notNull(),
  span: integer("span").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("chart_panels_dashboard_position_idx").on(table.dashboardId, table.position)]);

export const portfolioHoldings = sqliteTable("portfolio_holdings", {
  id: text("id").primaryKey(),
  ownerHash: text("owner_hash").notNull(),
  symbol: text("symbol").notNull(),
  base: text("base").notNull(),
  quantity: real("quantity").notNull(),
  avgPrice: real("avg_price").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("portfolio_holdings_owner_symbol_idx").on(table.ownerHash, table.symbol),
]);

export const priceAlerts = sqliteTable("price_alerts", {
  id: text("id").primaryKey(),
  ownerHash: text("owner_hash").notNull(),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),
  targetPrice: real("target_price").notNull(),
  active: integer("active").notNull().default(1),
  triggeredAt: text("triggered_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("price_alerts_owner_active_idx").on(table.ownerHash, table.active),
]);
