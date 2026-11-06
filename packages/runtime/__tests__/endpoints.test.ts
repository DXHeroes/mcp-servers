import type { McpPackage } from '@dxheroes/mcp-kit';
import { describe, expect, it } from 'vitest';
import { connectorEndpoints } from '../src/endpoints.js';

const pkg: McpPackage = {
  metadata: {
    id: 'fixture',
    name: 'Fixture',
    version: '0.1.0',
    description: '',
    requiresApiKey: true,
  },
  createServer: () => {
    throw new Error('Must not instantiate during registration');
  },
};

describe('connector endpoint registry', () => {
  it('preserves the legacy single endpoint', () => {
    expect(connectorEndpoints(pkg).get('/mcp')).toEqual({ path: '/mcp', package: pkg });
  });
  it('registers only explicitly declared service routes', () => {
    const routes = connectorEndpoints(pkg, [
      { path: '/tasks/mcp', package: pkg, auth: 'oauth' },
      { path: '/calendar/mcp', package: pkg, auth: 'oauth' },
    ]);
    expect([...routes.keys()]).toEqual(['/tasks/mcp', '/calendar/mcp']);
    expect(routes.has('/mcp')).toBe(false);
  });
  it.each(['/health', '//tasks/mcp', '/tasks/../mcp', '/tasks/mcp?token=x', '/%74asks/mcp'])(
    'rejects ambiguous or reserved route %s',
    (path) => {
      expect(() => connectorEndpoints(pkg, [{ path, package: pkg }])).toThrow(
        'Invalid connector endpoint',
      );
    },
  );
  it('rejects duplicate and empty registries before listening', () => {
    expect(() => connectorEndpoints(pkg, [])).toThrow('empty');
    expect(() =>
      connectorEndpoints(pkg, [
        { path: '/mcp', package: pkg },
        { path: '/mcp', package: pkg },
      ]),
    ).toThrow('Duplicate');
  });
});
