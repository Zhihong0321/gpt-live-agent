import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** A lead the operator wants called. Signed so that only links made with the control token can place a call. */
export interface CallLead { phone: string; name?: string; company?: string; source: 'gmaps'; expires: number; id: string }

const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64url');
const key = (controlToken: string) => createHmac('sha256', controlToken).update('voxdock-call-link-v1').digest();
const sign = (controlToken: string, body: string) => createHmac('sha256', key(controlToken)).update(body).digest();

export function createCallLinkToken(controlToken: string, lead: Omit<CallLead, 'id' | 'expires'> & { days?: number }, now = Date.now()): string {
  const payload: CallLead = { phone: lead.phone, ...(lead.name ? { name: lead.name } : {}), ...(lead.company ? { company: lead.company } : {}),
    source: lead.source, expires: Math.floor(now / 1000) + Math.round((lead.days ?? 7) * 86400), id: randomBytes(9).toString('hex') };
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(sign(controlToken, body))}`;
}

/** Returns the lead, or undefined for a forged, damaged or expired link. Never throws. */
export function readCallLinkToken(controlToken: string, token: string, now = Date.now()): CallLead | undefined {
  try {
    const [body, mac, extra] = token.split('.');
    if (!body || !mac || extra !== undefined || token.length > 2000) return undefined;
    const given = Buffer.from(mac, 'base64url'); const expected = sign(controlToken, body);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    const lead = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<CallLead>;
    if (typeof lead.phone !== 'string' || typeof lead.id !== 'string' || !/^[0-9a-f]{18}$/.test(lead.id) || typeof lead.expires !== 'number' || lead.source !== 'gmaps') return undefined;
    if (lead.expires * 1000 < now) return undefined;
    return { phone: lead.phone, source: lead.source, expires: lead.expires, id: lead.id,
      ...(typeof lead.name === 'string' ? { name: lead.name } : {}), ...(typeof lead.company === 'string' ? { company: lead.company } : {}) };
  } catch { return undefined; }
}

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function callLinkPage(title: string, lines: string[], button?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escape(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;background:#f6f7f9;color:#14171a}
.card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 12px}
p{margin:6px 0}button{margin-top:18px;width:100%;padding:14px;font-size:17px;border:0;border-radius:10px;background:#0b6bcb;color:#fff;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#111418;color:#e8eaed}.card{background:#1b1f24}}</style></head>
<body><div class="card"><h1>${escape(title)}</h1>${lines.map(l => `<p>${escape(l)}</p>`).join('')}
${button ? `<form method="post"><button type="submit">${escape(button)}</button></form>` : ''}</div></body></html>`;
}
