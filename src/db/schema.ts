import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
