// Public production check. Runs from any computer; only plain GET requests, no login, no calls:
//   node scripts/prod-check-public.mjs https://<domain> [--save before.json] [--compare before.json]
// --save records today's answers before a deploy; --compare checks the same answers after it.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const base = (args.find(a => a.startsWith('http')) ?? '').replace(/\/$/, '');
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!base) { console.error('Usage: node scripts/prod-check-public.mjs https://<domain> [--save file] [--compare file]'); process.exit(2); }

const probes = [
  { name: 'healthz', path: '/healthz' },
  { name: 'console page', path: '/console/' },
  { name: 'console API without login', path: '/admin/v1/session' },
  { name: 'call scripts page', path: '/scripts' },
  { name: 'invalid call link', path: '/call-link/not-a-real-token' },
  { name: 'unknown user page', path: '/u/no-such-user-check' },
  { name: 'select main', path: '/u/main' },
];
const answers = {};
for (const probe of probes) {
  try {
    const response = await fetch(base + probe.path, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    answers[probe.name] = { status: response.status, type: (response.headers.get('content-type') ?? '').split(';')[0], location: response.headers.get('location') ?? undefined, size: text.length };
  } catch (error) { answers[probe.name] = { status: 0, error: error?.cause?.code ?? error?.message ?? String(error) }; }
  console.log(`${probe.name.padEnd(28)} ${JSON.stringify(answers[probe.name])}`);
}
if (flag('--save')) { writeFileSync(flag('--save'), JSON.stringify(answers, null, 2)); console.log(`saved to ${flag('--save')}`); }
if (flag('--compare')) {
  const before = JSON.parse(readFileSync(flag('--compare'), 'utf8'));
  // These two are new routes: before the deploy the bridge answered them, after it the router does.
  const expectedNew = { 'unknown user page': 404, 'select main': 302 };
  let problems = 0;
  for (const probe of probes) {
    const now = answers[probe.name]; const was = before[probe.name];
    const want = expectedNew[probe.name] ?? was?.status;
    const ok = now?.status === want && (expectedNew[probe.name] || now?.type === was?.type);
    if (!ok) problems++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${probe.name}: before ${was?.status} ${was?.type ?? ''} -> now ${now?.status} ${now?.type ?? ''}${expectedNew[probe.name] ? ` (expected ${want})` : ''}`);
  }
  console.log(`\n${probes.length - problems} passed, ${problems} failed`);
}
