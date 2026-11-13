import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { verifyGooglePrincipalContext } from '../src/utils/google-principal-context.js';
import { googlePrincipalRegistrySchema } from '../src/utils/google-principal-registry.js';

const vectors = JSON.parse(
  readFileSync(
    new URL(
      '../../../connectors/google/__tests__/fixtures/gateway-principal-v2.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const pin = googlePrincipalRegistrySchema.parse(vectors.registry).pairs[0]!.sender;
it('verifies an actual frozen Gateway signer vector and exact time boundaries', () => {
  const claims = verifyGooglePrincipalContext(
    vectors.headers.sender,
    'sender-token',
    pin,
    vectors.now,
  );
  expect(claims.credentialVersion).toBe('1');
  expect(() =>
    verifyGooglePrincipalContext(vectors.headers.sender, 'sender-token', pin, claims.issuedAt),
  ).not.toThrow();
  expect(() =>
    verifyGooglePrincipalContext(vectors.headers.sender, 'sender-token', pin, claims.expiresAt - 1),
  ).not.toThrow();
  for (const now of [claims.issuedAt - 1, claims.expiresAt, Number.NaN, 0.5])
    expect(() =>
      verifyGooglePrincipalContext(vectors.headers.sender, 'sender-token', pin, now),
    ).toThrow('GOOGLE_PRINCIPAL_UNAVAILABLE');
});
it('refuses wrong pinned issuer and key ID, regardless of an otherwise valid signature', () => {
  for (const changed of [
    { ...pin, keyId: '0'.repeat(64) },
    { ...pin, issuer: 'https://foreign.test' },
  ])
    expect(() =>
      verifyGooglePrincipalContext(
        vectors.headers.sender,
        'sender-token',
        changed as typeof pin,
        vectors.now,
      ),
    ).toThrow('GOOGLE_PRINCIPAL_UNAVAILABLE');
});
it('refuses signed-envelope additions and changed payload bytes', () => {
  const original = JSON.parse(Buffer.from(vectors.headers.sender, 'base64url').toString());
  for (const envelope of [
    { ...original, publicKey: pin.publicKey },
    { ...original, payload: `${original.payload.slice(0, -1)}A` },
    { ...original, version: 1 },
    { ...original, signature: 'A'.repeat(85) },
  ]) {
    const context = Buffer.from(JSON.stringify(envelope)).toString('base64url');
    expect(() => verifyGooglePrincipalContext(context, 'sender-token', pin, vectors.now)).toThrow(
      'GOOGLE_PRINCIPAL_UNAVAILABLE',
    );
  }
});
