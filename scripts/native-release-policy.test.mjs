import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkNativeReleaseWorkflow } from './native-release-policy.mjs';

for (const file of [
  '.github/workflows/release.yml',
  'templates/typescript-crm/.github/workflows/image.yml',
]) {
  const workflow = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  test(`${file} validates the native release path`, () => {
    assert.deepEqual(checkNativeReleaseWorkflow(workflow), []);
  });
  for (const [name, mutate] of [
    [
      'missing arm64 build',
      (s) => s.replace('          - arch: arm64\n            runner: ubuntu-24.04-arm\n', ''),
    ],
    ['arm64 routed to x64', (s) => s.replace('runner: ubuntu-24.04-arm', 'runner: ubuntu-24.04')],
    [
      'multi-platform emulation',
      (s) =>
        s.replace(
          `platforms: linux/\${{ matrix.platform.arch }}`,
          'platforms: linux/amd64,linux/arm64',
        ),
    ],
    [
      'tagged intermediate publication',
      (s) => s.replace('push-by-digest=true', 'push-by-digest=false'),
    ],
    ['missing provenance', (s) => s.replace('type=provenance,mode=max', '')],
    ['missing SBOM', (s) => s.replace('type=sbom,generator=', 'type=other,generator=')],
    ['missing merge dependency', (s) => s.replace('needs: build', 'needs: validate')],
    ['missing merge sources', (s) => s.replace(` "\${sources[@]}"`, '')],
    [
      'missing receipt validation',
      (s) => s.replace('release-evidence.mjs sources', 'release-evidence.mjs record'),
    ],
    [
      'missing final index validation',
      (s) =>
        s
          .replace('check-oci-index.mjs', 'unchecked.mjs')
          .replace('release-evidence.mjs index', 'release-evidence.mjs record'),
    ],
    ['missing arm64 scan', (s) => s.replace('--platform linux/arm64', '--platform linux/amd64')],
    [
      'signing platform digest',
      (s) =>
        s.replace(
          /(run: cosign sign .*)steps\.merge\.outputs\.digest/,
          '$1steps.build.outputs.digest',
        ),
    ],
    ['OIDC in build job', (s) => s.replace('  build:\n', '  build:\n    id-token: write\n')],
    ['missing signature', (s) => s.replace('run: cosign sign', 'run: echo')],
    [
      'missing zero-findings gate',
      (s) =>
        s
          .replace('check-trivy-reports.mjs', 'unchecked.mjs')
          .replace('Vulnerabilities?.length', 'Ignored?.length'),
    ],
  ]) {
    test(`${file} rejects ${name}`, () => {
      assert.ok(checkNativeReleaseWorkflow(mutate(workflow)).length > 0);
    });
  }
}
