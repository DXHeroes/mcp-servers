"""Bounded real pipe failure: initialize succeeds after stdin has closed."""
import json
import os
import sys
import time

request = json.loads(sys.stdin.readline())
with open(os.environ['PROBE_PID_FILE'], 'a', encoding='utf-8') as output:
    output.write(str(os.getpid()) + '\n')
os.close(0)
print('synthetic-private-child-diagnostic', file=sys.stderr, flush=True)
print(json.dumps({
    'jsonrpc': '2.0',
    'id': request['id'],
    'result': {
        'protocolVersion': '2025-11-25',
        'capabilities': {'tools': {}},
        'serverInfo': {'name': 'closed-stdin', 'version': '1'},
    },
}), flush=True)
time.sleep(10)
