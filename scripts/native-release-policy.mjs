// This bounded policy checks our two release workflows; actionlint validates YAML and expressions.
export function checkNativeReleaseWorkflow(workflow) {
  const failures = [];
  const build = workflow.match(/^ {2}build:\n[\s\S]*?(?=^ {2}\S|$(?![\s\S]))/m)?.[0] ?? '';
  const buildStep = build.match(/^ {6}- id: build\n[\s\S]*?(?=^ {6}- |$(?![\s\S]))/m)?.[0] ?? '';
  const publish =
    workflow.match(/^ {2}(?:publish|release):\n[\s\S]*?(?=^ {2}\S|$(?![\s\S]))/m)?.[0] ?? '';
  const requireIn = (section, text, reason) => {
    if (!section.includes(text)) failures.push(reason);
  };
  if (/setup-qemu|binfmt/.test(workflow)) failures.push('release must not depend on emulation');
  for (const [arch, runner] of [
    ['amd64', 'ubuntu-24.04'],
    ['arm64', 'ubuntu-24.04-arm'],
  ]) {
    if (!new RegExp(`- arch: ${arch}\\n\\s+runner: ${runner}\\n`).test(build))
      failures.push(`native ${arch} runner is missing or incorrect`);
  }
  requireIn(
    build,
    `runs-on: \${{ matrix.platform.runner }}`,
    'build must use the native runner matrix',
  );
  requireIn(
    build,
    `platforms: linux/\${{ matrix.platform.arch }}`,
    'build must target its native platform',
  );
  requireIn(
    build,
    'push-by-digest=true,name-canonical=true,push=true',
    'native subjects must publish by digest',
  );
  if (/^ {10}(?:tags|push):/m.test(buildStep))
    failures.push('native builds must not publish version tags');
  requireIn(build, 'type=provenance,mode=max', 'native build must attach max provenance');
  requireIn(build, 'type=sbom,generator=', 'native build must attach a pinned SBOM');
  if (build.includes('id-token: write'))
    failures.push('native build must not request signing identity');
  if (!/needs: (?:build|\[[^\]\n]*\bbuild\b[^\]\n]*\])/.test(publish))
    failures.push('final publication must wait for both native builds');
  requireIn(
    publish,
    'actions/download-artifact@',
    'final publication must download build receipts',
  );
  requireIn(
    publish,
    'release-evidence.mjs sources',
    'merge inputs must validate both platform receipts',
  );
  requireIn(publish, 'receipts/*.json', 'merge must validate all downloaded receipts');
  requireIn(publish, 'docker buildx imagetools create', 'final publication must assemble an index');
  requireIn(publish, `"\${sources[@]}"`, 'index assembly must consume validated subjects');
  requireIn(publish, '--metadata-file', 'final digest must come from the merge result');
  requireIn(publish, 'release-evidence.mjs digest', 'final digest must be validated');
  if (!/node (?:scripts\/check-oci-index\.mjs|scripts\/release-evidence\.mjs index)/.test(publish))
    failures.push('merged index must validate both platforms and attestations');
  for (const arch of ['amd64', 'arm64'])
    requireIn(
      publish,
      `trivy image --platform linux/${arch} --scanners vuln`,
      `final ${arch} manifest must be scanned`,
    );
  if (!/check-trivy-reports\.mjs|Vulnerabilities\?\.length/.test(publish))
    failures.push('both scan reports must pass the zero-findings gate');
  const sign = publish.match(/^\s*run: cosign sign .*$/m)?.[0] ?? '';
  requireIn(sign, 'steps.merge.outputs.digest', 'only the final index digest may be signed');
  if (publish.indexOf('cosign sign') < publish.indexOf('trivy image'))
    failures.push('signing must follow platform scans');
  return failures;
}
