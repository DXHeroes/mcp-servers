# Gateway v2 interoperability vectors

`gateway-principal-v2.json` contains synthetic tokens and public keys only. The private
Ed25519 keys were created in memory during fixture generation and were not retained.
The positive reader/sender, reconnect and alternate principal vectors and schema-valid
negative vectors were produced by the **actual built** Gateway
`signGooglePrincipalContext` from source commit
`d61ace765ab7440193226ecc28ca7bf0b16ae91a` on Node 22.21.1. The source and built-module
SHA256 values (including provider-extras) are recorded in the JSON provenance block.
The build receipt was `pnpm --filter @dxheroes/local-mcp-core build`, successful on
2026-11-13; the checked source SHA256 before and after that build matches this fixture.

The invalid-schema/lifetime vectors are explicit test-only Ed25519 signatures of
mutated claims using the same domain separation; the producer correctly would not
mint those. They exercise an authenticated but malformed producer, in addition to
ordinary signature corruption. They are not evidence of producer schema acceptance.
`now = 2000000000` is a fixed synthetic clock. No private package or cross-repository
import is required for CI or production. Tests exercise the real independent kit
verifier, runtime credential resolver and Google endpoints/client against these bytes.
A protocol change requires new actual-producer evidence and compatibility review.
