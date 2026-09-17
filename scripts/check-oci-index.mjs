import { readFile } from 'node:fs/promises';
import { checkIndex } from '../templates/typescript-crm/scripts/release-evidence.mjs';

checkIndex(JSON.parse(await readFile(process.argv[2], 'utf8')));
console.log('OCI index contains amd64 and arm64 images with per-platform attestations');
