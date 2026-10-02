# Ghost TV — Support Portal

Mobile-first, RTL-first (Arabic) support SPA for the Ghost TV IPTV platform.
Customers file incident reports with screenshots and chat live with support
agents; agents work from a real-time command center.

## Stack

| Layer    | Tech |
|----------|------|
| Frontend | React (Vite), Tailwind CSS, lucide-react, socket.io-client |
| Backend  | Express, Socket.io, Multer (memory), Prisma ORM + SQLite, JWT, node-cron |
| Security | helmet, express-rate-limit, file-type magic-byte verification |

## Project layout

```
server/
  index.js               Express app, IPTV auth route, secure /uploads, Socket.io handlers
  middleware/security.js helmet, rate limiters, hardened Multer pipeline, sanitizers
  middleware/auth.js     JWT sign/verify + requireAuth / requireAdmin
  cron/cleanup.js        7-day uploads sweeper (node-cron, 0 0 * * *)
  lib/iptv.js            upstream player_api.php credential validation
  prisma/schema.prisma   User / Report / ChatSession / ChatMessage
client/
  src/App.jsx            auth state, role routing, RTL/LTR language toggle
  src/components/        Login, UserDashboard, AdminDashboard, ChatSheet, Header, badges
```

## Quick start (Windows)

```powershell
# 1) Backend
cd server
npm install
copy .env.example .env        # then edit JWT_SECRET + ADMIN_USERNAMES
npx prisma db push            # creates dev.db from schema
npm run dev                   # http://localhost:4000

# 2) Frontend (new terminal)
cd client
npm install
npm run dev                   # http://localhost:5173
```

Vite proxies `/api`, `/uploads` and the websocket to the backend in dev.
For production, serve the built client and set `CLIENT_URL` (server) +
`VITE_API_URL` (client build) accordingly.

## Login model

- Unified screen for customers **and** agents — credentials are checked against
  `http://ghosttv-con.my/player_api.php` and must return `auth === 1` +
  `status === "Active"`.
- Usernames listed in `ADMIN_USERNAMES` (or upstream `role === "ADMIN"`) get the
  agent console and **must** provide a display name (e.g. `الدعم الفني - محمد`)
  that is shown on their chat bubbles.
- JWT payload: `{ userId, iptvUsername, role, agentName }`, 7-day expiry,
  sent as a Bearer token (also used in the Socket.io handshake).

## Upload hardening summary

1. Multer **memory** storage, 4MB hard limit, MIME allowlist gate.
2. `file-type` magic-byte inspection of the buffer — renamed shells die here.
3. Original filenames discarded; stored as `crypto.randomUUID() + ext`
   where `ext` comes from the **detected** type.
4. `path.resolve` containment check inside `server/uploads`.
5. `/uploads` served with `CSP: default-src 'none'`, `nosniff`,
   `Content-Disposition: inline`, `max-age=86400`.
6. SVG / HTML / PHP / executables are structurally impossible to store.
7. node-cron sweeps files older than 7 days every midnight.
