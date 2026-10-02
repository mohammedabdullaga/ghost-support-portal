import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import cors from 'cors';
import multer from 'multer';
import { Server } from 'socket.io';

import { prisma } from './lib/prisma.js';
import { verifyIptvCredentials, normalizeUsername } from './lib/iptv.js';
import { createLoginAttemptTracker, createChatThrottle } from './lib/guards.js';
import { challengeRouter, challengeStore } from './routes/challenge.js';
import {
  helmetMiddleware,
  loginLimiter,
  uploadLimiter,
  apiLimiter,
  upload,
  persistVerifiedImage,
  sanitizeText,
  isSafeUploadUrl,
  ensureUploadDir,
  UPLOAD_DIR,
  UploadError,
} from './middleware/security.js';
import { signToken, requireAuth, requireAdmin, verifyToken } from './middleware/auth.js';
import { startCleanupCron } from './cron/cleanup.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 4000;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const ADMIN_USERNAMES = new Set(
  (process.env.ADMIN_USERNAMES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const REPORT_CATEGORIES = new Set(['LIVE', 'VOD', 'SUGGESTION', 'OTHER']);
const REPORT_STATUSES = new Set(['OPEN', 'RESOLVED']);
const CONTENT_TYPES = new Set(['MOVIE', 'SERIES']);

// Abuse guards
const loginAttempts = createLoginAttemptTracker({ maxFails: 3, lockMs: 5 * 60 * 1000 });
const chatThrottle = createChatThrottle({ intervalMs: 1000 });
const MAX_REPORTS_PER_DAY = 2;

ensureUploadDir();

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmetMiddleware);
app.use(
  cors({
    origin: CLIENT_URL, // strict single-origin CORS
    credentials: true,
    methods: ['GET', 'POST', 'PATCH'],
  }),
);
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Secure static serving of /uploads
// - No script execution: strict CSP + nosniff
// - UUID filenames only (enforced at write time)
// ---------------------------------------------------------------------------
app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    index: false,
    dotfiles: 'deny',
    setHeaders: (res) => {
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'public, max-age=86400');
    },
  }),
);

// ---------------------------------------------------------------------------
// Health + global API rate limit
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.use(challengeRouter);
app.use('/api', apiLimiter);

