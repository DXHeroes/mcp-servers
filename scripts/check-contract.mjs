import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const schema = await readFile(
  new URL('../packages/catalog/schema/catalog-discovery.schema.json', import.meta.url),
);
if (
  createHash('sha256').update(schema).digest('hex') !==
  '06b076aecf5b347ea0ab9503f351afcc1a63e07a762d99bda0c409dbce3c73ec'
)
  throw new Error('Frozen discovery schema drift');
console.log('Frozen discovery v1 schema verified');
