/**
 * Gemini API client wrapper for Deep Research functionality
 *
 * Uses the official Interactions API for the Deep Research Agent.
 * See: https://ai.google.dev/gemini-api/docs/deep-research
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { ToolCallContext } from '@dxheroes/mcp-kit';
import { GoogleGenAI, type Interactions } from '@google/genai';
import { classifyGeminiError, GeminiApiError, isCredentialProblem } from './errors.js';

export interface DeepResearchInput {
  topic: string;
  formatInstructions?: string;
}

export interface DeepResearchResult {
  content: string;
  interactionId: string;
  citations?: string[];
  status: 'completed' | 'failed';
  error?: string;
}

const INTERACTION_REQUEST = {
  headers: { 'Api-Revision': '2026-05-20' },
  maxRetries: 0,
};

const RESEARCH_FAILURES = new Map([
  ['failed', 'Research failed. Check API key and try again.'],
  ['cancelled', 'Research was cancelled.'],
  ['requires_action', 'Research requires action that cannot be handled automatically.'],
  ['incomplete', 'Research returned incomplete results.'],
  ['requires_continuation', 'Research requires continuation that cannot be handled automatically.'],
  ['budget_exceeded', 'Research exceeded the provider budget.'],
]);

interface InteractionContent {
  type: string;
  text?: string;
  annotations?: Array<{
    type: string;
    url?: string;
    document_uri?: string;
  }>;
}

type InteractionOutput = Partial<
  Pick<Interactions.Interaction, 'id' | 'status' | 'output_text' | 'steps'>
> & {
  // Responses for older stored interactions may still carry the original shape.
  outputs?: InteractionContent[];
};

export function extractTextFromContent(content: { type: string; text?: string }): string {
  return content.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

function extractInteractionText(result: InteractionOutput): string {
  if (result.output_text) return result.output_text;
  const outputs = result.outputs ?? [];
  for (let i = outputs.length - 1; i >= 0; i--) {
    const output = outputs[i];
    if (!output) continue;
    const text = extractTextFromContent(output);
    if (text) return text;
  }
  return '';
}

/** Collect URL and file citations from model output, including legacy responses. */
export function extractCitations(result: InteractionOutput): string[] {
  const citations = new Set<string>();
  try {
    const modelOutputs = result.steps?.flatMap((step) =>
      step.type === 'model_output' ? (step.content ?? []) : [],
    );
    const outputs = modelOutputs?.length ? modelOutputs : (result.outputs ?? []);

    for (const output of outputs) {
      if (output.type !== 'text') continue;
      for (const annotation of output.annotations ?? []) {
        if (annotation.type === 'url_citation' && annotation.url) {
          citations.add(annotation.url);
        } else if (annotation.type === 'file_citation' && annotation.document_uri) {
          citations.add(annotation.document_uri);
        }
      }
    }
  } catch {
    // Return the report even when optional citation data is malformed.
  }

  return [...citations];
}

/**
 * Gemini API client for Deep Research
 *
 * Uses the Interactions API with the Deep Research agent.
 * Research tasks run in the background and may take several minutes.
 */
