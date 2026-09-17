/**
 * Unit tests for the McpServer abstraction.
 *
 * These are a fence, not coverage padding: `listPrompts` / `getPrompt` are
 * deliberately NON-abstract with defaults, unlike `listResources` /
 * `readResource`. Making them abstract would break every package in
 * `connectors/` plus `RestApiMcpServer` and `ExternalMcpServer` at once, so
 * the defaults are part of the contract and are asserted here.
 */

import { describe, expect, it } from 'vitest';
import { McpServer } from '../../src/abstractions/McpServer.js';
import type { McpResource, McpTool } from '../../src/types/mcp.js';

/** Minimal concrete server that implements ONLY the abstract members. */
class MinimalMcpServer extends McpServer {
  async initialize(): Promise<void> {
    // no-op
  }

  async listTools(): Promise<McpTool[]> {
    return [{ name: 'noop', description: 'does nothing', inputSchema: { type: 'object' } }];
  }

  async callTool(): Promise<unknown> {
    return { content: [] };
  }

  async listResources(): Promise<McpResource[]> {
    return [];
  }

  async readResource(): Promise<unknown> {
    return { contents: [] };
  }
}

/** Server that DOES expose prompts, by overriding the defaults. */
class PromptfulMcpServer extends MinimalMcpServer {
  override async listPrompts() {
    return [{ name: 'greet', description: 'Say hello' }];
  }

  override async getPrompt(name: string, args?: Record<string, string>) {
    return {
      description: `rendered ${name}`,
      messages: [{ role: 'user' as const, content: { type: 'text', text: args?.who ?? 'world' } }],
    };
  }
}

describe('McpServer prompt defaults', () => {
  it('default listPrompts() returns []', async () => {
    await expect(new MinimalMcpServer().listPrompts()).resolves.toEqual([]);
  });

  it('default getPrompt() throws Method not found', async () => {
    await expect(new MinimalMcpServer().getPrompt('anything')).rejects.toThrow(
      'Method not found: prompts/get',
    );
  });

  it('a subclass can expose prompts without touching the abstract surface', async () => {
    const server = new PromptfulMcpServer();
    await expect(server.listPrompts()).resolves.toEqual([
      { name: 'greet', description: 'Say hello' },
    ]);
    await expect(server.getPrompt('greet', { who: 'connector host' })).resolves.toEqual({
      description: 'rendered greet',
      messages: [{ role: 'user', content: { type: 'text', text: 'connector host' } }],
    });
  });
});

describe('McpServer.handleRequest prompt dispatch', () => {
  it("wraps prompts/list in { prompts }, mirroring tools/list's { tools }", async () => {
    const response = await new PromptfulMcpServer().handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'prompts/list',
    });

    expect(response?.result).toEqual({ prompts: [{ name: 'greet', description: 'Say hello' }] });
  });

  it('dispatches prompts/get with name and arguments', async () => {
    const response = await new PromptfulMcpServer().handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'prompts/get',
      params: { name: 'greet', arguments: { who: 'connector host' } },
    });

    expect(response?.result).toEqual({
      description: 'rendered greet',
      messages: [{ role: 'user', content: { type: 'text', text: 'connector host' } }],
    });
  });

  it('rejects prompts/get without params', async () => {
    const response = await new PromptfulMcpServer().handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'prompts/get',
    });

    expect(response?.error?.message).toContain('Invalid params for prompts/get');
  });

  it('surfaces the default getPrompt() error as a JSON-RPC error', async () => {
    const response = await new MinimalMcpServer().handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'prompts/get',
      params: { name: 'greet' },
    });

    expect(response?.error?.code).toBe(-32603);
    expect(response?.error?.message).toContain('Method not found: prompts/get');
  });
});
