import { Router } from 'express';
import { execFile as _execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROVISION_SCRIPT = path.resolve(__dirname, '../scripts/provision-identity-hosts.sh');

const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

// Factory exported for testing: pass a mock execFile to avoid real sudo calls.
export function createAdminRouter(execFile = _execFile) {
  const router = Router();

  // POST /api/admin/provision-identity
  // Body: { domain: "example.com" }
  // Triggers provision-identity-hosts.sh for the given domain on this VPS.
  // Requires a one-time sudoers entry (see AGENTS.md).
  router.post('/provision-identity', (req, res) => {
    const { domain } = req.body || {};

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'domain is required' });
    }
    if (!DOMAIN_RE.test(domain.trim())) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    const sanitizedDomain = domain.trim().toLowerCase();

    execFile(
      'sudo',
      [PROVISION_SCRIPT, sanitizedDomain],
      { timeout: 300_000, maxBuffer: 512 * 1024 },
      (err, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (err) {
          console.error(`[admin/provision-identity] failed for ${sanitizedDomain}:`, err.message);
          return res.status(500).json({ error: 'Provisioning script failed', output });
        }
        res.json({ ok: true, domain: sanitizedDomain, output });
      }
    );
  });

  return router;
}

export default createAdminRouter();
