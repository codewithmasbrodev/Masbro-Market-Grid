# Deploy ke Vercel

## Apa yang berubah dari versi Cloudflare
- **Database**: D1 → **Turso (libSQL)**. Dialect-nya sama-sama SQLite jadi `src/db/schema.ts` dan folder `migrations/` TIDAK perlu diubah.
- **Realtime stream**: WebSocket via Durable Object (`MARKET_HUB`) tidak ada equivalent-nya di Vercel, jadi diganti **polling** setiap 8 detik ke endpoint `/api/market/snapshot` yang sudah ada. Efeknya di UI nyaris tidak kerasa, cuma update harga jadi per-8-detik alih-alih dorong real-time.
- **API**: `worker/index.ts` (Cloudflare Worker) → `api/[...path].ts` (Vercel Edge Function). Logikanya sama persis, cuma DB call-nya lewat Drizzle penuh (bukan raw `env.DB.batch`).

## File yang DIHAPUS dari project lama
- `worker/index.ts`
- `wrangler.jsonc`

## Langkah setup

1. **Timpa file-file ini** di project kamu dengan yang ada di zip:
   `api/[...path].ts` (baru), `src/db/client.ts`, `src/main.tsx`, `drizzle.config.ts`, `package.json`, `vite.config.ts`, `vercel.json` (baru), `.env.example` (baru)

2. **Install dependency baru:**
   ```bash
   npm install
   ```

3. **Buat database Turso** (gratis):
   ```bash
   npx @turso-cli install   # atau lihat https://docs.turso.tech/cli/installation
   turso db create defi-market-grid
   turso db show defi-market-grid --url
   turso db tokens create defi-market-grid
   ```
   Simpan hasil `url` dan `token` di atas.

4. **Jalankan migrations ke Turso:**
   ```bash
   TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... npm run db:migrate
   ```

5. **Push ke GitHub**, lalu import repo di https://vercel.com/new.

6. **Set Environment Variables** di Vercel project settings (Production & Preview):
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - (opsional) `GLOBAL_METRICS_API_URL`, `GLOBAL_METRICS_API_KEY`

7. Deploy. Vercel otomatis detect Vite, jalankan `npm run build`, serve `dist/client`, dan `api/[...path].ts` jadi Edge Function yang nangkep semua request `/api/*`.

## Cek setelah deploy
- `https://project-kamu.vercel.app/api/health` harus balikin `{"ok":true,...}`
- Buka `/dashboard`, pastikan panel harga ke-update tiap ~8 detik.
