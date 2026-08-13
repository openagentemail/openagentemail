/**
 * ADR #26 PR 6：设备登记表与吊销协议。
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-devices-'));

const { afterEach, beforeEach, describe, expect, test } = await import('bun:test');
const { config } = await import('../src/lib/config.ts');
const {
  DEVICE_REGISTRY_FILE,
  DeviceNotFoundError,
  DeviceRegistryCorruptError,
  DeviceRegistryPersistError,
  DeviceRevokeTransientError,
  deviceRegistryPathForTests,
  inspectDeviceRegistry,
  listPairedDevices,
  reconcilePendingRevokes,
  registerPairedDevice,
  resetDeviceRegistryForTests,
  revokePairedDevice,
  setDeviceRegistryPersistHookForTests,
} = await import('../src/lib/notification-devices.ts');

const topics = { userAlerts: 'user-alerts-abc', userLow: 'user-low-abc' };

function seedInput(name?: string) {
  return {
    displayName: name,
    ntfyUsername: `phone-${Math.random().toString(36).slice(2, 10)}`,
    topics,
  };
}

beforeEach(() => {
  resetDeviceRegistryForTests();
});

afterEach(() => {
  resetDeviceRegistryForTests();
});

describe('notification device registry', () => {
  test('register writes 0600 JSON with no password or token keys', async () => {
    const record = await registerPairedDevice(seedInput('Kitchen phone'));
    expect(record.displayName).toBe('Kitchen phone');
    expect(record.revokeStatus).toBe('active');
    expect(record.revokedAt).toBeNull();
    const path = deviceRegistryPathForTests();
    const text = readFileSync(path, 'utf8');
    expect(text).not.toMatch(/"password"\s*:/);
    expect(text).not.toMatch(/"token"\s*:/);
    expect(text).toContain('Kitchen phone');
    const { statSync } = await import('node:fs');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('old clients without displayName get the default Phone name', async () => {
    const record = await registerPairedDevice(seedInput());
    expect(record.displayName).toBe('Phone');
  });

  test('list hides revoked devices and shows pending_revoke', async () => {
    const active = await registerPairedDevice(seedInput('A'));
    const pending = await registerPairedDevice(seedInput('B'));
    await revokePairedDevice(pending.id, async () => 'deleted');
    const listed = await listPairedDevices();
    expect(listed.map((row) => row.id).sort()).toEqual([active.id].sort());
    expect(listed[0]?.topicLabels.userAlerts).toBe('User alerts');
    expect(listed[0]?.topicLabels.userLow).toBe('User low');
  });

  test('step 1 persist failure never calls ntfy delete', async () => {
    const device = await registerPairedDevice(seedInput('Keep'));
    let ntfy = 0;
    setDeviceRegistryPersistHookForTests(() => {
      throw new Error('ENOSPC');
    });
    await expect(
      revokePairedDevice(device.id, async () => {
        ntfy += 1;
        return 'deleted';
      }),
    ).rejects.toBeInstanceOf(DeviceRegistryPersistError);
    expect(ntfy).toBe(0);
    setDeviceRegistryPersistHookForTests(null);
    const listed = await listPairedDevices();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.revokeStatus).toBe('active');
  });

  test('readonly volume on pending persist does not reach ntfy', async () => {
    const device = await registerPairedDevice(seedInput('RO'));
    setDeviceRegistryPersistHookForTests(() => {
      const err = new Error('EROFS: read-only file system');
      (err as NodeJS.ErrnoException).code = 'EROFS';
      throw err;
    });
    let ntfy = 0;
    await expect(
      revokePairedDevice(device.id, async () => {
        ntfy += 1;
        return 'deleted';
      }),
    ).rejects.toBeInstanceOf(DeviceRegistryPersistError);
    expect(ntfy).toBe(0);
  });

  test('ntfy 404 / not_found is idempotent success and converges to revoked', async () => {
    const device = await registerPairedDevice(seedInput('Gone'));
    const result = await revokePairedDevice(device.id, async () => 'not_found');
    expect(result).toBe('revoked');
    const hidden = await listPairedDevices();
    expect(hidden).toHaveLength(0);
    const all = await listPairedDevices({ includeRevoked: true });
    expect(all[0]?.revokeStatus).toBe('revoked');
    expect(all[0]?.revokedAt).toBeTruthy();
  });

  test('repeat DELETE on already revoked is already_revoked and does not call ntfy', async () => {
    const device = await registerPairedDevice(seedInput('Once'));
    await revokePairedDevice(device.id, async () => 'deleted');
    let ntfy = 0;
    const again = await revokePairedDevice(device.id, async () => {
      ntfy += 1;
      return 'deleted';
    });
    expect(again).toBe('already_revoked');
    expect(ntfy).toBe(0);
  });

  test('step 3 persist failure leaves pending_revoke; retry/startup not_found converges', async () => {
    const device = await registerPairedDevice(seedInput('Stuck'));
    let persistCalls = 0;
    setDeviceRegistryPersistHookForTests(() => {
      persistCalls += 1;
      // 第一次 persist = pending_revoke（步骤 1）；第二次 = revoked（步骤 3）失败。
      if (persistCalls === 2) throw new Error('ENOSPC');
    });
    let ntfy = 0;
    await expect(
      revokePairedDevice(device.id, async () => {
        ntfy += 1;
        return 'deleted';
      }),
    ).rejects.toBeInstanceOf(DeviceRegistryPersistError);
    expect(ntfy).toBe(1);
    setDeviceRegistryPersistHookForTests(null);

    const mid = await listPairedDevices();
    expect(mid).toHaveLength(1);
    expect(mid[0]?.revokeStatus).toBe('pending_revoke');

    let startupNtfy = 0;
    await reconcilePendingRevokes(async () => {
      startupNtfy += 1;
      return 'not_found';
    });
    expect(startupNtfy).toBe(1);
    const done = await listPairedDevices({ includeRevoked: true });
    expect(done[0]?.revokeStatus).toBe('revoked');
  });

  test('transient ntfy failure keeps pending_revoke for retry', async () => {
    const device = await registerPairedDevice(seedInput('Net'));
    await expect(
      revokePairedDevice(device.id, async () => 'transient'),
    ).rejects.toBeInstanceOf(DeviceRevokeTransientError);
    const listed = await listPairedDevices();
    expect(listed[0]?.revokeStatus).toBe('pending_revoke');
  });

  test('startup inspect + reconcile scans pending_revoke', async () => {
    const device = await registerPairedDevice(seedInput('Boot'));
    await expect(revokePairedDevice(device.id, async () => 'transient')).rejects.toBeInstanceOf(
      DeviceRevokeTransientError,
    );
    await inspectDeviceRegistry();
    await reconcilePendingRevokes(async () => 'not_found');
    const listed = await listPairedDevices({ includeRevoked: true });
    expect(listed[0]?.revokeStatus).toBe('revoked');
  });

  test('corrupt file fail-closes instead of wiping the registry', async () => {
    await registerPairedDevice(seedInput('Real'));
    writeFileSync(deviceRegistryPathForTests(), '{not-json', { mode: 0o600 });
    await expect(listPairedDevices()).rejects.toBeInstanceOf(DeviceRegistryCorruptError);
    await expect(registerPairedDevice(seedInput('Other'))).rejects.toBeInstanceOf(
      DeviceRegistryCorruptError,
    );
    const text = readFileSync(deviceRegistryPathForTests(), 'utf8');
    expect(text).toBe('{not-json');
  });

  test('missing device is not_found', async () => {
    await expect(revokePairedDevice('dev_missing', async () => 'deleted')).rejects.toBeInstanceOf(
      DeviceNotFoundError,
    );
  });

  test('crash tmp next to an intact store is discarded on inspect', async () => {
    await registerPairedDevice(seedInput('Keep'));
    writeFileSync(`${deviceRegistryPathForTests()}.tmp`, '{"schemaVersion":1,"devices":[]}\n', {
      mode: 0o600,
    });
    await inspectDeviceRegistry();
    const listed = await listPairedDevices();
    expect(listed).toHaveLength(1);
  });

  test('data dir is 0700 after the first write', async () => {
    mkdirSync(config.dataDir, { recursive: true });
    await registerPairedDevice(seedInput('Mode'));
    const { statSync } = await import('node:fs');
    expect(statSync(config.dataDir).mode & 0o777).toBe(0o700);
  });
});
