import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const check = process.argv.includes('--check');
const mappings = [
  ['mcp-server-create', 'create'],
  ['mcp-server-add', 'add'],
  ['mcp-server-deploy', 'deploy'],
];

let drift = false;
for (const [canonicalName, pluginName] of mappings) {
  const canonical = await readFile(new URL(`skills/${canonicalName}/SKILL.md`, root), 'utf8');
  const expected = canonical.replace(`name: ${canonicalName}`, `name: ${pluginName}`);
  const target = new URL(`plugin/skills/${pluginName}/SKILL.md`, root);

  if (check) {
    const actual = await readFile(target, 'utf8').catch(() => '');
    if (actual !== expected) {
      console.error(`Plugin skill is stale: plugin/skills/${pluginName}/SKILL.md`);
      drift = true;
    }
  } else {
    await mkdir(dirname(fileURLToPath(target)), { recursive: true });
    await writeFile(target, expected);
  }
}

if (drift) process.exitCode = 1;
else console.log(check ? 'Plugin skills match canonical skills' : 'Plugin skills synchronized');
