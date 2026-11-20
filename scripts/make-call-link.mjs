// Prints a one-time call link for a lead. Run on the server (it holds the control token):
//   node --import tsx scripts/make-call-link.mjs --phone +60127299201 --name "Mr. Gan" --company "Lead Co" [--days 7]
// Opening the link shows a confirm page; the call is placed only by its "Call now" button.
import { readFileSync } from 'node:fs';
import { createCallLinkToken } from '../apps/bridge/src/call-link.ts';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const data = process.env.VOXDOCK_DATA_DIR || '/data';
const config = JSON.parse(readFileSync(`${data}/railway.config.json`, 'utf8'));
const token = readFileSync(config.security.control_token_file, 'utf8').trim();
const phone = flag('--phone') ?? '';
if (!/^\+[1-9][0-9]{6,14}$/.test(phone)) { console.error('--phone must look like +60123456789'); process.exit(2); }
const origin = (config.console?.public_origin || process.env.VOXDOCK_PUBLIC_ORIGIN || '').replace(/\/$/, '');
const link = createCallLinkToken(token, { phone, name: flag('--name'), company: flag('--company'), source: 'gmaps', days: Number(flag('--days') ?? 7) });
console.log(`${origin}/call-link/${link}`);
