// Derived from Local MCP Gateway. Elastic License 2.0; see NOTICE.
export const MISSING_TEXT_PLACEHOLDER =
  '(the MCP server returned a text block with no text — the response had no body)';

export interface ToolResultNormalization {
  /** The result to send on the wire — the input itself when nothing was repaired. */
  result: unknown;
  /** How many `type: 'text'` blocks had to be given a `text` string. */
  repairedTextBlocks: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Guarantee that every `type: 'text'` block in `result.content` carries a
 * string `text`.
 *
 * An existing string is never touched — `''` included. An empty string
 * survives `JSON.stringify` intact, so a server that sent one meant to send
 * one; the defect this repairs is specifically the key going missing.
 */
export function normalizeToolResult(result: unknown): ToolResultNormalization {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return { result, repairedTextBlocks: 0 };
  }

  let repairedTextBlocks = 0;
  const content = result.content.map((block) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text === 'string') {
      return block;
    }
    // Any non-string `text` is repaired the same way, not just `undefined`:
    // `null`, a number or an object are equally invalid on the wire, and the
    // adapter has no basis for guessing which of them was meant as prose.
    repairedTextBlocks += 1;
    return { ...block, text: MISSING_TEXT_PLACEHOLDER };
  });

  if (repairedTextBlocks === 0) {
    return { result, repairedTextBlocks: 0 };
  }

  return { result: { ...result, content }, repairedTextBlocks };
}
