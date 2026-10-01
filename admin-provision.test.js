import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { createAdminRouter, PROVISION_SCRIPT } from './routes/admin.js';
import { requireAuth } from './middleware/auth.js';

// Use a fixed test secret so requireAuth can verify tokens we sign here.
const TEST_SECRET = 'test-secret-for-admin-provision-tests';
process.env.JWT_SECRET = TEST_SECRET;

// ── Mock execFile ─────────────────────────────────────────────────────────────
let capturedArgs = null;  // [cmd, argsArray]
let execShouldFail = false;

function mockExecFile(cmd, args, _opts, cb) {
  capturedArgs = [cmd, args];
  if (execShouldFail) {
    cb(new Error('script failed'), '', 'some stderr');
  } else {
    cb(null, 'provisioned ok', '');
  }
}

// Build a minimal app wired exactly like index.js
const app = express();
app.use(express.json());
app.use('/api', requireAuth);
app.use('/api/admin', createAdminRouter(mockExecFile));

// ── HTTP helper ───────────────────────────────────────────────────────────────
let server;
let port;

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const TOKEN = jwt.sign({ id: 1, username: 'testadmin' }, TEST_SECRET, { expiresIn: '1h' });
const AUTH  = { Authorization: `Bearer ${TOKEN}` };

before(() => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
}));

after(() => server.close());

describe('POST /api/admin/provision-identity', () => {
  it('returns 401 without Authorization header', async () => {
    const { status } = await req('POST', '/api/admin/provision-identity', { domain: 'example.com' });
    assert.equal(status, 401);
  });

  it('returns 401 with a malformed token', async () => {
    const { status } = await req('POST', '/api/admin/provision-identity', { domain: 'example.com' }, {
      Authorization: 'Bearer not-a-real-token',
    });
    assert.equal(status, 401);
  });

  it('returns 400 when domain is missing', async () => {
    const { status, body } = await req('POST', '/api/admin/provision-identity', {}, AUTH);
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  it('returns 400 when domain is empty string', async () => {
    const { status } = await req('POST', '/api/admin/provision-identity', { domain: '' }, AUTH);
    assert.equal(status, 400);
  });

  it('returns 400 for a domain with shell metacharacters (injection attempt)', async () => {
    const { status } = await req('POST', '/api/admin/provision-identity', {
      domain: 'example.com; rm -rf /',
    }, AUTH);
    assert.equal(status, 400);
  });

  it('returns 400 for a domain with $() injection', async () => {
    const { status } = await req('POST', '/api/admin/provision-identity', {
      domain: '$(evil)',
    }, AUTH);
    assert.equal(status, 400);
  });

  it('returns 400 for a bare hostname without a TLD', async () => {
    const { status } = await req('POST', '/api/admin/provision-identity', {
      domain: 'localhost',
    }, AUTH);
    assert.equal(status, 400);
  });

  it('calls execFile as (sudo, [scriptPath, domain]) — never a shell string', async () => {
    capturedArgs = null;
    const { status } = await req('POST', '/api/admin/provision-identity', {
      domain: 'good-domain.com',
    }, AUTH);
    assert.equal(status, 200);
    assert.ok(capturedArgs, 'execFile was not called');
    const [cmd, args] = capturedArgs;
    assert.equal(cmd, 'sudo');
    assert.ok(Array.isArray(args), 'second arg must be an array');
    assert.equal(args[0], PROVISION_SCRIPT, 'first array element must be the script path');
    assert.equal(args[1], 'good-domain.com', 'second array element must be the sanitized domain');
    assert.equal(args.length, 2, 'must pass exactly [scriptPath, domain]');
  });

  it('lowercases the domain before passing to script', async () => {
    capturedArgs = null;
    await req('POST', '/api/admin/provision-identity', { domain: 'Example.COM' }, AUTH);
    assert.ok(capturedArgs);
    const [, args] = capturedArgs;
    assert.equal(args[1], 'example.com');
  });

  it('returns 500 with error when the provision script exits non-zero', async () => {
    execShouldFail = true;
    const { status, body } = await req('POST', '/api/admin/provision-identity', {
      domain: 'fail-domain.net',
    }, AUTH);
    execShouldFail = false;
    assert.equal(status, 500);
    assert.ok(body.error);
  });

  it('returns 200 with ok:true and output on success', async () => {
    const { status, body } = await req('POST', '/api/admin/provision-identity', {
      domain: 'ok-domain.org',
    }, AUTH);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.domain, 'ok-domain.org');
    assert.equal(typeof body.output, 'string');
  });
});
