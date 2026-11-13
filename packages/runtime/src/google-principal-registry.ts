import { constants } from 'node:fs';
import { access, lstat, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  type GooglePrincipalBinding,
  type GooglePrincipalPin,
  googlePrincipalBindingSchema,
  googlePrincipalRegistrySchema,
} from '@dxheroes/mcp-kit';
import { HttpFailure } from './auth.js';
import type { ConnectorEndpoint } from './endpoints.js';

/** Include effective ACL permissions; mode bits alone do not describe runtime write access. */
async function requireReadOnly(path: string): Promise<void> {
  try {
    await access(path, constants.W_OK);
  } catch (error) {
    if (['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
  throw new Error('Writable registry path');
}

/** Copy validated startup configuration. A removed registry pair must never unbind a route. */
export function bindGooglePrincipalRoutes(
  input: GooglePrincipalBinding | undefined,
  routes: ReadonlyMap<string, ConnectorEndpoint>,
): Readonly<GooglePrincipalBinding> | undefined {
  if (input === undefined) return undefined;
  try {
    const binding = googlePrincipalBindingSchema.parse(input);
    for (const [path, purpose] of [
      [binding.readerPath, 'gmail_readonly'],
      [binding.senderPath, 'gmail_send'],
    ]) {
      const route = routes.get(path!);
      if (route?.auth !== 'oauth' || route.googleMailPurpose !== purpose) throw new Error();
    }
    return Object.freeze(binding);
  } catch {
    throw new Error('Invalid Google principal configuration');
  }
}

/** Fresh atomic-file snapshot on EVERY bound request. Never cache or enroll incoming claims. */
export async function loadGooglePrincipalPin(
  binding: Readonly<GooglePrincipalBinding> | undefined,
  path: string,
  localTestMode = false,
): Promise<GooglePrincipalPin | undefined> {
  if (!binding || (path !== binding.readerPath && path !== binding.senderPath)) return undefined;
  try {
    // Production runs as non-root with a root-owned, read-only-mounted registry directory.
    // Every parent is protected against replacement; symlink traversal is never accepted.
    if (!localTestMode && (!process.getuid || process.getuid() === 0)) throw new Error();
    if (resolve(binding.registryFile) !== binding.registryFile) throw new Error();
    let parent = dirname(binding.registryFile);
    for (;;) {
      const stat = await lstat(parent);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (!localTestMode && (stat.uid !== 0 || (stat.mode & 0o022) !== 0))
      )
        throw new Error();
      if (!localTestMode) await requireReadOnly(parent);
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    // The operator owns the parent directory and mounts it read-only to the runtime.
    // O_NONBLOCK also refuses an accidental FIFO without waiting for a writer.
    const file = await open(
      binding.registryFile,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      const pathStat = await lstat(binding.registryFile);
      if (
        !stat.isFile() ||
        pathStat.isSymbolicLink() ||
        pathStat.dev !== stat.dev ||
        pathStat.ino !== stat.ino ||
        (stat.mode & 0o022) !== 0 ||
        stat.size > 65536 ||
        (!localTestMode && stat.uid !== 0)
      )
        throw new Error();
      if (!localTestMode) await requireReadOnly(binding.registryFile);
      const buffer = Buffer.alloc(65537);
      let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await file.read(buffer, count, buffer.length - count, null);
        if (bytesRead === 0) break;
        count += bytesRead;
      }
      if (count > 65536) throw new Error();
      bytes = buffer.subarray(0, count);
    } finally {
      await file.close();
    }
    const registry = googlePrincipalRegistrySchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    const pair = registry.pairs.find((candidate) => candidate.id === binding.pairId);
    if (
      !pair ||
      new URL(pair.reader.audience).pathname !== binding.readerPath ||
      new URL(pair.sender.audience).pathname !== binding.senderPath
    )
      throw new Error();
    return path === binding.readerPath ? pair.reader : pair.sender;
  } catch {
    throw new HttpFailure(403, 'google_principal_unavailable');
  }
}
