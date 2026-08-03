import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";

// Load .env / .env.local into process.env for the dev API middleware — the same
// values the edge function reads in production. Real env vars win. Dependency-free.
function loadDotEnvFile(file: string) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, "utf8");
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

// In production /api/* is handled by the Vercel edge function (api/[...path].ts),
// which the Vite dev server does not host. This middleware invokes the exact same
// handler in dev, so the dashboard, portfolio and alerts all work locally without
// a deployed backend.
function devApiMiddleware(): Plugin {
  return {
    name: "marketgrid-dev-api",
    config() {
      loadDotEnvFile(path.resolve(process.cwd(), ".env.local"));
      loadDotEnvFile(path.resolve(process.cwd(), ".env"));
    },
    configureServer(server: ViteDevServer) {
      // Local SQLite fallback database lives here when TURSO vars are absent.
      fs.mkdirSync(path.resolve(process.cwd(), ".data"), { recursive: true });
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        if (!url.pathname.startsWith("/api/")) return next();
        try {
          const mod = (await server.ssrLoadModule("/api/[...path].ts")) as {
            default: (request: Request) => Promise<Response>;
          };
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === "string") headers[key] = value;
            else if (Array.isArray(value)) headers[key] = value.join(", ");
          }
          const request = new Request(url, {
            method: req.method,
            headers,
            body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
          });
          const response = await mod.default(request);
          res.statusCode = response.status;
          for (const [key, value] of response.headers) {
            if (key.toLowerCase() !== "set-cookie") res.setHeader(key, value);
          }
          if (response.headers.has("set-cookie")) res.setHeader("set-cookie", response.headers.getSetCookie());
          const buffer = Buffer.from(await response.arrayBuffer());
          res.setHeader("content-length", String(buffer.length));
          res.end(buffer);
        } catch (error) {
          console.error("[dev-api] error on", url.pathname, error);
          res.statusCode = 500;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "Dev API middleware error." }));
        }
      });
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      "#": "/src",
    },
  },
  plugins: [react(), tailwindcss(), devApiMiddleware()],
});
