import { open, readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseDocument } from 'yaml';

export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  endpoint: { transport: 'streamable-http'; url: string };
  auth: {
    type: string;
    credentialModes: string[];
    defaultCredentialMode?: string;
    credentialDelivery?: string;
    oauthDefaults?: Record<string, unknown>;
    [key: string]: unknown;
  };
  docsUrl?: string;
}
export interface Manifest {
  schemaVersion: 1;
  servers: CatalogEntry[];
}
const schema = JSON.parse(
  await readFile(new URL('../schema/catalog-discovery.schema.json', import.meta.url), 'utf8'),
);
const validate = new Ajv2020({ strict: false, allErrors: false }).compile<Manifest>(schema);
function validUrl(value: string): void {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) =>
      /(?:token|secret|password|credential|authorization|api[-_]?key|^key$)/i.test(key),
    ) ||
    /[\s\\]/.test(value) ||
    [...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    throw new Error('invalid_manifest');
}
function rejectBlankStrings(value: unknown): void {
  if (typeof value === 'string' && !value.trim()) throw new Error('invalid_manifest');
  if (value && typeof value === 'object')
    for (const item of Object.values(value)) rejectBlankStrings(item);
}
export function parseManifest(source: string): Manifest {
  if (Buffer.byteLength(source) > MAX_CATALOG_BYTES) throw new Error('manifest_too_large');
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error('invalid_manifest');
  const data: unknown = document.toJS({ maxAliasCount: 0 });
  if (!validate(data)) throw new Error('invalid_manifest');
  rejectBlankStrings(data);
  const ids = new Set<string>();
  for (const entry of data.servers) {
    if (ids.has(entry.id)) throw new Error('invalid_manifest');
    ids.add(entry.id);
    validUrl(entry.endpoint.url);
    if (entry.docsUrl) validUrl(entry.docsUrl);
    if (entry.auth.oauthDefaults) {
      const params = entry.auth.oauthDefaults.authorizeParams;
      if (
        params &&
        typeof params === 'object' &&
        'audience' in params &&
        typeof params.audience === 'string'
      )
        validUrl(params.audience);
      for (const key of [
        'authorizationServerUrl',
        'authorizationEndpoint',
        'tokenEndpoint',
        'resource',
      ]) {
        const value = entry.auth.oauthDefaults[key];
        if (typeof value === 'string') validUrl(value);
      }
    }
  }
  return data;
}
export class ManifestStore {
  private snapshot?: Manifest;
  private healthy = false;
  constructor(private path: string) {}
  async reload(): Promise<void> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(this.path, 'r');
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) throw new Error();
      // Read at most limit+1, even if a file grows after stat.
      const bytes = Buffer.alloc(MAX_CATALOG_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_CATALOG_BYTES) throw new Error();
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
      this.snapshot = parseManifest(source);
      this.healthy = true;
    } catch {
      this.healthy = false;
    } finally {
      await file?.close();
    }
  }
  get ready(): boolean {
    return this.healthy;
  }
  get current(): Manifest | undefined {
    return this.healthy ? this.snapshot : undefined;
  }
}
