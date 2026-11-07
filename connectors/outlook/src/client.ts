/** Outlook keeps its /me scope and response timezone over the shared Graph transport. */
import { GraphClient as SharedGraphClient } from '@dxheroes/mcp-graph';

export { GraphApiError, GraphInputError } from '@dxheroes/mcp-graph';
export class GraphClient extends SharedGraphClient {
  constructor(token: string) {
    super(token, { roots: ['me'], headers: { Prefer: 'outlook.timezone="UTC"' } });
  }
}
