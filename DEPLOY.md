# Ghost TV Support Portal — VPS Deployment Guide

Production setup for an Ubuntu/Debian VPS. The app runs as **one Node process**
(Express serves the built React app, the API, and Socket.io on a single port),
fronted by **Caddy** for free automatic HTTPS.

---

## 0. What you need

- A VPS (Ubuntu 22.04/24.04 recommended), root or sudo access.
- A domain pointed at the VPS (A record → your server IP), e.g. `support.yourdomain.com`.
- Your IPTV panel URL (`IPTV_API_URL`).

---

## 1. Install system dependencies

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl build-essential ufw

# Node.js 22 LTS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

node -v   # v22.x
npm -v
```

---

## 2. Pull the code

```bash
sudo mkdir -p /var/www
cd /var/www
sudo git clone https://github.com/mohammedabdullaga/ghost-support-portal.git ghost-support
sudo chown -R $USER:$USER ghost-support
cd ghost-support
```

---

## 3. Backend setup

```bash
cd server
npm install

# Prisma postinstall is blocked by default on some setups — approve it:
npm approve-scripts @prisma/client prisma @prisma/engines 2>/dev/null || true
npm rebuild @prisma/client prisma @prisma/engines

# Create the production env
cp .env.example .env
nano .env
```

Edit `server/.env`:

```dotenv
PORT=4000
NODE_ENV=production

# Generate a strong secret:  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_SECRET=PASTE_A_LONG_RANDOM_HEX_HERE

ADMIN_USERNAMES=Elit,support,vodsupport

# Your public HTTPS origin (Caddy domain). CORS is locked to this.
CLIENT_URL=https://support.yourdomain.com

IPTV_API_URL=http://ghost-con.my/player_api.php
```

Create the database and upload dir:

```bash
npx prisma db push      # creates server/prisma/dev.db
mkdir -p uploads
```

---

## 4. Build the frontend

```bash
cd ../client
npm install
npm approve-scripts esbuild 2>/dev/null || true
npm rebuild esbuild
npm run build           # outputs client/dist
```

---

## 5. Serve the built app from Express (single-port production)

Tell the server to also serve `client/dist`. Add this to `server/index.js`
**after** `app.use('/uploads', ...)` and **before** the `app.use('/api', apiLimiter)` block:

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ...top of file...
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, '..', 'client', 'dist');

// Serve the built SPA + client-side routing fallback
app.use(express.static(CLIENT_DIST));
app.get(/^\/(?!api|uploads|socket\.io).*/, (_req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'));
});
```

> Keep `/api`, `/uploads`, and `/socket.io` handled by their own routes — the
> regex fallback above excludes them so the SPA catch-all never swallows API calls.

---

## 6. Run with PM2 (process manager)

```bash
sudo npm install -g pm2
cd /var/www/ghost-support/server
pm2 start index.js --name ghost-support
pm2 save
pm2 startup        # prints a command — run it to enable boot persistence
```

Useful commands:

```bash
pm2 status
pm2 logs ghost-support
pm2 restart ghost-support
```

The 7-day upload sweeper (`node-cron`) and all rate limits run inside this process —
no extra services needed.

---

## 7. HTTPS + reverse proxy with Caddy (recommended)

Caddy gives you free, auto-renewing Let's Encrypt TLS with a 2-line config.

```bash
sudo apt install -y caddy
sudo nano /etc/caddy/Caddyfile
```

Caddyfile:

```
support.yourdomain.com {
    reverse_proxy 127.0.0.1:4000
}
```

```bash
sudo systemctl reload caddy
```

Caddy handles the websocket upgrade for Socket.io automatically.

### Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Caddy'      # or: sudo ufw allow 80,443/tcp
sudo ufw enable
sudo ufw status
```

Port 4000 stays internal (Caddy proxies to it) — no need to expose it publicly.

---

## 8. Verify

```bash
curl https://support.yourdomain.com/api/health
# → {"ok":true,...}
```

Open `https://support.yourdomain.com` — log in as an admin (username in
`ADMIN_USERNAMES` + panel password + display name) and as a customer to test.

---

## Updating later

```bash
cd /var/www/ghost-support
git pull
cd server && npm install && npx prisma db push
cd ../client && npm install && npm run build
pm2 restart ghost-support
```

---

## Production security checklist

- [ ] `JWT_SECRET` is a long random string (not the default).
- [ ] `NODE_ENV=production` set (enables the JWT-secret warning if missing).
- [ ] `CLIENT_URL` matches your exact HTTPS origin (CORS is locked to it).
- [ ] `server/.env` is **never** committed (it's in `.gitignore`).
- [ ] Firewall only exposes 80/443; port 4000 is internal.
- [ ] `pm2 startup` configured so the app survives reboots.

### Notes
- **SQLite** is fine for this scale. `dev.db` lives in `server/prisma/` — back it up
  periodically: `cp server/prisma/dev.db ~/backups/dev-$(date +%F).db`.
- Uploads older than 7 days are auto-deleted at midnight by the cron worker.
- If you change `ADMIN_USERNAMES` or any `.env` value, run `pm2 restart ghost-support`.
