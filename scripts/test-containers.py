#!/usr/bin/env python3
"""Build/run only owned test images/containers. No Docker socket mounts or runtime installs."""
import json, os, pathlib, subprocess, tempfile, time, urllib.request, urllib.error, uuid
ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = 'node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
IDS = ['abra-flexi', 'byzdata', 'fakturoid', 'gemini-deep-research', 'merk', 'postgres', 'toggl']
PREFIX = 'mcp-smoke-' + uuid.uuid4().hex[:10]
owned = []
network = False

def run(args, **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, text=True, capture_output=True, **kwargs)

def docker(args):
    return run(['docker', *args]).stdout.strip()

def ready(url, expected=200):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == expected:
                    return
        except urllib.error.HTTPError as error:
            if error.code == expected:
                return
            time.sleep(.1)
        except (urllib.error.URLError, OSError):
            time.sleep(.1)
    raise RuntimeError('Owned test container did not become ready')

receipt = {'buildContext': '.', 'platform': docker(['info', '--format', '{{.Architecture}}']), 'images': {}, 'checks': []}
try:
    for connector in [*IDS, 'catalog']:
        image = f'mcp-task3b/{connector}:test'
        args = ['build', '-f', 'Dockerfile.catalog' if connector == 'catalog' else 'Dockerfile.connector', '-t', image]
        if connector != 'catalog':
            args += ['--build-arg', f'CONNECTOR={connector}']
        print(f'Building {connector}', flush=True)
        docker([*args, '.'])
        receipt['images'][connector] = docker(['image', 'inspect', image, '--format', '{{.Id}}'])
    with tempfile.TemporaryDirectory(prefix=PREFIX) as temp:
        p = pathlib.Path(temp)
        p.chmod(0o755)
        run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(p/'ca.key'),'-out',str(p/'ca.crt'),'-days','1','-subj','/CN=Synthetic MCP smoke CA'])
        run(['openssl','req','-newkey','rsa:2048','-nodes','-keyout',str(p/'server.key'),'-out',str(p/'server.csr'),'-subj','/CN=api.track.toggl.com'])
        (p/'ext.cnf').write_text('subjectAltName=DNS:api.track.toggl.com\n')
        run(['openssl','x509','-req','-in',str(p/'server.csr'),'-CA',str(p/'ca.crt'),'-CAkey',str(p/'ca.key'),'-CAcreateserial','-out',str(p/'server.crt'),'-days','1','-extfile',str(p/'ext.cnf')])
        (p/'server.key').chmod(0o644)
        (p/'server.mjs').write_text('''import https from 'node:https';import fs from 'node:fs';
const expected='Basic '+Buffer.from('synthetic_tls_fixture:api_token').toString('base64');
https.createServer({key:fs.readFileSync('/fixture/server.key'),cert:fs.readFileSync('/fixture/server.crt')},(req,res)=>{
 const ok=req.url==='/api/v9/me' && req.headers.authorization===expected && !req.headers['x-mcp-upstream-credential'] && !req.headers['x-mcp-credential-mode'];
 res.writeHead(ok?200:401,{'content-type':'application/json'});res.end(JSON.stringify(ok?{id:42,fullname:'Synthetic TLS identity'}:{error:'rejected'}));
}).listen(443,'0.0.0.0');''')
        docker(['network','create','--internal',PREFIX]);network=True
        tls=PREFIX+'-tls';owned.append(tls)
        common=['--read-only','--user','12345:12345','--cap-drop','ALL','--security-opt','no-new-privileges']
        docker(['run','-d','--name',tls,'--network',PREFIX,'--network-alias','api.track.toggl.com',*common,'--mount',f'type=bind,src={p},dst=/fixture,readonly',BASE,'node','/fixture/server.mjs'])
        # The test CA is never installed in images. Untrusted certificates must still fail.
        negative="try{await fetch('https://api.track.toggl.com/api/v9/me');process.exit(2)}catch(e){if(!['UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN'].includes(e.cause?.code))throw e}"
        docker(['run','--rm','--network',PREFIX,*common,BASE,'node','--input-type=module','--eval',negative])
        receipt['untrustedTlsRejected']=True
        credentials={'abra-flexi':'https://203.0.113.10/c/fixture|fixture:synthetic','byzdata':'','fakturoid':'fixture:client:synthetic','gemini-deep-research':'synthetic-fixture','merk':'synthetic-fixture','toggl':'synthetic_tls_fixture'}
        password=os.environ['POSTGRES_TEST_PASSWORD']
        credentials['postgres']=f"host=host.docker.internal port={os.environ.get('POSTGRES_TEST_PORT','15434')} dbname=postgres user={os.environ.get('POSTGRES_TEST_USER','postgres')} password={password} sslmode=disable"
        for connector in IDS:
            name=PREFIX+'-'+connector;owned.append(name)
            image=f'mcp-task3b/{connector}:test'
            args=['run','-d','--name',name,*common,'-p','127.0.0.1::8080','-e','MCP_ACCESS_TOKEN=synthetic-service-token','-e',f'MCP_ALLOWED_HOSTS=127.0.0.1,{name}']
            if credentials[connector]:args+=['-e',f'MCP_UPSTREAM_CREDENTIAL={credentials[connector]}']
            if connector=='toggl':args+=['--network',PREFIX,'--mount',f'type=bind,src={p},dst=/fixture,readonly','-e','NODE_EXTRA_CA_CERTS=/fixture/ca.crt']
            docker([*args,image])
            if connector == 'toggl':
                docker(['exec',name,'node','--input-type=module','--eval',"for(let i=0;i<200;i++){try{if((await fetch('http://127.0.0.1:8080/health')).ok)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,100))}process.exit(1)"])
                port='8080'
            else:
                port=docker(['port',name,'8080/tcp']).rsplit(':',1)[1]
                ready(f'http://127.0.0.1:{port}/health')
            try:
                if connector == 'toggl':
                    http_output=docker(['run','--rm','--network',PREFIX,*common,'--mount',f'type=bind,src={ROOT},dst=/source,readonly','-e',f'MCP_SMOKE_HOST={name}','-e','MCP_SMOKE_HTTP_ONLY=true',BASE,'node','/source/scripts/container-smoke.mjs',connector,port,image,credentials[connector]])
                    stdio_output=run(['node','scripts/container-smoke.mjs',connector,port,image,credentials[connector]],env={**os.environ,'MCP_SMOKE_STDIO_ONLY':'true'})
                    combined=json.loads(http_output.strip().splitlines()[-1]);combined['stdio']=json.loads(stdio_output.stdout.strip().splitlines()[-1])['stdio']
                    output=type('Receipt',(),{'stdout':json.dumps(combined)})()
                else:
                    output=run(['node','scripts/container-smoke.mjs',connector,port,image,credentials[connector]])
            except subprocess.CalledProcessError as error:
                raise RuntimeError(f'{connector} SDK smoke failed: {error.stderr}') from None
            receipt['checks'].append(json.loads(output.stdout.strip().splitlines()[-1]))
            docker(['rm','-f',name]);owned.remove(name)
        manifest=p/'manifest.json';manifest.write_text((ROOT/'fixtures/catalog.v1.json').read_text());manifest.chmod(0o644)
        name=PREFIX+'-catalog';owned.append(name)
        docker(['run','-d','--name',name,*common,'-p','127.0.0.1::8080','--mount',f'type=bind,src={p},dst=/fixture,readonly','-e','MCP_CATALOG_MANIFEST=/fixture/manifest.json','-e','MCP_ACCESS_TOKEN=synthetic-catalog-token','-e','MCP_ALLOWED_HOSTS=127.0.0.1','mcp-task3b/catalog:test'])
        port=docker(['port',name,'8080/tcp']).rsplit(':',1)[1];ready(f'http://127.0.0.1:{port}/health')
        req=urllib.request.Request(f'http://127.0.0.1:{port}/catalog/v1/servers',headers={'Authorization':'Bearer synthetic-catalog-token'})
        with urllib.request.urlopen(req) as response: assert len(json.load(response)['servers'])==7
        updated=p/'next.json';updated.write_text('invalid');updated.replace(manifest)
        ready(f'http://127.0.0.1:{port}/health',503)
        try:urllib.request.urlopen(req);raise AssertionError('Invalid manifest accepted')
        except urllib.error.HTTPError as error:assert error.code==503
        updated.write_text('{"schemaVersion":1,"servers":[]}');updated.replace(manifest)
        ready(f'http://127.0.0.1:{port}/health')
        with urllib.request.urlopen(req) as response:assert json.load(response)['servers']==[]
        receipt['catalogReload']=True
    output=os.environ.get('MCP_CONTAINER_RECEIPT')
    if output:pathlib.Path(output).write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt,indent=2))
except subprocess.CalledProcessError as error:
    # Output only Docker/build diagnostics; this harness never prints command argv containing test credentials.
    raise RuntimeError(error.stderr) from None
finally:
    for name in reversed(owned):subprocess.run(['docker','rm','-f',name],capture_output=True)
    if network:subprocess.run(['docker','network','rm',PREFIX],capture_output=True)
