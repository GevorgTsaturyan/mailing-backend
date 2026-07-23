import express from 'express';
import { requireAuth }  from '../middleware/auth.js';
import { findByApiKey } from '../services/NodeRepository.js';
import { poll }         from '../services/PollingService.js';
import * as JobService  from '../services/JobService.js';

const router = express.Router();

// ── Auth helpers ──────────────────────────────────────────────────────────────

// Resolve a mail-node from the apiKey carried in query-string or body.
// Writes an error response and returns null on failure.
function resolveNode(apiKey, res) {
  if (!apiKey) {
    res.status(401).json({ error: 'apiKey is required' });
    return null;
  }
  const server = findByApiKey(apiKey);
  if (!server) {
    res.status(401).json({ error: 'Invalid apiKey' });
    return null;
  }
  return server;
}

// nodeId stored in jobs.node_id — we use the server's integer PK as a string
// so it's always set (unlike servers.node_id which requires registration first).
function nodeIdOf(server) {
  return String(server.id);
}

// ── POST /api/jobs ────────────────────────────────────────────────────────────
// Create a new job.  JWT-authenticated (called by the controller UI or admin scripts).
// Body: { identity_id?, recipient, subject, body?, priority? }
router.post('/', requireAuth, (req, res) => {
  const { identity_id, recipient, subject, body, priority } = req.body;
  try {
    const job = JobService.createJob({ identity_id, recipient, subject, body, priority });
    res.status(201).json(job);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/jobs/poll?apiKey=… ───────────────────────────────────────────────
// Returns the next available PENDING job, or 204 No Content if the queue is empty.
// This is a read-only peek — the job is NOT claimed yet.
// The node must follow up with POST /api/jobs/:id/start to atomically claim it.
router.get('/poll', (req, res) => {
  const server = resolveNode(req.query.apiKey, res);
  if (!server) return;

  const job = poll();
  if (!job) return res.status(204).end();
  res.json(job);
});

// ── POST /api/jobs/:id/start ──────────────────────────────────────────────────
// Atomically claims the job: PENDING → PROCESSING.
// Returns 409 if another node already claimed it — the caller should re-poll.
// Body: { apiKey }
router.post('/:id/start', (req, res) => {
  const server = resolveNode(req.body.apiKey, res);
  if (!server) return;

  const result = JobService.startJob(Number(req.params.id), nodeIdOf(server));
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

// ── POST /api/jobs/:id/complete ───────────────────────────────────────────────
// Marks a PROCESSING job as SENT.  Only the node that claimed it may complete it.
// Body: { apiKey, queue_id? }  — queue_id is the Postfix queue ID; omitting it is valid.
router.post('/:id/complete', (req, res) => {
  const server = resolveNode(req.body.apiKey, res);
  if (!server) return;

  const result = JobService.completeJob(
    Number(req.params.id),
    nodeIdOf(server),
    req.body.queue_id ?? null,
  );
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

// ── POST /api/jobs/:id/fail ───────────────────────────────────────────────────
// Marks a PROCESSING job as FAILED.  Only the node that claimed it may fail it.
// Body: { apiKey, error_message? }
router.post('/:id/fail', (req, res) => {
  const server = resolveNode(req.body.apiKey, res);
  if (!server) return;

  const result = JobService.failJob(
    Number(req.params.id),
    nodeIdOf(server),
    req.body.error_message ?? null,
  );
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

export default router;
