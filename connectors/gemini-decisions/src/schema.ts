import { z } from 'zod';

const nonBlank = z.string().regex(/\S/);
const textBlock = z.strictObject({ type: z.literal('text'), text: nonBlank });
const data = z.string().min(4).base64().describe('Inline, padded base64 bytes.');
const uri = z
  .url({ protocol: /^https$/ })
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const { hostname, username, password } = new URL(value);
    return (
      !username &&
      !password &&
      !/(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be)\.?$/i.test(hostname)
    );
  })
  .describe('Public or signed HTTPS URL, or a Gemini Files API URI.');
// Publish mutually exclusive shapes so that MCP clients see the same contract we validate.
function media<const T extends z.ZodRawShape>(fields: T) {
  return z.union([z.strictObject({ ...fields, data }), z.strictObject({ ...fields, uri })]);
}
const inputBlock = z.union([
  textBlock,
  media({
    type: z.literal('image'),
    mime_type: z.enum([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/heic',
      'image/heif',
      'image/gif',
      'image/bmp',
      'image/tiff',
    ]),
    resolution: z.enum(['low', 'medium', 'high', 'ultra_high']).optional(),
  }),
  media({
    type: z.literal('audio'),
    mime_type: z.enum([
      'audio/wav',
      'audio/mp3',
      'audio/mpeg',
      'audio/aiff',
      'audio/aac',
      'audio/ogg',
      'audio/flac',
      'audio/m4a',
      'audio/opus',
      'audio/webm',
      'audio/l16',
      'audio/alaw',
      'audio/mulaw',
    ]),
  }),
  media({
    type: z.literal('video'),
    mime_type: z.enum([
      'video/mp4',
      'video/mpeg',
      'video/mov',
      'video/avi',
      'video/webm',
      'video/wmv',
      'video/x-flv',
      'video/3gpp',
    ]),
    resolution: z.enum(['low', 'medium', 'high']).optional(),
  }),
  media({ type: z.literal('document'), mime_type: z.literal('application/pdf') }),
]);
const instructions = z.union([nonBlank, textBlock, z.array(textBlock).min(1)]);
const questionKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const optionKey = z
  .string()
  .min(1)
  .refine(
    (key) =>
      Array.from(key).length <= 128 &&
      key === key.trim() &&
      !/[\p{Cc}\p{White_Space}]/u.test(key.replaceAll(' ', '')),
  );
function countBetween(record: object, min: number, max: number) {
  const count = Object.keys(record).length;
  return count >= min && count <= max;
}
// Zod records deliberately drop "__proto__". It is a valid Google question or
// option ID. Define it as an own data property after validating it separately.
function dictionary<V extends z.ZodType>(key: z.ZodString, value: V) {
  const ordinary = z.record(key, value);
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(ordinary, {
    io: 'input',
    unrepresentable: 'any',
  });
  return z
    .unknown()
    .transform((raw, ctx) => {
      const result = ordinary.safeParse(raw);
      if (!result.success) {
        ctx.addIssue({ code: 'custom', message: 'Invalid named entries.' });
        return z.NEVER;
      }
      if (raw && typeof raw === 'object' && Object.hasOwn(raw, '__proto__')) {
        const special = value.safeParse(Object.getOwnPropertyDescriptor(raw, '__proto__')?.value);
        if (!special.success || !key.safeParse('__proto__').success) {
          ctx.addIssue({ code: 'custom', message: 'Invalid named entry.' });
          return z.NEVER;
        }
        Object.defineProperty(result.data, '__proto__', { value: special.data, enumerable: true });
      }
      return result.data;
    })
    .meta(jsonSchema);
}
const question = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('noul'),
    instructions,
    criteria: z
      .strictObject({
        true_description: z.string().optional(),
        false_description: z.string().optional(),
      })
      .optional(),
  }),
  z.strictObject({
    type: z.literal('choice'),
    instructions,
    criteria: dictionary(optionKey, z.string())
      .refine((v) => countBetween(v, 2, 255))
      .meta({
        minProperties: 2,
        maxProperties: 255,
        description: '2–255 named options, each with a description (may be empty).',
      }),
  }),
  z.strictObject({
    type: z.literal('score'),
    instructions,
    criteria: z.array(nonBlank).min(2).max(255),
  }),
]);
export const decisionSchema = z.strictObject({
  input: z
    .union([nonBlank, inputBlock, z.array(inputBlock).min(1)])
    .describe('Shared text, serialized JSON, one content block, or a sequence of blocks.'),
  questions: dictionary(questionKey, question)
    .refine((v) => countBetween(v, 1, 1000))
    .meta({
      minProperties: 1,
      maxProperties: 1000,
      description: '1–1,000 questions. Use names matching [A-Za-z0-9_-]{1,64}.',
    }),
});
export type Questions = z.infer<typeof decisionSchema>['questions'];
const probability = z.number().min(0).max(1);
const common = { confidence: probability.optional() };
const answer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), ...common, noul: probability }),
  z.object({
    type: z.literal('choice'),
    ...common,
    choice: z.string(),
    probabilities: dictionary(z.string(), probability),
  }),
  z.object({
    type: z.literal('score'),
    ...common,
    score: z.number().nonnegative(),
    legend: z.record(z.string(), z.string()),
    probabilities: dictionary(z.string(), probability),
  }),
]);
const tokens = z.int().nonnegative();
const responseSchema = z.object({
  answers: dictionary(questionKey, answer),
  usage: z.object({
    total_input_tokens: tokens,
    total_output_tokens: tokens,
    total_tokens: tokens,
    input_tokens_by_modality: z.array(z.object({ modality: nonBlank, tokens })).optional(),
  }),
});
function sameKeys(actual: object, expected: object) {
  return (
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.keys(expected).every((k) => Object.hasOwn(actual, k))
  );
}
export function readResult(raw: unknown, questions: Questions) {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success || !sameKeys(parsed.data.answers, questions)) return;
  for (const [key, q] of Object.entries(questions)) {
    const a = parsed.data.answers[key];
    if (a?.type !== q.type) return;
    if (
      a.type === 'choice' &&
      q.type === 'choice' &&
      (!Object.hasOwn(q.criteria, a.choice) || !sameKeys(a.probabilities, q.criteria))
    )
      return;
    if (
      a.type === 'score' &&
      q.type === 'score' &&
      (a.score > q.criteria.length - 1 ||
        !sameKeys(a.probabilities, q.criteria) ||
        !sameKeys(a.legend, q.criteria) ||
        q.criteria.some((label, i) => a.legend[i] !== label))
    )
      return;
  }
  return parsed.data;
}
