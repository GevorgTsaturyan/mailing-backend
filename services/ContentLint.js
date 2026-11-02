// ─── ContentLint — advisory deliverability checks for templates ──────────────
// Pure. Never blocks saving or sending; returns human-readable warnings shown
// in the template editor. Thresholds are deliberately conservative.

export const MAX_LINKS  = 5;
export const MAX_IMAGES = 3;

// Public URL shorteners — shared reputation, heavily abused, a strong spam signal.
const SHORTENERS = [
  'bit.ly', 'bitly.com', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
  'cutt.ly', 'rebrand.ly', 'shorturl.at', 'rb.gy', 't.ly', 'tiny.cc', 'bl.ink', 's.id',
  'v.gd', 'lnkd.in', 'shorte.st', 'adf.ly', 'clck.ru', 'qr.ae',
];

const PHISHY_SUBJECT = /\b(verify your account|account (is )?(ready|suspended|locked|on hold)|activate (your )?account|balance (has been )?updated|confirm your (identity|payment)|urgent action|password expir)/i;

function hosts(text) {
  const out = [];
  const re = /https?:\/\/([^\s"'<>/?#]+)/gi;
  let m;
  while ((m = re.exec(text))) out.push(m[1].toLowerCase().replace(/^www\./, '').replace(/:\d+$/, ''));
  return out;
}

export function lintTemplate({ subject = '', html = '', txt = '' } = {}) {
  const warnings = [];
  const body = `${html || ''}\n${txt || ''}`;

  const links = (String(html || '').match(/<a\s[^>]*href\s*=/gi) || []).length
    + (String(html || '').match(/\{\{button:[^}]+\}\}/gi) || []).length;
  if (links > MAX_LINKS) warnings.push(`${links} links in the HTML — keep it to ${MAX_LINKS} or fewer.`);

  const images = (String(html || '').match(/<img\b/gi) || []).length;
  if (images > MAX_IMAGES) warnings.push(`${images} images — keep it to ${MAX_IMAGES} or fewer, and keep a good text-to-image ratio.`);

  const short = [...new Set(hosts(body).filter((h) => SHORTENERS.includes(h)))];
  if (short.length) warnings.push(`URL shortener used (${short.join(', ')}) — link to the real destination instead.`);

  const ipLinks = hosts(body).filter((h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h));
  if (ipLinks.length) warnings.push('Link points to a bare IP address — use a domain name.');

  if (PHISHY_SUBJECT.test(subject)) warnings.push('Subject reads like an account/security notice — mailbox providers treat this as phishing.');

  if (html && !txt) warnings.push('No plain-text version — one is auto-generated, but a hand-written one is better.');

  return warnings;
}