// ---------------------------------------------------------------------------
// Auth — unified login for customers and support agents.
// Credentials are validated against the upstream IPTV panel.
// ---------------------------------------------------------------------------
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? normalizeUsername(req.body.username) : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const agentNameRaw = typeof req.body?.agentName === 'string' ? req.body.agentName : '';
  const challenge = req.body?.challenge || {};

  // Proof-of-interaction: a valid, consumed slider challenge is mandatory.
  // This blocks credential-stuffing / Burp Repeater (no human drag = no login).
  const verdict = challengeStore.verify(
    challenge.id,
    challenge.pos,
    challenge.moves,
    challenge.duration,
  );
  if (!verdict.ok) {
    return res.status(403).json({ error: 'CHALLENGE_REQUIRED' });
  }

  if (!username || !password || username.length > 100 || password.length > 100) {
    return res.status(400).json({ error: 'MISSING_CREDENTIALS' });
  }

  // Brute-force lockout: 3 failed attempts → 5-minute ban (per username+IP).
  const lockKey = `${username.toLowerCase()}|${req.ip}`;
  const lockedMs = loginAttempts.lockedFor(lockKey);
  if (lockedMs > 0) {
    return res.status(429).json({ error: 'ACCOUNT_LOCKED', retryAfterSec: Math.ceil(lockedMs / 1000) });
  }

  const check = await verifyIptvCredentials(username, password);
  if (!check.ok) {
    if (check.reason === 'INVALID_CREDENTIALS') {
      const lockedForMs = loginAttempts.fail(lockKey);
      const body = { error: 'INVALID_CREDENTIALS' };
      if (lockedForMs > 0) {
        return res.status(429).json({ error: 'ACCOUNT_LOCKED', retryAfterSec: Math.ceil(lockedForMs / 1000) });
      }
      return res.status(401).json(body);
    }
    return res.status(502).json({ error: check.reason });
  }
  loginAttempts.success(lockKey);

  // Admin detection: env allowlist OR upstream role flag.
  const isAdmin =
    ADMIN_USERNAMES.has(username.toLowerCase()) || check.info?.role === 'ADMIN';
  const role = isAdmin ? 'ADMIN' : 'USER';

  // Agents must provide the display name customers will see.
  const agentName = sanitizeText(agentNameRaw, 60) || null;
  if (isAdmin && !agentName) {
    return res.status(400).json({ error: 'AGENT_NAME_REQUIRED' });
  }

  // Upsert the local shadow user (keeps roles/agent names in sync).
  const user = await prisma.user.upsert({
    where: { iptvUsername: username },
    update: { role, agentName: isAdmin ? agentName : null },
    create: { iptvUsername: username, role, agentName: isAdmin ? agentName : null },
  });

  const token = signToken(user);
  return res.json({
    token,
    user: { userId: user.id, iptvUsername: user.iptvUsername, role: user.role, agentName: user.agentName },
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

// ---------------------------------------------------------------------------
// Hardened image upload — shared by reports and chat attachments.
// Pipeline: rate limit → auth → multer memory (4MB, MIME gate) →
//           magic-byte verification → UUID rename → disk.
// ---------------------------------------------------------------------------
app.post('/api/upload', requireAuth, uploadLimiter, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new UploadError('NO_FILE', 400);
    const saved = await persistVerifiedImage(req.file);
    return res.status(201).json(saved);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Reports (customer)
// ---------------------------------------------------------------------------
app.post('/api/reports', requireAuth, async (req, res) => {
  const category = String(req.body?.category || '');
  const details = sanitizeText(req.body?.details || '', 2000);
  const imageUrl = req.body?.imageUrl ?? null;
  const contentTypeRaw = req.body?.contentType ? String(req.body.contentType) : null;

  if (!REPORT_CATEGORIES.has(category)) {
    return res.status(400).json({ error: 'BAD_CATEGORY' });
  }
  if (details.length < 3) {
    return res.status(400).json({ error: 'DETAILS_TOO_SHORT' });
  }
  if (!isSafeUploadUrl(imageUrl)) {
    return res.status(400).json({ error: 'BAD_IMAGE_URL' });
  }
  // contentType only applies to VOD requests; validate when provided.
  let contentType = null;
  if (category === 'VOD' && contentTypeRaw) {
    if (!CONTENT_TYPES.has(contentTypeRaw)) {
      return res.status(400).json({ error: 'BAD_CONTENT_TYPE' });
    }
    contentType = contentTypeRaw;
  }

  // Daily quota: max 2 reports per user per rolling 24 hours.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const todayCount = await prisma.report.count({
    where: { userId: req.user.userId, createdAt: { gte: since } },
  });
  if (todayCount >= MAX_REPORTS_PER_DAY) {
    return res.status(429).json({ error: 'DAILY_REPORT_LIMIT', limit: MAX_REPORTS_PER_DAY });
  }

  const report = await prisma.report.create({
    data: { userId: req.user.userId, category, details, imageUrl, contentType },
    include: {
      user: { select: { iptvUsername: true } },
      responses: { orderBy: { createdAt: 'asc' } },
    },
  });

  io.to('admins').emit('report:new', report);
  return res.status(201).json({ report });
});

app.get('/api/reports/my', requireAuth, async (req, res) => {
  const reports = await prisma.report.findMany({
    where: { userId: req.user.userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { responses: { orderBy: { createdAt: 'asc' } } },
  });
  return res.json({ reports });
});

// ---------------------------------------------------------------------------
// Admin REST — incident queue, user directory, chat console
// ---------------------------------------------------------------------------
app.get('/api/admin/reports', requireAuth, requireAdmin, async (req, res) => {
  const me = req.user.iptvUsername;
  const meLower = me.toLowerCase();
  const reports = await prisma.report.findMany({
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      user: { select: { iptvUsername: true } },
      responses: { orderBy: { createdAt: 'asc' } },
    },
  });

  // Queue lanes:
  //   - anything assigned to me always shows
  //   - Elit (first admin in ADMIN_USERNAMES) = superadmin → sees ALL tickets
  //   - vodsupport (username contains 'vod') → only VOD
  //   - other agents (support) → general queue (LIVE/SUGGESTION/OTHER), no VOD
  const SUPER_ADMIN = (process.env.ADMIN_USERNAMES || '').split(',')[0]?.trim().toLowerCase();
  const isSuper = meLower === SUPER_ADMIN;
  const isVodAgent = meLower.includes('vod');

  const visible = reports.filter((r) => {
    if (r.assignee) return r.assignee.toLowerCase() === meLower;
    if (isSuper) return true;                       // superadmin sees everything
    if (r.category === 'VOD') return isVodAgent;    // VOD lane
    return !isVodAgent;                             // general lane (not the VOD agent)
  });

  return res.json({ reports: visible });
});

// ---- Forward a ticket to another agent by username ------------------------
app.patch('/api/admin/reports/:id/assign', requireAuth, requireAdmin, async (req, res) => {
  const assignee = sanitizeText(req.body?.assignee || '', 100) || null;
  if (assignee) {
    const exists = await prisma.user.findUnique({ where: { iptvUsername: assignee } });
    if (!exists) return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
  }

  const report = await prisma.report.findUnique({ where: { id: req.params.id } });
  if (!report) return res.status(404).json({ error: 'NOT_FOUND' });

  const updated = await prisma.report.update({
    where: { id: report.id },
    data: { assignee },
    include: {
      user: { select: { iptvUsername: true } },
      responses: { orderBy: { createdAt: 'asc' } },
    },
  });

  io.to('admins').emit('report:update', updated);
  return res.json({ report: updated });
});

app.patch('/api/admin/reports/:id/status', requireAuth, requireAdmin, async (req, res) => {
  const status = String(req.body?.status || '');
  if (!REPORT_STATUSES.has(status)) {
    return res.status(400).json({ error: 'BAD_STATUS' });
  }

  const existing = await prisma.report.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  const report = await prisma.report.update({
    where: { id: existing.id },
    data: { status },
    include: { user: { select: { iptvUsername: true } } },
  });

  io.to(`user:${report.userId}`).emit('report:update', report);
  io.to('admins').emit('report:update', report);
  return res.json({ report });
});

// ---- Admin replies inside a report ticket -------------------------------
app.post('/api/admin/reports/:id/responses', requireAuth, requireAdmin, async (req, res) => {
  const text = sanitizeText(req.body?.text || '', 2000);
  if (text.length < 1) {
    return res.status(400).json({ error: 'EMPTY_RESPONSE' });
  }

  const report = await prisma.report.findUnique({ where: { id: req.params.id } });
  if (!report) return res.status(404).json({ error: 'NOT_FOUND' });

  const response = await prisma.reportResponse.create({
    data: {
      reportId: report.id,
      senderName: req.user.agentName || req.user.iptvUsername,
      text,
    },
  });

  const payload = { reportId: report.id, userId: report.userId, response };
  io.to(`user:${report.userId}`).emit('report:response', payload);
  io.to('admins').emit('report:response', payload);
  return res.status(201).json({ response });
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { role: 'USER' },
    orderBy: { createdAt: 'desc' },
    take: 300,
    select: {
      id: true,
      iptvUsername: true,
      createdAt: true,
      _count: { select: { reports: { where: { status: 'OPEN' } } } },
      chatSessions: { where: { status: 'ACTIVE' }, select: { id: true }, take: 1 },
    },
  });

  return res.json({
    users: users.map((u) => ({
      id: u.id,
      iptvUsername: u.iptvUsername,
      createdAt: u.createdAt,
      openReports: u._count.reports,
      activeSessionId: u.chatSessions[0]?.id ?? null,
    })),
  });
});

