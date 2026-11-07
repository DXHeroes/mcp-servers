import { ProtocolError } from '@modelcontextprotocol/server';

/** Only throw after a definite provider authentication refusal before the operation ran.
 * Never use for missing scopes, transport auth, throttling, timeouts or uncertain writes.
 * The gateway can refresh and replay once, so classification is part of write safety.
 */
export class UpstreamCredentialInvalidError extends ProtocolError {
  constructor() {
    super(-32050, 'Upstream credential is invalid', {
      'io.dxheroes.connector/error': {
        version: 1,
        reason: 'upstream_credential_invalid',
      },
    });
  }
}
