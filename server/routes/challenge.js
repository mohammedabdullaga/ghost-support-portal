import express from 'express';
import crypto from 'node:crypto';
import { createChallengeStore } from '../lib/challenge.js';

export const challengeRouter = express.Router();
export const challengeStore = createChallengeStore();

// Issue a fresh proof-of-interaction challenge.
// The client must drag a slider to `target` before login is allowed.
challengeRouter.get('/api/auth/challenge', (_req, res) => {
  const id = crypto.randomUUID();
  const target = crypto.randomInt(15, 86); // 15–85% along the track
  challengeStore.issue(id, target);
  res.json({ challengeId: id, target });
});
