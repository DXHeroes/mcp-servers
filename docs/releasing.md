# Release process

The repository has one release version. `package.json`, workspace package versions, connector
metadata, catalog fixtures and the independent CRM template must match. `pnpm check:versions`
enforces that rule. Create only a `v<package-version>` tag after the public tree and history pass
review; the workflow refuses a mismatched tag.

The tag workflow first runs the full public check. A matrix then publishes:

- `ghcr.io/dxheroes/mcp-abra-flexi`
- `ghcr.io/dxheroes/mcp-byzdata`
- `ghcr.io/dxheroes/mcp-fakturoid`
- `ghcr.io/dxheroes/mcp-gemini-deep-research`
- `ghcr.io/dxheroes/mcp-merk`
- `ghcr.io/dxheroes/mcp-postgres`
- `ghcr.io/dxheroes/mcp-toggl`
- `ghcr.io/dxheroes/mcp-catalog`
- `ghcr.io/dxheroes/mcp-bundle`

Every image is built for linux/amd64 and linux/arm64 from the tagged checkout. BuildKit attaches a
pinned SPDX SBOM and SLSA provenance statement to each platform manifest. The workflow records the
index JSON and digest, verifies both platform manifests have attestation manifests, produces full
Trivy 0.74.0 JSON for each platform, and fails if either report contains a vulnerability. Only then
does cosign keylessly sign the multi-platform index digest. Digest metadata and scan reports are
uploaded as versioned workflow artifacts even when a gate fails.

Third-party actions use full commit SHAs. Secondary downloads and images are pinned too: buildx
0.37.1, BuildKit 0.33.0 by multiarch digest, QEMU binfmt by multiarch digest, SBOM generator 1.12.0
by multiarch digest, Trivy 0.74.0, and cosign 3.1.3. The release job alone receives
`packages: write` and `id-token: write`; validation and pull-request jobs are read-only. Checkout
credential persistence is disabled.

No paid deployment follows a tag. Verify authenticated pulls, platform manifests, attestations,
signature identity and scan artifacts first. New organization GHCR packages default private even
when linked to a public source repository; access inheritance is not visibility. A package
administrator must set only these new audited packages to public in each package's settings after
the first publication. There is no documented package-visibility REST mutation to automate here.
Finish with a truly unauthenticated registry-token/manifest pull so local Docker credentials cannot
hide a private package. Do not change organization-wide defaults or unrelated package access.

Publication is a separate audited action. Running local checks, creating a commit, or merging a
workflow does not authorize a tag, registry push, visibility change or deployment.