export class GeminiClient {
  private client: GoogleGenAI;
  private agentName = 'deep-research-preview-04-2026';
  private followUpModel = 'gemini-3.8-flash';

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1beta' } });
  }

  /**
   * Validate the API key by making a lightweight API call
   *
   * Uses models.list() which is fast and read-only.
   * @returns Validation result with valid status and error message if failed
   */
  async validateApiKey(): Promise<{ valid: boolean; error?: string }> {
    try {
      // Use models.list() - lightweight, read-only, ~100ms
      const pager = await this.client.models.list({ config: { pageSize: 1 } });
      // Just iterate once to trigger the API call
      for await (const _model of pager) {
        break;
      }
      return { valid: true };
    } catch (error) {
      // Classified by the shared classifier, not by a private list of
      // substrings. The private list is how this method and the server's
      // error handler ended up disagreeing about what a 403 means.
      const classified = classifyGeminiError(error);
      if (isCredentialProblem(classified.code)) {
        return { valid: false, error: 'Invalid API key' };
      }
      return { valid: false, error: `Validation failed: ${classified.message}` };
    }
  }

  /**
   * Perform deep research on a topic
   *
   * This method starts a background research task and polls for completion.
   * Research tasks typically take 5-20 minutes to complete.
   *
   * @param input - Research input with topic and optional formatting instructions
   * @returns Research result with content and citations
   */
  async deepResearch(
    input: DeepResearchInput,
    context?: ToolCallContext,
  ): Promise<DeepResearchResult> {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new GeminiApiError(
            'Research timed out after 60 minutes; the task may still be running on the Gemini side.',
            'TIMEOUT',
          ),
        ),
      60 * 60 * 1000,
    );
    const signal = context
      ? AbortSignal.any([context.signal, controller.signal])
      : controller.signal;
    try {
      return await this.runResearch(input, { ...context, signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async runResearch(
    input: DeepResearchInput,
    context: ToolCallContext,
  ): Promise<DeepResearchResult> {
    context.signal.throwIfAborted();
    // Build prompt with optional formatting instructions
    let prompt = input.topic;
    if (input.formatInstructions) {
      prompt += `\n\n${input.formatInstructions}`;
    }

    // Start background research task
    // store: true is required for background interactions to be retrievable
    const interaction = await this.client.interactions.create(
      {
        input: prompt,
        agent: this.agentName,
        background: true,
        store: true,
      },
      { ...INTERACTION_REQUEST, signal: context.signal },
    );

    const interactionId = interaction.id;
    console.error(`[GeminiDeepResearch] Research started: ${interactionId}`);

    // Poll for completion (max 60 min timeout per docs)
    const maxWaitMs = 60 * 60 * 1000; // 60 minutes
    const pollIntervalMs = 10 * 1000; // 10 seconds
    const startTime = Date.now();

    try {
      while (Date.now() - startTime < maxWaitMs) {
        context.signal.throwIfAborted();
        const result = await this.client.interactions.get(interactionId, undefined, {
          ...INTERACTION_REQUEST,
          signal: context.signal,
        });

        if (result.status === 'completed') {
          console.error(`[GeminiDeepResearch] Research completed: ${interactionId}`);

          return {
            content: extractInteractionText(result),
            interactionId: result.id,
            citations: extractCitations(result),
            status: 'completed',
          };
        }

        const error = RESEARCH_FAILURES.get(result.status);
        if (error) {
          console.warn(`[GeminiDeepResearch] Research ${result.status}: ${interactionId}`);

          return { content: '', interactionId: result.id, status: 'failed', error };
        }

        const elapsedMin = Math.round((Date.now() - startTime) / 60000);
        console.error(
          `[GeminiDeepResearch] Research in progress (${elapsedMin}min): ${interactionId}`,
        );

        // Wait before next poll
        await context.onProgress?.();
        await delay(pollIntervalMs, undefined, { signal: context.signal });
      }

      throw new GeminiApiError(
        'Research timed out after 60 minutes; the task may still be running on the Gemini side.',
        'TIMEOUT',
      );
    } catch (error) {
      if (context.signal.aborted) {
        // Best effort remote cancellation, separately bounded after the request aborts.
        try {
          await this.client.interactions.cancel(interactionId, undefined, {
            ...INTERACTION_REQUEST,
            signal: AbortSignal.timeout(5000),
          });
        } catch {
          /* Provider work may continue; never expose its error body. */
        }
      }
      throw error;
    }
  }

  /**
   * Ask a follow-up question about a completed research
   *
   * Follow-ups use a model (not an agent) with previous_interaction_id.
   *
   * @param previousInteractionId - The ID of the completed research interaction
   * @param question - The follow-up question to ask
   * @returns Research result with the answer
   */
  async followUp(
    previousInteractionId: string,
    question: string,
    context?: ToolCallContext,
  ): Promise<DeepResearchResult> {
    context?.signal.throwIfAborted();
    const interaction = await this.client.interactions.create(
      {
        input: question,
        model: this.followUpModel,
        previous_interaction_id: previousInteractionId,
        // A continuation sends another billable create request.
        automatic_continuation: false,
      },
      { ...INTERACTION_REQUEST, signal: context?.signal },
    );

    if (interaction.status !== 'completed') {
      throw new GeminiApiError('Gemini follow-up did not complete.', 'API_ERROR');
    }

    return {
      content: extractInteractionText(interaction),
      interactionId: interaction.id,
      status: 'completed',
    };
  }
}
