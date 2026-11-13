# Gateway v2 interoperability vectors

`gateway-principal-v2.json` contains synthetic tokens and public keys only. The private
Ed25519 keys were created in memory during fixture generation and were not retained.
The reader/sender, reconnect, alternate principal, schema-valid negative and temporal
vectors were produced by the **actual freshly built** Gateway
`signGooglePrincipalContext` on Node 22.21.1. The JSON provenance records the exact
committed producer revision/tree, source/dist SHA256 values (including provider-extras),
build command/source hash and evidence-generator hash. The producer source matched
its successful fresh build receipt before generation. Production and CI do not import
any private Gateway package or absolute cross-repository path.

The invalid-schema/lifetime vectors are explicit test-only Ed25519 signatures of
mutated claims using the same domain separation; the producer correctly would not
mint those. They exercise an authenticated but malformed producer and do not prove
producer schema acceptance. `overLifetime` and the 61-second temporal vector remain
refusals. The fixed synthetic clock is `now = 2000000000`.

Both verifiers use fixed `GOOGLE_PRINCIPAL_CLOCK_SKEW_SECONDS = 5`. Temporal vectors
cover consumer offsets of minus/plus one and five seconds, minus six seconds,
replica proof offsets of one and five seconds, each independent proof bound,
stacked ten-second refusal, strict exact expiry, the last unexpired second and a
signed 61-second interval. The permanent `future` and `futureVerification` negative
vectors now exceed the five-second allowance. No negative was reclassified as valid
merely to accommodate the amended contract.

Tests exercise the actual independent kit verifier and HTTP credential boundary,
Google endpoints/client and an owned loopback provider. Every temporal rejection
asserts connector construction and provider calls are both zero. Every accepted HTTP
vector dispatches exactly once using only the sender token. A protocol change requires
new actual-producer evidence and compatibility review.
