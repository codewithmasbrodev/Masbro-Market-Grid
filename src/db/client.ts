import { createClient } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

// Vercel has no D1 equivalent, so this points at a Turso (libSQL) database instead.
// Same SQLite dialect as D1, so schema.ts and the migrations/ SQL files are unchanged.
const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export function getDb() {
  return drizzle(client, { schema });
}