app.get('/api/admin/chats', requireAuth, requireAdmin, async (req, res) => {
  const include = {
    user: { select: { id: true, iptvUsername: true } },
    messages: { orderBy: { createdAt: 'desc' }, take: 1 },
  };

  // Time-window filters. Day boundaries use the server's local midnight.
  const dayStart = (offsetDays = 0) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - offsetDays);
    return d;
  };
  const range = String(req.query.range || 'auto');
  let where = {};
  if (range === 'today') where = { updatedAt: { gte: dayStart(0) } };
  else if (range === 'yesterday') where = { updatedAt: { gte: dayStart(1), lt: dayStart(0) } };
  else if (range === 'week') where = { updatedAt: { gte: dayStart(7) } };
  // 'all' → no date filter

  // Smart default ('auto'): today's chats, but if fewer than 25, pad with the
  // most recent chats overall so the list isn't empty on a quiet morning.
  if (range === 'auto') {
    const today = await prisma.chatSession.findMany({
      where: { updatedAt: { gte: dayStart(0) } },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include,
    });
    if (today.length >= 25) return res.json({ sessions: today, range: 'today' });
    const recent = await prisma.chatSession.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 25,
      include,
    });
    return res.json({ sessions: recent, range: 'recent' });
  }

  const sessions = await prisma.chatSession.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: 200,
    include,
  });
  return res.json({ sessions, range });
});

