/** Operator-only configuration; incoming claims never select or update these pins. */
import { createHash, createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { googlePrincipalClaimsSchema, googlePrincipalSchema } from './google-principal-context.js';

export const googlePrincipalPinSchema = z
  .strictObject({
    publicKey: z.string().min(1).max(2048),
    keyId: z.string().regex(/^[a-f0-9]{64}$/),
    issuer: googlePrincipalSchema.shape.issuer,
    producer: googlePrincipalClaimsSchema.shape.producer,
    audience: googlePrincipalClaimsSchema.shape.audience,
    credentialId: googlePrincipalClaimsSchema.shape.credentialId,
    credentialVersion: googlePrincipalClaimsSchema.shape.credentialVersion,
    grantId: googlePrincipalSchema.shape.grantId,
    subject: googlePrincipalSchema.shape.subject,
    email: googlePrincipalSchema.shape.email,
    purpose: googlePrincipalSchema.shape.purpose,
  })
  .refine((pin) => {
    try {
      const bytes = Buffer.from(pin.publicKey, 'base64');
      if (bytes.toString('base64') !== pin.publicKey) return false;
      const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
      const canonical = key.export({ type: 'spki', format: 'der' });
      return (
        key.asymmetricKeyType === 'ed25519' &&
        bytes.equals(canonical) &&
        createHash('sha256').update(bytes).digest('hex') === pin.keyId
      );
    } catch {
      return false;
    }
  }, 'Invalid Google principal pin');

const pairSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    reader: googlePrincipalPinSchema,
    sender: googlePrincipalPinSchema,
  })
  .refine(
    ({ reader, sender }) =>
      reader.purpose === 'gmail_readonly' &&
      sender.purpose === 'gmail_send' &&
      reader.issuer === sender.issuer &&
      reader.subject === sender.subject &&
      reader.email === sender.email &&
      reader.credentialId !== sender.credentialId &&
      reader.grantId !== sender.grantId &&
      reader.audience !== sender.audience,
    'Invalid Google principal pair',
  );

export const googlePrincipalRegistrySchema = z
  .strictObject({
    version: z.literal(1),
    pairs: z.array(pairSchema).max(32),
  })
  .refine(
    ({ pairs }) => new Set(pairs.map((pair) => pair.id)).size === pairs.length,
    'Duplicate Google principal pair',
  );

const pathSchema = z.string().regex(/^\/(?:[a-z][a-z0-9-]*\/)?mcp$/);
export const googlePrincipalBindingSchema = z
  .strictObject({
    registryFile: z
      .string()
      .min(2)
      .max(4096)
      .refine((path) => path.startsWith('/') && !path.includes('\0')),
    pairId: pairSchema.shape.id,
    readerPath: pathSchema,
    senderPath: pathSchema,
  })
  .refine((binding) => binding.readerPath !== binding.senderPath, 'Duplicate bound route');
export type GooglePrincipalBinding = z.infer<typeof googlePrincipalBindingSchema>;
