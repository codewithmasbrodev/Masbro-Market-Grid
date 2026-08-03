import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

// Bare "@libsql/client" resolves to the web build on edge runtimes
// (workerd/edge-light) and the node build locally — so this same module works
// on Vercel Edge AND in the Vite dev server.
//
// In dev, when TURSO env vars are not configured, we fall back to a local
// SQLite file so the dashboard works without any external database setup.
const url = process.env.TURSO_DATABASE_URL ?? (process.env.NODE_ENV !== "production" ? "file:.data/dev.db" : undefined);

if (!url) {
  throw new Error("TURSO_DATABASE_URL belum diatur. Tambahkan melalui API Keys / freebuff-deploy env.");
}

const client = url.startsWith("file:")
  ? createClient({ url })
  : createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

export function getDb() {
  return drizzle(client, { schema });
}
