import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '@voxdock/config';
// @ts-expect-error plain ESM script without type declarations
import { readTenants, tenantConfig } from '../../../scripts/tenants.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'tenants-'));
const mainConfig = {
  schema_version: 1,
  service: { listen: '127.0.0.1:18100', data_dir: '/data' },
  security: { control_token_file: '/data/control.token' },
  console: { enabled: true, public_origin: 'https://example.test' },
  calling: { enabled: false, max_call_seconds: 300, daily_live_seconds: 3600 },
  visitor_calls: { max_per_number_per_day: 2 },
  channels: { telegram: { enabled: false }, whatsapp: { enabled: false, endpoint: 'http://127.0.0.1:18081', media_token_file: '/data/wacalls-media' } },
  targets: [],
  live: { api_key_file: '/data/elevenlabs-api-key', elevenlabs: { agent_ids: { telegram: 'agent_t', whatsapp: 'agent_w' } }, language: 'en', instructions: 'x' },
  backend: { id: 'test', base_url: 'http://127.0.0.1:18082', request_token_file: '/data/r', event_signing_key_file: '/data/s' },
  records: { transcript_retention_days: 0 },
  timezone: 'Asia/Kuala_Lumpur',
};

describe('readTenants', () => {
  it('returns nothing and logs nothing when the file does not exist', () => {
    const logs: string[] = [];
    expect(readTenants(join(dir(), 'missing.json'), (m: string) => logs.push(m))).toEqual([]);
    expect(logs).toEqual([]);
  });
  it('logs a broken file instead of throwing', () => {
    const file = join(dir(), 't.json'); writeFileSync(file, '{oops');
    const logs: string[] = [];
    expect(readTenants(file, (m: string) => logs.push(m))).toEqual([]);
    expect(logs).toHaveLength(1);
  });
  it('keeps good entries, skips bad, reserved and repeated ones, and labels a bad agent id', () => {
    const file = join(dir(), 't.json');
    writeFileSync(file, JSON.stringify([{ id: 'alice', agent_id_whatsapp: 'agent_a' }, { id: 'main' }, { id: 'Bad Id' }, null, { id: 'alice' }, { id: 'bob', agent_id_whatsapp: 'not valid!' }]));
    const logs: string[] = [];
    expect(readTenants(file, (m: string) => logs.push(m))).toEqual([{ id: 'alice', agent_id_whatsapp: 'agent_a' }, { id: 'bob' }]);
    expect(logs).toHaveLength(5);
  });
});

describe('tenantConfig', () => {
  it('changes only listen, data folder, control token, WhatsApp session and agent id', () => {
    const config = tenantConfig(mainConfig, { id: 'alice', agent_id_whatsapp: 'agent_a' }, { listen: '127.0.0.1:18101', dataDir: '/data/users/alice', controlTokenFile: '/data/users/alice/control.token' });
    expect(config).toEqual({
      ...mainConfig,
      service: { listen: '127.0.0.1:18101', data_dir: '/data/users/alice' },
      security: { control_token_file: '/data/users/alice/control.token' },
      channels: { ...mainConfig.channels, whatsapp: { ...mainConfig.channels.whatsapp, account_ref: 'wa-alice' } },
      live: { ...mainConfig.live, elevenlabs: { agent_ids: { telegram: 'agent_t', whatsapp: 'agent_a' } } },
    });
    expect(mainConfig.service.listen).toBe('127.0.0.1:18100');
    expect(() => parseConfig(config)).not.toThrow();
  });
  it('keeps the default agent when the user has none', () => {
    const config = tenantConfig(mainConfig, { id: 'bob' }, { listen: 'l', dataDir: 'd', controlTokenFile: 'c' });
    expect(config.live.elevenlabs.agent_ids.whatsapp).toBe('agent_w');
  });
});
