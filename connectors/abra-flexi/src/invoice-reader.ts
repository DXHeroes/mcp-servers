import { z } from 'zod';
import { FlexiApiError, type FlexiClient } from './client.js';
import { READ_ONLY_TOOL, type ToolDef } from './tool-annotations.js';

const id = z.union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]{0,15}$/)]);
const detailInput = z.strictObject({ id });
const listInput = z.strictObject({
  limit: z.number().int().min(1).max(500).default(50),
  start: z.number().int().nonnegative().default(0),
  filter: z
    .string()
    .regex(/^id = [1-9][0-9]{0,15}$/)
    .optional()
    .describe('Exact numeric ID, e.g. id = 123'),
});

const amount = z.union([z.string(), z.number()]);
const issued = z.object({
  id,
  kod: z.string(),
  mena: z.string(),
  sumCelkem: amount,
  sumCelkemMen: amount.optional(),
  varSym: z.string().optional(),
  cisObj: z.string().optional(),
});
const received = issued.extend({ cisDosle: z.string().optional() });

export function buildInvoiceReader(client: FlexiClient): ToolDef[] {
  return (['issued', 'received'] as const).flatMap((kind) => {
    const evidence = kind === 'issued' ? 'faktura-vydana' : 'faktura-prijata';
    const row = kind === 'issued' ? issued : received;
    const detail = `custom:${Object.keys(row.shape).join(',')}`;
    async function read(args: z.infer<typeof listInput> | z.infer<typeof detailInput>) {
      const single = 'id' in args;
      const selector = single ? String(args.id) : args.filter && `(${args.filter})`;
      const data = await client.readInvoiceRows(
        evidence,
        selector,
        single
          ? { detail }
          : {
              detail,
              limit: args.limit,
              start: args.start,
              order: 'id',
            },
      );
      const rows = z.object({ [evidence]: z.array(row) }).parse(data)[evidence]!;
      if (single && !rows.length) throw new FlexiApiError('Invoice not found.', 404, 'NOT_FOUND');
      const expectedId = single ? String(args.id) : args.filter?.slice(5);
      if (
        rows.length > (single ? 1 : args.limit) ||
        (expectedId && rows.some((r) => String(r.id) !== expectedId))
      )
        throw new Error('Invalid invoice result');
      return { [evidence]: rows };
    }
    return [
      {
        name: `flexi_list_${kind}_invoices`,
        description: `List ${kind} invoices in ID order.`,
        inputSchema: listInput,
        annotations: READ_ONLY_TOOL,
        handler: (args) => read(listInput.parse(args)),
      },
      {
        name: `flexi_get_${kind}_invoice`,
        description: `Read a single ${kind} invoice by numeric ID.`,
        inputSchema: detailInput,
        annotations: READ_ONLY_TOOL,
        handler: (args) => read(detailInput.parse(args)),
      },
    ];
  });
}
