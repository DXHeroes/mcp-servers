import { readFile } from 'node:fs/promises';

const reports = process.argv.slice(2);
if (reports.length === 0) throw new Error('pass at least one Trivy JSON report');
const findings = [];
for (const file of reports) {
  const report = JSON.parse(await readFile(file, 'utf8'));
  for (const result of report.Results ?? []) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      findings.push(
        `${file}: ${vulnerability.VulnerabilityID ?? 'unknown'} ${vulnerability.PkgName ?? 'unknown'} ${vulnerability.Severity ?? 'UNKNOWN'}`,
      );
    }
  }
}
if (findings.length > 0) {
  console.error(findings.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`No vulnerability findings in ${reports.length} platform report(s)`);
}
