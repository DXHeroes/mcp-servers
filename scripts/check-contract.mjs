import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const schema = await readFile(
  new URL('../packages/catalog/schema/catalog-discovery.schema.json', import.meta.url),
);
if (
  createHash('sha256').update(schema).digest('hex') !==
  '170252b8bc65bf2fe4dd499c7e132fae0db23a51c3ad3b815c19c2c59ccda71f'
)
  throw new Error('Frozen discovery schema drift');
console.log('Frozen discovery v1 schema verified');
