/** Independent consumer of Gateway google-principal/v2.
 * Keep wire schemas/domain/time semantics aligned with the producer. No signing API.
 * Trust comes only from an independently protected operator pin.
 */
import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';
import { z } from 'zod';
import { providerExtrasSchema } from './provider-extras.js';

/** Fixed cross-host allowance; expiry remains strict and proof bounds never stack. */
export const GOOGLE_PRINCIPAL_CLOCK_SKEW_SECONDS = 5;

const SEND = 'https://www.googleapis.com/auth/gmail.send';
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const EMAIL = 'https://www.googleapis.com/auth/userinfo.email';
/** Narrow actual grants only. Requested scopes never enter this function. */
export function googleMailPurpose(scopes: string[]): 'gmail_send' | 'gmail_readonly' {
  const values = new Set(scopes);
  if (
    values.size !== scopes.length ||
    !values.has('openid') ||
    !(values.has('email') || values.has(EMAIL)) ||
    scopes.some((scope) => !['openid', 'email', EMAIL, SEND, READ].includes(scope)) ||
    values.has(SEND) === values.has(READ)
  )
    throw unavailable();
  return values.has(SEND) ? 'gmail_send' : 'gmail_readonly';
}

/** Same-token provider evidence, encrypted at rest and never exposed in API summaries. */
export const googlePrincipalSchema = z
  .strictObject({
    version: z.literal(1),
    issuer: z.literal('https://accounts.google.com'),
    subject: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => [...value].every((c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) !== 127)),
    email: z.email().max(254),
    emailVerified: z.literal(true),
    purpose: z.enum(['gmail_send', 'gmail_readonly']),
    grantedScopes: z.array(z.string().min(1).max(256)).min(3).max(4),
    scopeSource: z.enum(['token_response', 'refresh_inherited']),
    verifiedAt: z.number().int().nonnegative(),
    grantId: z.uuid(),
    accessTokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((proof, ctx) => {
    try {
      if (googleMailPurpose(proof.grantedScopes) === proof.purpose) return;
    } catch {}
    ctx.addIssue({ code: 'custom', message: 'Invalid actual Google grant' });
  });
export type GooglePrincipal = z.infer<typeof googlePrincipalSchema>;

const endpointSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });
/** Exact signed producer/consumer contract; no user-supplied additions. */
export const googlePrincipalClaimsSchema = z.strictObject({
  version: z.literal(2),
  producer: endpointSchema.refine((value) => new URL(value).pathname === '/'),
  audience: endpointSchema,
  credentialId: z.string().min(1).max(255),
  credentialVersion: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  googlePrincipal: googlePrincipalSchema,
  providerExtras: providerExtrasSchema.optional(),
});
export type GooglePrincipalClaims = z.infer<typeof googlePrincipalClaimsSchema>;
const envelopeSchema = z.strictObject({
  version: z.literal(2),
  keyId: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z
    .string()
    .min(1)
    .max(7000)
    .regex(/^[A-Za-z0-9_-]+$/),
  signature: z
    .string()
    .length(86)
    .regex(/^[A-Za-z0-9_-]+$/),
});
/** These values must come from protected enrollment, never from the incoming envelope. */
export interface GooglePrincipalPin {
  publicKey: string;
  keyId: string;
  issuer: 'https://accounts.google.com';
  producer: string;
  audience: string;
  credentialId: string;
  credentialVersion: string;
  grantId: string;
  subject: string;
  email: string;
  purpose: 'gmail_send' | 'gmail_readonly';
}
const DOMAIN = Buffer.from('dxh-gateway/google-principal/v2\0');
function unavailable(): Error {
  return new Error('GOOGLE_PRINCIPAL_UNAVAILABLE');
}
/** The only safe error across the credential trust boundary. */
export function googlePrincipalUnavailable(): Error {
  return unavailable();
}
/** Public SPKI only. No private key material or credential leaves the signer. */
function credentialAttestationPublicKey(key: KeyObject): {
  publicKey: string;
  keyId: string;
} {
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw unavailable();
  const bytes = publicKey.export({ type: 'spki', format: 'der' });
  return {
    publicKey: bytes.toString('base64'),
    keyId: createHash('sha256').update(bytes).digest('hex'),
  };
}
/** Verify before using a credential or invoking a provider. No embedded key is accepted. */
export function verifyGooglePrincipalContext(
  encoded: string,
  accessToken: string,
  pin: GooglePrincipalPin,
  now = Math.floor(Date.now() / 1000),
): GooglePrincipalClaims {
  try {
    if (!encoded || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw unavailable();
    const envelope = envelopeSchema.parse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    );
    if (!pin.publicKey || pin.publicKey.length > 2048) throw unavailable();
    const key = createPublicKey({
      key: Buffer.from(pin.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    if (
      credentialAttestationPublicKey(key).keyId !== pin.keyId ||
      pin.keyId !== envelope.keyId ||
      !verify(
        null,
        Buffer.concat([DOMAIN, Buffer.from(envelope.payload)]),
        key,
        Buffer.from(envelope.signature, 'base64url'),
      )
    )
      throw unavailable();
    const c = googlePrincipalClaimsSchema.parse(
      JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8')),
    );
    const p = c.googlePrincipal;
    if (
      !Number.isSafeInteger(now) ||
      c.issuedAt > now + GOOGLE_PRINCIPAL_CLOCK_SKEW_SECONDS ||
      c.expiresAt <= now ||
      c.expiresAt <= c.issuedAt ||
      c.expiresAt - c.issuedAt > 60 ||
      p.verifiedAt > c.issuedAt + GOOGLE_PRINCIPAL_CLOCK_SKEW_SECONDS ||
      p.verifiedAt > now + GOOGLE_PRINCIPAL_CLOCK_SKEW_SECONDS ||
      c.producer !== pin.producer ||
      c.audience !== pin.audience ||
      c.credentialId !== pin.credentialId ||
      c.credentialVersion !== pin.credentialVersion ||
      p.issuer !== pin.issuer ||
      p.grantId !== pin.grantId ||
      p.subject !== pin.subject ||
      p.email !== pin.email ||
      p.purpose !== pin.purpose ||
      p.accessTokenSha256 !== createHash('sha256').update(accessToken).digest('hex')
    )
      throw unavailable();
    return c;
  } catch {
    throw unavailable();
  }
}
