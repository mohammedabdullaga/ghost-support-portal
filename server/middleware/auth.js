import jwt from 'jsonwebtoken';

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.warn('[security] JWT_SECRET is not set — using an insecure development fallback!');
}

/**
 * Issues the session token: { userId, iptvUsername, role, agentName }
 */
export function signToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      iptvUsername: user.iptvUsername,
      role: user.role,
      agentName: user.agentName ?? null,
    },
    JWT_SECRET,
    { expiresIn: '7d' },
  );
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/** Express middleware: requires a valid Bearer JWT. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'UNAUTHORIZED' });
  try {
    req.user = verifyToken(token);
    return next();
  } catch {
    return res.status(401).json({ error: 'INVALID_TOKEN' });
  }
}

/** Express middleware: requires role === "ADMIN". Mount after requireAuth. */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'FORBIDDEN' });
  return next();
}
