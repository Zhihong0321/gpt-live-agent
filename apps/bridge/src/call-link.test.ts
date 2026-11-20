import { expect, test } from 'vitest';
import { createCallLinkToken, readCallLinkToken } from './call-link.js';

const token = 'x'.repeat(40);

test('a link made with the control token reads back the lead', () => {
  const link = createCallLinkToken(token, { phone: '+60127299201', name: 'Mr. Gan Lai Soon', company: '恒希集团', source: 'gmaps' });
  expect(readCallLinkToken(token, link)).toMatchObject({ phone: '+60127299201', name: 'Mr. Gan Lai Soon', company: '恒希集团', source: 'gmaps' });
});
test('a forged, changed or expired link is refused', () => {
  const link = createCallLinkToken(token, { phone: '+60127299201', source: 'gmaps' });
  expect(readCallLinkToken('y'.repeat(40), link)).toBeUndefined();
  const [body, mac] = link.split('.');
  const other = Buffer.from(Buffer.from(body!, 'base64url').toString().replace('60127299201', '60111111111')).toString('base64url');
  expect(readCallLinkToken(token, `${other}.${mac}`)).toBeUndefined();
  expect(readCallLinkToken(token, link, Date.now() + 8 * 86400_000)).toBeUndefined();
  expect(readCallLinkToken(token, 'garbage')).toBeUndefined();
});
