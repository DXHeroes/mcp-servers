# First OAuth connector release security correction

The first four OAuth connector releases at source `04a3e0e` built successfully on native amd64
and arm64, but failed the zero-findings gate. Their `v0.1.0` registry indexes were already tagged
because the workflow promoted the version before scanning. Those four newly created packages
were withdrawn, with independent 404 readback. Git tags remain unchanged as failed-attempt
evidence. Do not install those versions or retry their immutable tags.

## Dependency and image correction

- MCP server/client 2.4.0 and Node adapter 2.1.2 use compatible declared peer ranges. They replace
  the vulnerable 2.0.0 request/transport handling.
- Hono 4.13.11 and its Node adapter 2.1.3 are pinned in the workspace and standalone CRM example.
- Zod 4.6.6 fixes constrained-collection memory exhaustion, also found by the separate npm audit.
- The existing pinned Alpine base is retained. Runtime images explicitly update musl/musl-utils
  to 1.2.6-r3 and zlib to 1.4-r0 from the same Alpine 3.24 repository, alongside the existing
  OpenSSL patches. Alpine's security database lists the fixes; no scanner exclusion is added.
- Google, Outlook, Teams and Slack advance to 0.1.1. Other components keep independent versions.

The new Zod serializer emits nullable properties as `type: ['number', 'null']`, equivalent to
the previous JSON Schema `anyOf` encoding. Wire tests retain the schema assertion and exercise
null, numeric and omitted values across both MCP eras. Credential separation and cancellation
assertions are unchanged.

## Publication correction

Both release workflows now assemble a run-specific candidate index, validate its platform and
attestation descriptors, scan both native manifests and sign its immutable digest before
publishing a version tag. Promotion consumes that digest and verifies an identical resulting
index. Policy regressions reject early version tagging and missing verified promotion; every
mutation must actually change the fixture. The four new regressions failed before the fix and
all 36 native-release policy cases pass afterwards.

The corrected local arm64 Google image builds and passes the unchanged Trivy 0.74.0
zero-findings gate; the standalone CRM npm audit reports zero vulnerabilities. Hosted native
scans, signature verification, authenticated/anonymous pulls and real-provider acceptance remain
separate evidence. A local scan does not prove those results.

Primary sources: [MCP request bounds](https://github.com/modelcontextprotocol/typescript-sdk/pull/2926),
[Hono Node adapter advisory](https://github.com/honojs/node-server/security/advisories/GHSA-rmxm-3fg6-px4f),
[Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
[Alpine 3.24 security database](https://secdb.alpinelinux.org/v3.24/main.json), and
[Docker index copying](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/).


## Published 0.1.1 evidence

The corrected releases are built from `e9b05b90f9d8faae4862efbc5d995df060319917`.
Each ran its own full check, native amd64/arm64 builds, zero-findings scans, signing and
verified promotion. Independent anonymous manifest requests returned 200 and matched the
recorded immutable digest; withdrawn `v0.1.0` manifests return 404. Cosign 3.1.3 verified each
signature with an empty Docker credential configuration, the exact component tag workflow
identity and GitHub Actions OIDC issuer.

| Image at `ghcr.io/dxheroes/` | Immutable index digest | Native release |
| --- | --- | --- |
| `mcp-google:v0.1.1` | `sha256:8befe7873c84f071a4595e29a7f28db54fe98a43bd859287c254793dc4419bcb` | [passed](https://github.com/DXHeroes/mcp-servers/actions/runs/42372054302) |
| `mcp-outlook:v0.1.1` | `sha256:1ce8a007ccc1e52ed6ca1d84bb5cc6e376362b176e735291d2443fd1d7b67aac` | [passed](https://github.com/DXHeroes/mcp-servers/actions/runs/42372056277) |
| `mcp-microsoft-teams:v0.1.1` | `sha256:1c8b360d522d19aeda671e8e3a274fe43283bcd4119be8ca0e99262a2889f883` | [passed](https://github.com/DXHeroes/mcp-servers/actions/runs/42372057844) |
| `mcp-slack:v0.1.1` | `sha256:5def7de0a47208ed5a6a4c6f0082d7210a5ab2036729b9a26897d99cfdae298e` | [passed](https://github.com/DXHeroes/mcp-servers/actions/runs/42372059565) |

The published arm64 images were then pulled anonymously by digest and started as UID/GID
65532, with a read-only filesystem, all capabilities dropped and no-new-privileges. Fourteen
actual SDK sessions covered tools/list on all seven service endpoints in both protocol eras:
Tasks 13 tools, Contacts 7, directory 1, Outlook mail 14/calendar 8, Teams 10 and Slack 9.
All four containers were removed. OCI revision labels matched the source above. This is
published-artifact and static metadata acceptance, not a live Google/Microsoft/Slack user
connection, read/write result, or the gateway/product preview matrix.
