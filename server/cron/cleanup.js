import cron from 'node-cron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { UPLOAD_DIR, ensureUploadDir } from '../middleware/security.js';

/** 7 days in milliseconds — images older than this are permanently deleted. */
export const MAX_FILE_AGE_MS = 604_800_000; // 7 * 24 * 60 * 60 * 1000

/**
 * Scans the uploads directory and unlinks every file older than 7 days.
 * Safe against path tricks: only direct file children of UPLOAD_DIR are touched.
 *
 * @param {number} [now] injectable clock for testing
 * @returns {Promise<{ scanned: number, deleted: number, errors: number }>}
 */
export async function sweepUploads(now = Date.now()) {
  ensureUploadDir();

  let entries;
  try {
    entries = await fsp.readdir(UPLOAD_DIR, { withFileTypes: true });
  } catch (err) {
    console.error('[cron] unable to read uploads directory:', err.message);
    return { scanned: 0, deleted: 0, errors: 1 };
  }

  let scanned = 0;
  let deleted = 0;
  let errors = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    scanned += 1;

    const target = path.resolve(UPLOAD_DIR, entry.name);
    if (!target.startsWith(UPLOAD_DIR + path.sep)) continue; // traversal guard

    try {
      const stats = await fsp.stat(target);
      if (now - stats.mtimeMs > MAX_FILE_AGE_MS) {
        await fsp.unlink(target);
        deleted += 1;
      }
    } catch (err) {
      errors += 1;
      console.error(`[cron] failed to process ${entry.name}:`, err.message);
    }
  }

  return { scanned, deleted, errors };
}

/**
 * Registers the daily midnight worker (0 0 * * *) and runs one sweep at boot
 * so a long-offline VPS still gets cleaned immediately.
 */
export function startCleanupCron() {
  const task = cron.schedule('0 0 * * *', async () => {
    const result = await sweepUploads();
    console.log(
      `[cron] midnight sweep — scanned=${result.scanned} deleted=${result.deleted} errors=${result.errors}`,
    );
  });

  sweepUploads().then((result) => {
    if (result.deleted > 0) {
      console.log(`[cron] boot sweep removed ${result.deleted} expired upload(s)`);
    }
  });

  return task;
}
