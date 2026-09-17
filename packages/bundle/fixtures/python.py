"""Trusted fixture: the router validates auth/origin before this private listener."""
import asyncio
import base64
import hashlib
import json
import os
from mcp.server import MCPServer
from mcp.server.mcpserver import Context
from mcp.server.transport_security import TransportSecuritySettings
from starlette.responses import PlainTextResponse
from starlette.routing import Route
import uvicorn

mcp = MCPServer('python-fixture', version='0.1.0')

@mcp.tool()
async def context_echo(ctx: Context, wait: int = 0) -> str:
    """Return a synthetic credential digest; never expose a credential."""
    headers = ctx.headers or {}
    encoded = headers.get('x-mcp-upstream-credential')
    secret = base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)).decode() if encoded else os.environ.get('MCP_UPSTREAM_CREDENTIAL', 'none')
    for n in range(wait):
        await asyncio.sleep(0.025)
        await ctx.report_progress(n, wait)
    return json.dumps({'digest': hashlib.sha256(secret.encode()).hexdigest(), 'pid': os.getpid()})

@mcp.resource('fixture://status')
def status() -> str:
    return 'ready'

@mcp.prompt()
def greet() -> str:
    return 'Hello'

async def health(_request):
    return PlainTextResponse('ready')

if '--stdio' in __import__('sys').argv:
    mcp.run('stdio')
else:
    app = mcp.streamable_http_app(stateless_http=True, streamable_http_path='/mcp', host='127.0.0.1', transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=True, allowed_hosts=['127.0.0.1:*'], allowed_origins=['http://127.0.0.1']))
    app.routes.append(Route('/health', health))
    uvicorn.run(app, host='127.0.0.1', port=int(os.environ['MCP_PORT']), log_level='error')
