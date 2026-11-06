import type { McpPackage } from '@dxheroes/mcp-kit';

/** A service route is fixed by the connector author, never by a request or credential. */
export interface ConnectorEndpoint {
  path: string;
  package: McpPackage;
  auth?: 'oauth';
}

/** Validate all routes before opening a listener; legacy packages keep their /mcp endpoint. */
export function connectorEndpoints(
  pkg: McpPackage,
  endpoints: readonly ConnectorEndpoint[] = [{ path: '/mcp', package: pkg }],
): ReadonlyMap<string, ConnectorEndpoint> {
  if (endpoints.length === 0) throw new Error('Connector endpoint registry is empty');
  const routes = new Map<string, ConnectorEndpoint>();
  for (const endpoint of endpoints) {
    if (!/^\/(?:[a-z][a-z0-9-]*\/)?mcp$/.test(endpoint.path))
      throw new Error('Invalid connector endpoint');
    if (routes.has(endpoint.path)) throw new Error('Duplicate connector endpoint');
    // Copy the route descriptor so callers cannot change authentication after validation.
    routes.set(endpoint.path, { ...endpoint });
  }
  return routes;
}
