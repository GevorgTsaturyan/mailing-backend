// ─── CloudflareService ────────────────────────────────────────────────────────
// Cloudflare DNS provisioning for sender identities (controller-side).
// CF_API_TOKEN env var controls whether automation is enabled.
// All operations are idempotent and fail-safe: errors are returned as phase
// status objects, never thrown to the caller.
//
// Rules enforced by each operation:
//   A record:   absent→create, correct→skip, wrong→update
//   MX record:  absent→create (priority 10 mail.<domain>), correct→skip,
//               wrong host/priority→update (reconcile to expected)
//   SPF:        absent→create, 1 record+ip→skip, 1 record−ip→merge,
//               2+ records→fail (RFC violation, manual fix required)
//   DKIM TXT:   absent→create, identical→skip, different→fail (never overwrite)
//   DMARC:      absent→create p=none, existing→preserve (never overwrite)
//   unsubscribe/click A: same rules as A record

const CF_BASE = 'https://api.cloudflare.com/client/v4';

function token() { return process.env.CF_API_TOKEN || ''; }

export function isConfigured() { return Boolean(token()); }

// Authenticated Cloudflare API call.  Throws on API-level errors so callers
// can catch and convert to phase-status objects.
async function cfFetch(method, path, body = null) {
  const res = await fetch(`${CF_BASE}${path}`, {
    method,
    headers: {
      Authorization:  `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({ success: false, errors: [{ message: `HTTP ${res.status}` }] }));
  if (!data.success) {
    const msg = (data.errors || []).map(e => e.message || JSON.stringify(e)).join('; ') || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data.result;
}

// Find the Cloudflare zone that owns a domain (tries parent domains so
// subdomains work: click.example.com → example.com).
export async function findZoneId(domain) {
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    try {
      const result = await cfFetch('GET', `/zones?name=${encodeURIComponent(candidate)}&per_page=1`);
      if (Array.isArray(result) && result.length > 0) return result[0].id;
    } catch { /* try shorter suffix */ }
  }
  throw new Error(`No Cloudflare zone found for domain: ${domain}`);
}

async function listRecords(zoneId, type, name) {
  return cfFetch('GET', `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}&per_page=20`);
}

async function createRecord(zoneId, type, name, content, proxied = false) {
  return cfFetch('POST', `/zones/${zoneId}/dns_records`, { type, name, content, proxied, ttl: 1 });
}

async function patchRecord(zoneId, id, type, name, content, proxied = false) {
  return cfFetch('PATCH', `/zones/${zoneId}/dns_records/${id}`, { type, name, content, proxied, ttl: 1 });
}

// ─── Per-record helpers ───────────────────────────────────────────────────────

async function ensureARecord(zoneId, fqdn, targetIp) {
  const records = await listRecords(zoneId, 'A', fqdn);
  if (records.length === 0) {
    await createRecord(zoneId, 'A', fqdn, targetIp);
    return { status: 'OK', message: `A ${fqdn} → ${targetIp} (created)` };
  }
  const rec = records[0];
  if (rec.content === targetIp) {
    return { status: 'SKIPPED', message: `A ${fqdn} → ${targetIp} (already correct)` };
  }
  await patchRecord(zoneId, rec.id, 'A', fqdn, targetIp);
  return { status: 'OK', message: `A ${fqdn} → ${targetIp} (updated from ${rec.content})` };
}

async function ensureMX(zoneId, domain, priority = 10) {
  const mailHost = `mail.${domain}`;
  const records  = await listRecords(zoneId, 'MX', domain);

  if (records.length === 0) {
    await cfFetch('POST', `/zones/${zoneId}/dns_records`, {
      type: 'MX', name: domain, content: mailHost, priority, proxied: false, ttl: 1,
    });
    return { status: 'OK', message: `MX ${domain} 10 ${mailHost} (created)` };
  }

  const correct = records.find(r => r.content === mailHost && Number(r.priority) === priority);
  if (correct) {
    return { status: 'SKIPPED', message: `MX ${domain} 10 ${mailHost} (already correct)` };
  }

  // Reconcile: wrong host or wrong priority — update the first record
  const rec = records[0];
  await cfFetch('PATCH', `/zones/${zoneId}/dns_records/${rec.id}`, {
    type: 'MX', name: domain, content: mailHost, priority, proxied: false, ttl: 1,
  });
  return { status: 'OK', message: `MX ${domain} 10 ${mailHost} (updated from ${rec.content})` };
}

async function ensureSPF(zoneId, domain, ip) {
  const allTxt = await cfFetch(
    'GET',
    `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(domain)}&per_page=20`
  );
  const spf = Array.isArray(allTxt) ? allTxt.filter(r => r.content.startsWith('v=spf1')) : [];

  if (spf.length >= 2) {
    return { status: 'FAILED', message: `${spf.length} SPF records found — RFC violation, manual fix required` };
  }
  if (spf.length === 0) {
    await createRecord(zoneId, 'TXT', domain, `v=spf1 ip4:${ip} ~all`);
    return { status: 'OK', message: `SPF created: v=spf1 ip4:${ip} ~all` };
  }

  const existing = spf[0];
  if (existing.content.includes(`ip4:${ip}`)) {
    return { status: 'SKIPPED', message: `SPF already contains ip4:${ip}` };
  }

  // Merge: insert ip4:<ip> before the final qualifier (~all, -all, ?all, +all)
  const merged = existing.content.replace(/(\s)(~|-|\?|\+)?all\s*$/, ` ip4:${ip} $1$2all`).trim();
  const finalContent = merged !== existing.content ? merged
    : existing.content.replace('~all', `ip4:${ip} ~all`)
                      .replace('-all', `ip4:${ip} -all`);
  await patchRecord(zoneId, existing.id, 'TXT', domain, finalContent);
  return { status: 'OK', message: `SPF merged: ${finalContent}` };
}

async function ensureDKIM(zoneId, domain, selector, dkimPublicKey) {
  if (!dkimPublicKey) {
    return { status: 'PENDING', message: 'DKIM public key not yet available from mail-node' };
  }
  const name = `${selector}._domainkey.${domain}`;
  const content = `v=DKIM1; k=rsa; p=${dkimPublicKey}`;
  const records = await listRecords(zoneId, 'TXT', name);

  if (records.length === 0) {
    await createRecord(zoneId, 'TXT', name, content);
    return { status: 'OK', message: `DKIM TXT ${name} created` };
  }
  // Normalise for comparison: strip all whitespace and quote characters
  const normalise = s => s.replace(/["\s]/g, '');
  if (normalise(records[0].content).includes(normalise(`p=${dkimPublicKey}`))) {
    return { status: 'SKIPPED', message: `DKIM TXT ${name} already correct` };
  }
  return {
    status: 'FAILED',
    message: `DKIM DNS mismatch on ${name} — existing record has a different key. Manual fix required.`,
  };
}

async function ensureDMARC(zoneId, domain) {
  const name = `_dmarc.${domain}`;
  const records = await listRecords(zoneId, 'TXT', name);
  if (records.length > 0) {
    return { status: 'SKIPPED', message: `DMARC preserved: ${records[0].content}` };
  }
  const content = `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`;
  await createRecord(zoneId, 'TXT', name, content);
  return { status: 'OK', message: `DMARC created: ${content}` };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

// provisionDns — create/verify all DNS records for a sender identity.
// Returns { ok, skipped?, phases, error? }
//   ok=true   → all phases passed (OK or SKIPPED) and none is FAILED
//   ok=false  → at least one FAILED, or CF not configured
//   skipped=true → CF_API_TOKEN not configured (caller should show MANUAL steps)
export async function provisionDns({ domain, ip, selector, dkimPublicKey, controllerIp }) {
  if (!isConfigured()) {
    return {
      ok: false,
      skipped: true,
      message: 'CF_API_TOKEN not configured — DNS records must be created manually',
      phases: {},
    };
  }

  const phases = {};
  let hasFailed = false;
  let hasPending = false;

  // Discover zone
  let zoneId;
  try {
    zoneId = await findZoneId(domain);
  } catch (err) {
    return { ok: false, error: err.message, phases: { zone: { status: 'FAILED', message: err.message } } };
  }

  async function run(key, fn) {
    try {
      phases[key] = await fn();
      if (phases[key].status === 'FAILED') hasFailed = true;
      if (phases[key].status === 'PENDING') hasPending = true;
    } catch (err) {
      phases[key] = { status: 'FAILED', message: err.message };
      hasFailed = true;
    }
  }

  await run('a_mail',        () => ensureARecord(zoneId, `mail.${domain}`, ip));
  await run('mx',            () => ensureMX(zoneId, domain));
  await run('spf',           () => ensureSPF(zoneId, domain, ip));
  await run('dkim',          () => ensureDKIM(zoneId, domain, selector, dkimPublicKey));
  await run('dmarc',         () => ensureDMARC(zoneId, domain));

  if (controllerIp) {
    await run('a_unsubscribe', () => ensureARecord(zoneId, `unsubscribe.${domain}`, controllerIp));
    await run('a_click',       () => ensureARecord(zoneId, `click.${domain}`,       controllerIp));
  } else {
    phases.a_unsubscribe = { status: 'SKIPPED', message: 'CONTROLLER_PUBLIC_IP not set — add A record manually' };
    phases.a_click       = { status: 'SKIPPED', message: 'CONTROLLER_PUBLIC_IP not set — add A record manually' };
  }

  return { ok: !hasFailed && !hasPending, phases };
}
