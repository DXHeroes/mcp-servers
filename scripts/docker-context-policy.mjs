export const REQUIRED_RECURSIVE_IGNORES = [
  '**/.git',
  '**/.git/**',
  '**/.env*',
  '**/.npmrc',
  '**/.pypirc',
  '**/.ssh',
  '**/.ssh/**',
  '**/.runtime',
  '**/.runtime/**',
  '**/.venv',
  '**/venv',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/secrets',
  '**/secrets/**',
  '**/.aws',
  '**/.aws/**',
  '**/.netrc',
  '**/.git-credentials',
  '**/.config/gcloud',
  '**/.config/gcloud/**',
];

export function missingRecursiveIgnores(source) {
  const rules = new Set(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
  return REQUIRED_RECURSIVE_IGNORES.filter((rule) => !rules.has(rule));
}
