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
