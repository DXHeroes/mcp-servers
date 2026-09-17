# Independent TypeScript CRM MCP server

This directory is a complete client-owned repository template. It depends only on published
official MCP packages, Node.js, and npm. Copy the directory to a new repository; it has no
`workspace:*`, sibling imports, or unpublished DX Heroes package dependency.

## Run and test

```sh
npm ci
npm test
npm run build
MCP_ACCESS_TOKEN=local-test-token \
MCP_ALLOWED_HOSTS=127.0.0.1,localhost \
MCP_ALLOWED_ORIGINS=https://gateway.example.com \
npm start
```

In another shell:

```sh
MCP_SMOKE_TOKEN=local-test-token npm run build
MCP_SMOKE_TOKEN=local-test-token node scripts/smoke.mjs
```

The server exposes authenticated `POST /mcp` and `GET /health`. It serves the 2025-11-25 and
2026-07-28 MCP eras through the official TypeScript SDK. The example tools list, retrieve, and
create in-memory contacts; replace `ContactStore` with your reviewed data adapter. The catalog
entry advertises `auth.type: none` because there is no upstream user credential. The service bearer
still protects the transport and must be provisioned separately.

## Build and deploy

```sh
docker build -t mcp-crm:local .
docker run --rm --read-only --user 12345:12345 --cap-drop ALL \
  --security-opt no-new-privileges -p 127.0.0.1:8080:8080 \
  -e MCP_ACCESS_TOKEN=local-test-token \
  -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 \
  mcp-crm:local
```

The repository workflow builds linux/amd64 on `ubuntu-24.04` and linux/arm64 on
`ubuntu-24.04-arm`, and pushes only on `v*` tags. Both native build jobs publish immutable digest
subjects with pinned SBOM/provenance attestations; neither assigns version tags. A final job
validates the two architecture receipts against the checkout revision, merges their full indexes,
checks that both platforms retain attestations, scans both final platform manifests at all
severities, and signs the final index digest keylessly. The merge result owns the version tag.
Pull requests and main-branch checks never publish.

Its checkout, build actions, BuildKit image, scanner, SBOM generator, and cosign version are
immutable pins. `GITHUB_TOKEN` has `packages: write` only in native build and final release jobs;
`id-token: write` is limited to the final signing job. No registry password enters the Docker
context. These [native runner labels support public and private repositories](https://docs.github.com/en/actions/reference/runners/github-hosted-runners);
private repositories consume their own Actions allowance and billing. Allow capacity for two
native build jobs plus one merge/scan/sign job, including arm64 runner availability. Preserve a
failed published tag and increment the patch version instead of retargeting it.

For a different private registry, replace the login step with repository secrets such as
`REGISTRY_USERNAME` and `REGISTRY_TOKEN`. Pass them only to the login action. Do not copy `.npmrc`,
Git credentials, SSH material, or environment files into the build context or use them in `ARG` or
`RUN`; `.dockerignore` excludes the common paths.

After release, replace the all-zero digest and example host in
`deployment/kubernetes.yaml`. Create pull and runtime secrets outside source control:

```sh
kubectl create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username="$GHCR_USERNAME" \
  --docker-password="$GHCR_READ_TOKEN"
kubectl create secret generic mcp-crm-access-token \
  --from-literal=access-token="$MCP_CRM_ACCESS_TOKEN"
kubectl apply -f deployment/kubernetes.yaml
```

Register `catalog-entry.json` in an administrator-owned catalog manifest only after replacing the
example HTTPS endpoint and verifying the deployed digest. Discovery lists an offer; it does not
install this source, run its build, certify live health, or grant permission to deploy it.

Use `npm run validate` before committing. A production adapter should add persistent storage,
bounded responses, cancellation, authorization at the business-data layer, and focused tests for
its actual failure modes.
