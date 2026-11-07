/** Explicit, bounded OAuth token-response metadata; never arbitrary provider JSON or secrets. */
import { z } from 'zod';

export const providerExtraFieldsSchema = z.array(z.literal('api_domain')).max(1);
export type ProviderExtraField = z.infer<typeof providerExtraFieldsSchema>[number];
export const providerExtrasSchema = z.strictObject({
  api_domain: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === '/' &&
          (value === url.origin || value === `${url.origin}/`)
        );
      } catch {
        return false;
      }
    }, 'Invalid provider API origin')
    .optional(),
});
export type ProviderExtras = z.infer<typeof providerExtrasSchema>;

/** Catalog selection cannot opt into a token, client secret, arbitrary object or nested path. */
export function selectProviderExtras(
  body: Record<string, unknown>,
  fields: unknown,
): ProviderExtras | undefined {
  if (fields === undefined) return undefined;
  const allowed = providerExtraFieldsSchema.parse(fields);
  const selected = Object.fromEntries(
    allowed.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]),
  );
  if (!Object.keys(selected).length) return undefined;
  return providerExtrasSchema.parse(selected);
}

/** The only connector context envelope. The size limit is over decoded UTF-8 bytes. */
export function encodeUpstreamContext(
  extras: ProviderExtras | null | undefined,
): string | undefined {
  if (!extras) return undefined;
  const checked = providerExtrasSchema.parse(extras);
  if (!Object.keys(checked).length) return undefined;
  const json = JSON.stringify({ version: 1, providerExtras: checked });
  if (Buffer.byteLength(json, 'utf8') > 4096) throw new Error('Invalid connector upstream context');
  return Buffer.from(json, 'utf8').toString('base64url');
}

/** Receive exactly the bounded credential context, rebuilding the strict shape before use. */
export function decodeUpstreamContext(encoded: string): ProviderExtras {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 5462)
    throw new Error('Invalid connector upstream context');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length > 4096 || bytes.toString('base64url') !== encoded)
    throw new Error('Invalid connector upstream context');
  const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const envelope = z
    .strictObject({ version: z.literal(1), providerExtras: providerExtrasSchema })
    .parse(JSON.parse(json));
  return envelope.providerExtras;
}
