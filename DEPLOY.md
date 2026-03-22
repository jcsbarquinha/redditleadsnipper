# Deploy Leadsnipe (real URL + server + SQLite)

Your app is a **single Node process** (`node dist/server.js`) using **SQLite** (`better-sqlite3`). On a server you must keep the **database file on persistent disk** (not ephemeral container storage only), or you will lose data on every deploy.

---

## 1. Pick a host (recommended paths)

| Option | Good for | SQLite persistence |
|--------|-----------|---------------------|
| **[Render](https://render.com)** (Docker + **Disk**) | Easiest managed deploy | Add a **persistent disk** mounted at `/data` |
| **[Railway](https://railway.app)** | Simple env + volumes | Add **volume** and set `DATABASE_URL` to a path on it |
| **[Fly.io](https://fly.io)** | Global edge | **[Volumes](https://fly.io/docs/reference/volumes/)** for `/data` |
| **VPS** (DigitalOcean, Hetzner, etc.) | Full control | Single machine disk — point `DATABASE_URL` at e.g. `/var/lib/leadsnipe/reddit-leads.db` |

**Avoid** platforms that only give ephemeral filesystem **unless** you switch to PostgreSQL later.

---

## 2. Namecheap → your app (DNS)

In **Namecheap → Domain List → Manage → Advanced DNS**:

1. **If your host gives you an IP** (many VPS, or some setups):  
   - **A Record** · **Host** `@` · **Value** `<server IPv4>` · TTL Automatic  
   - Optional: **A Record** · **Host** `www` · same IP (or **CNAME** `www` → `@` if supported)

2. **If your host gives a hostname** (e.g. `yourapp.onrender.com`):  
   - **CNAME Record** · **Host** `www` · **Value** `yourapp.onrender.com`  
   - For **apex** `@` → some providers need **ALIAS/ANAME** (Namecheap “URL Redirect” or use a host that supports apex CNAME; Render documents this).

3. Wait for DNS (often **15–60 minutes**, sometimes up to 48h).

4. On the host, attach **HTTPS** (Let’s Encrypt). Managed platforms usually do this when you add your **custom domain**.

---

## 3. Build & run (Docker)

From the repo root:

```bash
docker build -t leadsnipe .
docker run -p 3001:3001 -v leadsnipe-data:/data -e BASE_URL=https://yourdomain.com --env-file .env leadsnipe
```

- **`-v leadsnipe-data:/data`** maps a persistent volume to `/data` (matches `DATABASE_URL=/data/reddit-leads.db` in the Dockerfile).

---

## 4. Environment variables (production)

Set these in the host’s dashboard (not committed to git):

| Variable | Example | Notes |
|----------|---------|--------|
| `BASE_URL` | `https://yourdomain.com` | **No trailing slash.** Stripe redirects & magic links |
| `PORT` | `3001` or platform default | Many hosts set `PORT` automatically |
| `DATABASE_URL` | `/data/reddit-leads.db` | **Absolute path** on persistent disk |
| `OPENAI_API_KEY` | `sk-...` | |
| `STRIPE_SECRET_KEY` | `sk_live_...` | Live key in prod |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | From **Dashboard webhook** for `https://yourdomain.com/api/stripe/webhook` (not Stripe CLI) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | | Add **authorized redirect URI**: `https://yourdomain.com/api/auth/google/callback` (or whatever your routes use) |
| `SMTP_*` / `EMAIL_FROM` | | Resend or other — for magic links |
| `CORS_ORIGIN` | `https://yourdomain.com` | Tighter than `*` in prod |
| `STRIPE_TEST_PROMO_CODE` | *(omit in prod)* | Remove test promos when going live |

Copy values from your local `.env`; **never** commit `.env`.

---

## 5. Stripe (production)

1. **Developers → Webhooks → Add endpoint**  
   URL: `https://yourdomain.com/api/stripe/webhook`  
   Event: `checkout.session.completed`
2. Copy the endpoint **Signing secret** → `STRIPE_WEBHOOK_SECRET`
3. In **Stripe → Checkout settings / branding**, ensure success URLs match `BASE_URL` if you configured them in the Dashboard

---

## 6. Smoke test after deploy

- `GET https://yourdomain.com/api/health` → `{ "ok": true }`
- Open the site, sign-in, run search, test checkout (test card in **test mode**, or small real payment in live mode)

---

## 7. Later: cron + email alerts

Run the scheduler on the **same** machine (or call a **secured** HTTP endpoint from an external cron) so it uses the **same** `DATABASE_URL` volume as the web app.

---

## Quick reference: `package.json` scripts

- **Build:** `npm run build`
- **API (production):** `npm run start:api` → `node dist/server.js`
