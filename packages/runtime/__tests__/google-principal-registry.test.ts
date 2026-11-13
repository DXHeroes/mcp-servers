import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadGooglePrincipalPin } from '../src/google-principal-registry.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    open: vi.fn(actual.open),
    access: vi.fn(actual.access),
  };
});
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'registry-protection-'));
  const registryFile = join(directory, 'pins.json');
  await fs.writeFile(
    registryFile,
    await fs
      .readFile(
        new URL(
          '../../../connectors/google/__tests__/fixtures/gateway-principal-v2.json',
          import.meta.url,
        ),
        'utf8',
      )
      .then((text) => JSON.stringify(JSON.parse(text).registry)),
    { mode: 0o600 },
  );
  return { registryFile, pairId: 'mail', readerPath: '/gmail-read/mcp', senderPath: '/gmail/mcp' };
}
it('refuses a file/path descriptor identity race before parsing or selecting pins', async () => {
  const binding = await fixture();
  expect(await loadGooglePrincipalPin(binding, binding.senderPath, true)).toMatchObject({
    credentialId: 'row-sender',
  });
  const realLstat = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
    .lstat;
  const lstat = vi.spyOn(fs, 'lstat');
  lstat.mockImplementation((async (path: Parameters<typeof fs.lstat>[0]) => {
    const stat = await realLstat(path);
    if (path === binding.registryFile) stat.ino += 1;
    return stat;
  }) as typeof fs.lstat);
  await expect(loadGooglePrincipalPin(binding, binding.senderPath, true)).rejects.toThrow(
    'google_principal_unavailable',
  );
});
it('refuses a symlink parent in loopback fixtures as well as production', async () => {
  const binding = await fixture();
  const directory = await fs.mkdtemp(join(tmpdir(), 'registry-parent-'));
  await fs.symlink(join(binding.registryFile, '..'), join(directory, 'alias'));
  const indirect = { ...binding, registryFile: join(directory, 'alias', 'pins.json') };
  await expect(loadGooglePrincipalPin(indirect, indirect.senderPath, true)).rejects.toThrow(
    'google_principal_unavailable',
  );
});
it('root runtime cannot consume production registry even with root-owned pins', async () => {
  const binding = await fixture();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  await expect(loadGooglePrincipalPin(binding, binding.senderPath)).rejects.toThrow(
    'google_principal_unavailable',
  );
});
it('unbound requests never touch the registry', async () => {
  const binding = await fixture();
  const opening = vi.spyOn(fs, 'open');
  opening.mockClear();
  expect(await loadGooglePrincipalPin(binding, '/tasks/mcp')).toBeUndefined();
  expect(opening).not.toHaveBeenCalled();
});

it('production rejects runtime-owned file even after protected parents pass', async () => {
  const binding = await fixture();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.spyOn(fs, 'lstat').mockImplementation((async (path: Parameters<typeof fs.lstat>[0]) => {
    const stat = await actual.lstat(path);
    if (stat.isDirectory()) {
      stat.uid = 0;
      stat.mode &= ~0o022;
    }
    return stat;
  }) as typeof fs.lstat);
  vi.spyOn(fs, 'access').mockRejectedValue(Object.assign(new Error('Denied'), { code: 'EACCES' }));
  const opening = vi.spyOn(fs, 'open');
  opening.mockClear();
  await expect(loadGooglePrincipalPin(binding, binding.senderPath)).rejects.toThrow(
    'google_principal_unavailable',
  );
  expect(opening).toHaveBeenCalledTimes(1);
});
it('production refuses effective writable parent even when owner and mode appear protected', async () => {
  const binding = await fixture();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.spyOn(fs, 'lstat').mockImplementation((async (path: Parameters<typeof fs.lstat>[0]) => {
    const stat = await actual.lstat(path);
    stat.uid = 0;
    stat.mode &= ~0o022;
    return stat;
  }) as typeof fs.lstat);
  vi.spyOn(fs, 'access').mockResolvedValue(undefined);
  const opening = vi.spyOn(fs, 'open');
  opening.mockClear();
  await expect(loadGooglePrincipalPin(binding, binding.senderPath)).rejects.toThrow(
    'google_principal_unavailable',
  );
  expect(opening).not.toHaveBeenCalled();
});
