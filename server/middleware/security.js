import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fileTypeFromBuffer } from 'file-type';

// ---------------------------------------------------------------------------
// Uploads directory (resolved absolutely once; every write is verified against it)
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.resolve(__dirname, '..', 'uploads');

export function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Helmet — robust security headers.
// CSP is disabled globally here because the SPA is served by the frontend host;
// the /uploads static route sets its own strict CSP (default-src 'none').
// CORP is 'cross-origin' so the frontend origin can <img> the uploaded files.
// ---------------------------------------------------------------------------
export const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
});

// ---------------------------------------------------------------------------
// Rate limiters (express-rate-limit)
// ---------------------------------------------------------------------------
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const limiterDefaults = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'TOO_MANY_REQUESTS' },
};

/** /api/auth/login — 10 req / 15 min / IP (brute-force protection) */
export const loginLimiter = rateLimit({ ...limiterDefaults, windowMs: FIFTEEN_MINUTES, limit: 10 });

/** /api/upload — 20 uploads / 15 min / IP (storage-exhaustion protection) */
export const uploadLimiter = rateLimit({ ...limiterDefaults, windowMs: FIFTEEN_MINUTES, limit: 20 });

/** Everything else under /api — 150 req / 15 min / IP */
export const apiLimiter = rateLimit({ ...limiterDefaults, windowMs: FIFTEEN_MINUTES, limit: 150 });

// ---------------------------------------------------------------------------
// Multi-tier file upload validation
// ---------------------------------------------------------------------------

/** Strict allowlist. SVG is explicitly BANNED (stored-XSS vector), as are
 *  executables, HTML, PHP and any script — they can never pass this map. */
const ALLOWED_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // hard 4MB limit

export class UploadError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/**
 * Multer configured with MEMORY storage — buffers are inspected in RAM and
 * nothing touches the disk until magic bytes have been verified.
 */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    // Tier 1: reject obviously wrong client-declared MIME types early.
    if (!ALLOWED_TYPES.has((file.mimetype || '').toLowerCase())) {
      return cb(new UploadError('UNSUPPORTED_FILE_TYPE', 415));
    }
    cb(null, true);
  },
});

/**
 * Tier 2: inspect the actual binary magic numbers with `file-type`
 * (never trust file.mimetype or the original extension), then persist with a
 * cryptographically random UUID filename inside UPLOAD_DIR only.
 *
 * @param {Express.Multer.File} file multer memory-storage file
 * @returns {Promise<{ filename: string, url: string }>}
 */
export async function persistVerifiedImage(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new UploadError('EMPTY_FILE', 400);
  }

  // Magic-byte verification — a PHP/HTML shell renamed to .jpg dies here.
  const detected = await fileTypeFromBuffer(file.buffer);
  if (!detected || !ALLOWED_TYPES.has(detected.mime)) {
    throw new UploadError('MAGIC_BYTES_MISMATCH', 415);
  }

  // Filename sanitization & randomization: original name is discarded entirely.
  const ext = ALLOWED_TYPES.get(detected.mime); // extension derived from MAGIC BYTES
  const filename = `${crypto.randomUUID()}.${ext}`;

  // Path traversal defense: resolve and verify containment in UPLOAD_DIR.
  const target = path.resolve(UPLOAD_DIR, filename);
  const root = UPLOAD_DIR.endsWith(path.sep) ? UPLOAD_DIR : UPLOAD_DIR + path.sep;
  if (!target.startsWith(root)) {
    throw new UploadError('PATH_TRAVERSAL_BLOCKED', 400);
  }

  await fsp.writeFile(target, file.buffer, { flag: 'wx' });
  return { filename, url: `/uploads/${filename}` };
}

// ---------------------------------------------------------------------------
// Text input sanitization — neutralizes HTML/script injection before DB writes.
// React escapes output too, this is the defense-in-depth layer.
// ---------------------------------------------------------------------------
export function sanitizeText(input, maxLength = 2000) {
  if (typeof input !== 'string') return '';
  return input
    .slice(0, maxLength)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .trim();
}

// ---------------------------------------------------------------------------
// Validates that an imageUrl stored on a report/message points to a real,
// server-generated upload (UUID name + whitelisted extension, inside UPLOAD_DIR).
// ---------------------------------------------------------------------------
const UPLOAD_URL_RE = /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

export function isSafeUploadUrl(url) {
  if (url === null || url === undefined) return true; // optional field
  if (typeof url !== 'string' || !UPLOAD_URL_RE.test(url)) return false;
  const target = path.resolve(UPLOAD_DIR, path.basename(url));
  return target.startsWith(UPLOAD_DIR + path.sep);
}