// ---- Search chat sessions by username OR message content ------------------
app.get('/api/admin/chats/search', requireAuth, requireAdmin, async (req, res) => {
  const q = sanitizeText(req.query.q || '', 100).trim();
  if (!q) return res.json({ sessions: [] });

  // Sessions whose owner's username matches
  const byUser = await prisma.chatSession.findMany({
    where: { user: { iptvUsername: { contains: q } } },
    include: {
      user: { select: { id: true, iptvUsername: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  // Sessions containing a matching message
  const byMessage = await prisma.chatSession.findMany({
    where: { messages: { some: { text: { contains: q } } } },
    include: {
      user: { select: { id: true, iptvUsername: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  // Merge + dedupe by session id, newest activity first
  const map = new Map();
  for (const s of [...byUser, ...byMessage]) map.set(s.id, s);
  const sessions = [...map.values()].sort(
    (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
  );

  return res.json({ sessions });
});

// ---------------------------------------------------------------------------
// Chat REST — persistence layer (history survives re-login indefinitely)
// ---------------------------------------------------------------------------
app.get('/api/chat/session', requireAuth, async (req, res) => {
  const session = await prisma.chatSession.findFirst({
    where: { userId: req.user.userId, status: 'ACTIVE' },
    include: { messages: { orderBy: { createdAt: 'asc' }, take: 500 } },
  });
  return res.json({ session });
});

app.get('/api/chat/:sessionId/messages', requireAuth, async (req, res) => {
  const session = await prisma.chatSession.findUnique({ where: { id: req.params.sessionId } });
  if (!session) return res.status(404).json({ error: 'NOT_FOUND' });
  if (req.user.role !== 'ADMIN' && session.userId !== req.user.userId) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  const messages = await prisma.chatMessage.findMany({
    where: { chatSessionId: session.id },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  return res.json({ session, messages });
});

// ---------------------------------------------------------------------------
// Central error handler (Multer + UploadError + fallback)
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'FILE_TOO_LARGE' });
    return res.status(400).json({ error: 'UPLOAD_REJECTED' });
  }
  if (err instanceof UploadError) {
    return res.status(err.status).json({ error: err.code });
  }
  console.error('[server] unhandled error:', err);
  return res.status(500).json({ error: 'SERVER_ERROR' });
});

// ---------------------------------------------------------------------------
// HTTP server + Socket.io
// ---------------------------------------------------------------------------
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: CLIENT_URL, credentials: true },
  maxHttpBufferSize: 1e6, // socket payloads stay small — files go through /api/upload
});

// Socket handshake authentication — verify the JWT before any connection.
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('UNAUTHORIZED'));
    socket.user = verifyToken(token);
    return next();
  } catch {
    return next(new Error('UNAUTHORIZED'));
  }
});

/** Finds or creates the customer's ACTIVE chat session. */
async function getOrCreateActiveSession(userId) {
  const existing = await prisma.chatSession.findFirst({
    where: { userId, status: 'ACTIVE' },
  });
  if (existing) return existing;
  return prisma.chatSession.create({ data: { userId } });
}

async function touchSession(sessionId) {
  await prisma.chatSession.update({ where: { id: sessionId }, data: { updatedAt: new Date() } });
}

io.on('connection', (socket) => {
  const me = socket.user;
  socket.join(`user:${me.userId}`);
  if (me.role === 'ADMIN') socket.join('admins');

  // ---- Customer sends a message -------------------------------------------
  socket.on('chat:send', async (payload, ack) => {
    try {
      if (me.role !== 'USER') return ack?.({ ok: false, error: 'FORBIDDEN' });
      if (chatThrottle.tooFast(socket.id)) return ack?.({ ok: false, error: 'CHAT_RATE_LIMIT' });

      const text = sanitizeText(payload?.text ?? '', 2000);
      const imageUrl = payload?.imageUrl ?? null;
      if (!text && !imageUrl) return ack?.({ ok: false, error: 'EMPTY_MESSAGE' });
      if (!isSafeUploadUrl(imageUrl)) return ack?.({ ok: false, error: 'BAD_IMAGE_URL' });

      const session = await getOrCreateActiveSession(me.userId);
      const message = await prisma.chatMessage.create({
        data: {
          chatSessionId: session.id,
          senderRole: 'USER',
          senderName: me.iptvUsername,
          text: text || null,
          imageUrl,
        },
      });
      await touchSession(session.id);

      io.to(`user:${me.userId}`).to('admins').emit('chat:message', {
        sessionId: session.id,
        userId: me.userId,
        message,
      });
      return ack?.({ ok: true, sessionId: session.id, message });
    } catch (err) {
      console.error('[socket] chat:send failed:', err);
      return ack?.({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  // ---- Agent replies inside a session --------------------------------------
  socket.on('chat:reply', async (payload, ack) => {
    try {
      if (me.role !== 'ADMIN') return ack?.({ ok: false, error: 'FORBIDDEN' });
      if (chatThrottle.tooFast(socket.id)) return ack?.({ ok: false, error: 'CHAT_RATE_LIMIT' });

      const sessionId = String(payload?.sessionId || '');
      const session = await prisma.chatSession.findUnique({ where: { id: sessionId } });
      if (!session) return ack?.({ ok: false, error: 'NOT_FOUND' });

      const text = sanitizeText(payload?.text ?? '', 2000);
      const imageUrl = payload?.imageUrl ?? null;
      if (!text && !imageUrl) return ack?.({ ok: false, error: 'EMPTY_MESSAGE' });
      if (!isSafeUploadUrl(imageUrl)) return ack?.({ ok: false, error: 'BAD_IMAGE_URL' });

      const message = await prisma.chatMessage.create({
        data: {
          chatSessionId: session.id,
          senderRole: 'ADMIN',
          senderName: me.agentName || me.iptvUsername, // agent attribution on bubbles
          text: text || null,
          imageUrl,
        },
      });
      await touchSession(session.id);

      io.to(`user:${session.userId}`).to('admins').emit('chat:message', {
        sessionId: session.id,
        userId: session.userId,
        message,
      });
      return ack?.({ ok: true, sessionId: session.id, message });
    } catch (err) {
      console.error('[socket] chat:reply failed:', err);
      return ack?.({ ok: false, error: 'SERVER_ERROR' });
    }
  });

  // ---- Admin trigger: open a live chat on the customer's screen ------------
  socket.on('chat:open', async (payload, ack) => {
    try {
      if (me.role !== 'ADMIN') return ack?.({ ok: false, error: 'FORBIDDEN' });

      const targetId = String(payload?.userId || '');
      const target = await prisma.user.findUnique({ where: { id: targetId } });
      if (!target) return ack?.({ ok: false, error: 'NOT_FOUND' });

      const session = await getOrCreateActiveSession(target.id);
      const messages = await prisma.chatMessage.findMany({
        where: { chatSessionId: session.id },
        orderBy: { createdAt: 'asc' },
        take: 500,
      });

      // Real-time event — the user's client pops the chat modal if online.
      io.to(`user:${target.id}`).emit('chat:invited', {
        sessionId: session.id,
        agentName: me.agentName || me.iptvUsername,
      });

      return ack?.({ ok: true, session, messages });
    } catch (err) {
      console.error('[socket] chat:open failed:', err);
      return ack?.({ ok: false, error: 'SERVER_ERROR' });
    }
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
startCleanupCron();

server.listen(PORT, () => {
  console.log(`[server] Ghost support API listening on http://localhost:${PORT}`);
  console.log(`[server] CORS locked to: ${CLIENT_URL}`);
  console.log(`[server] Admin usernames: ${ADMIN_USERNAMES.size ? [...ADMIN_USERNAMES].join(', ') : '(none configured)'}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
