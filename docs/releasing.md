# Release process

Every connector and deployable support package has its own version. Connector package metadata and
its catalog fixture must match that connector's package version; the CRM template's package and
catalog entry match each other. `pnpm check:versions` enforces those local contracts without tying
them to the repository or plugin version.

After review, create `<component>-v<package-version>`, for example `postgres-v0.1.2` or
`catalog-v0.1.3`. The workflow rejects a tag that does not match the selected package and publishes
only that component's image:

- `ghcr.io/dxheroes/mcp-abra-flexi`
- `ghcr.io/dxheroes/mcp-byzdata`
- `ghcr.io/dxheroes/mcp-fakturoid`
- `ghcr.io/dxheroes/mcp-gemini-deep-research`
- `ghcr.io/dxheroes/mcp-merk`
- `ghcr.io/dxheroes/mcp-postgres`
- `ghcr.io/dxheroes/mcp-toggl`
- `ghcr.io/dxheroes/mcp-catalog`
- `ghcr.io/dxheroes/mcp-bundle`

The selected image is built from the tagged checkout in two native jobs: linux/amd64 on
`ubuntu-24.04` and linux/arm64 on `ubuntu-24.04-arm`. There is no QEMU step. Each job pushes an
immutable digest subject without version tags and uploads an image/architecture/version-specific
receipt bound to the source revision. The merge job requires both distinct platform receipts from
that revision and passes their digest references to `docker buildx imagetools create`. It merges
whole attested indexes, preserving attestation descriptors; only this job publishes version tags.
The final digest comes from the merge metadata, never from resolving a mutable tag.

BuildKit attaches a
pinned SPDX SBOM and SLSA provenance statement to each platform manifest. The workflow records the
index JSON and digest, verifies both platform manifests have attestation manifests, produces full
Trivy 0.74.0 JSON for each platform, and fails if either report contains a vulnerability. Only then
does cosign keylessly sign the multi-platform index digest. Digest metadata and scan reports are
uploaded as versioned workflow artifacts even when a gate fails.

Third-party actions use full commit SHAs. Secondary downloads and images are pinned too: buildx
0.37.1, BuildKit 0.33.0 by multiarch digest, SBOM generator 1.12.0 by multiarch digest, Trivy 0.74.0,
and cosign 3.1.3. Native build and final publication jobs receive `packages: write`; only final
publication receives `id-token: write` for signing. Validation and pull-request jobs are read-only.
Checkout credential persistence is disabled.

Each component release requires two native build jobs and one merge/scan/sign job, plus validation.
Native arm64 runner availability and queue capacity are release prerequisites. GitHub supports the selected
[standard runner labels in public and private repositories](https://docs.github.com/en/actions/reference/runners/github-hosted-runners);
private repositories use their own Actions minute allowance and billing. The independent CRM
template uses the same two-build/one-merge pattern.

Published Git tags are immutable. A failed release attempt is repaired in a new commit and patch
version; do not retarget its tag or rewrite published source history. Local checks cannot prove
hosted native builds or registry publication succeeded.

No paid deployment follows a tag. Verify authenticated pulls, platform manifests, attestations,
signature identity and scan artifacts first. New organization GHCR packages default private even
when linked to a public source repository; access inheritance is not visibility. A package
administrator must set only these new audited packages to public in each package's settings after
the first publication. There is no documented package-visibility REST mutation to automate here.
Finish with a truly unauthenticated registry-token/manifest pull so local Docker credentials cannot
hide a private package. Do not change organization-wide defaults or unrelated package access.

Publication is a separate audited action. Running local checks, creating a commit, or merging a
workflow does not authorize a tag, registry push, visibility change or deployment.
