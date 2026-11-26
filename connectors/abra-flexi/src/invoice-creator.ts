import { z } from 'zod';
import { FlexiApiError, type FlexiClient } from './client.js';
import { CreateIssuedInvoiceSchema, CreateReceivedInvoiceSchema } from './schemas.js';
import { type ToolDef, WRITE_TOOL } from './tool-annotations.js';

const one = z.union([z.literal(1), z.literal('1')]);
const zero = z.union([z.literal(0), z.literal('0')]);
const created = z.object({
  success: z.union([z.literal(true), z.literal('true')]),
  stats: z.object({ created: one, updated: zero, deleted: zero }),
});

export function buildInvoiceCreator(client: FlexiClient): ToolDef[] {
  return (['issued', 'received'] as const).map((kind) => {
    const evidence = kind === 'issued' ? 'faktura-vydana' : 'faktura-prijata';
    const base = kind === 'issued' ? CreateIssuedInvoiceSchema : CreateReceivedInvoiceSchema;
    const schema = base.extend({ id: base.shape.id.unwrap(), typDokl: z.string().min(1) }).strict();
    return {
      name: `flexi_create_${kind}_invoice`,
      description: `Create a new ${kind} invoice using a stable external ID. Existing invoices cannot be updated.`,
      annotations: WRITE_TOOL,
      inputSchema: schema,
      handler: async (input) => {
        const invoice = schema.parse(input);
        const result = await client.createRecord(evidence, { ...invoice, '@update': 'fail' });
        if (!created.safeParse(result).success)
          throw new FlexiApiError(
            'Creation was not confirmed. Check the invoice before retrying.',
            502,
            'UNCONFIRMED_WRITE',
          );
        return { created: true, externalId: invoice.id };
      },
    };
  });
}
