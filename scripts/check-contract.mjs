import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const schema = await readFile(
  new URL('../packages/catalog/schema/catalog-discovery.schema.json', import.meta.url),
);
if (
  createHash('sha256').update(schema).digest('hex') !==
  '9db5d7919bb820dcc57794f2d92328ca627c6a2768fa3279ba7f603f11e9b34c'
)
  throw new Error('Frozen discovery schema drift');
console.log('Frozen discovery v1 schema verified');
