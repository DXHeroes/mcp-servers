# Sender-bound mail actions

`@dxheroes/mcp-google/action-adapter` exports `createAdapter(settings)` and
`prepareMail(settings, record, route)`. This is a host extension for an existing durable
`ActionBroker`; it is not a standalone send queue. It has no private runtime dependency.
Version 0.4.0 is source-prepared and private, not a published npm release.

## Host contract

`createAdapter` returns the structural `ActionAdapter { validate, steps }` contract. Each
step has `key`, `read()` and `write()`. The broker must persist its intent before calling
write and never repeat write for an existing intent. Install one adapter per sender route:

```ts
createAdapter({
  actor: 'agent-a',
  mailbox: 'sender@example.test',
  sender: 'sender@example.test',
  replyTo: 'reply@example.test', // optional
  senderDisplayName: 'Sender Name', // optional
  gateway, // host-only send gateway, not visible to the model
  reader, // trusted authenticated read gateway
  authorize, // async (record, contentHash): Promise<void>
});
```

Both gateways implement `call(alias, args): Promise<unknown>`. They return decoded MCP
structuredContent and throw for isError. The adapter additionally checks every read's
`mailbox = { emailAddress, verified: true, source: 'users.getProfile' }` against the host
mailbox. The host must provision read and send credentials for that same mailbox and
validate any send-as alias. The send-only grant cannot independently call getProfile.

| Capability | Alias | Connector tool | Endpoint / OAuth scope |
| --- | --- | --- | --- |
| `gateway` | `send` | `gmail_send_message` | `/gmail/mcp`, `gmail.send` |
| `gateway` | `reply` | `gmail_reply_message` | `/gmail/mcp`, `gmail.send` |
| `reader` | `findSent` | `gmail_find_sent_message` | `/gmail-read/mcp`, `gmail.readonly` |
| `reader` | `getMessage` | `gmail_get_message` | `/gmail-read/mcp`, `gmail.readonly` |
| `reader` | `getAttachment` | `gmail_get_attachment` | `/gmail-read/mcp`, `gmail.readonly` |

Aliases are fixed capability names; the host gateway maps them to installed tool names.
No credential, tool name, URL or authorization flag comes from an action payload.

The service's extension factory receives `{ ...installedAdapterSettings, gateway, sources }`.
JSON configuration cannot supply `reader` or `authorize` functions. Therefore its `module`
must point to an **installed host wrapper** that imports this factory, creates the separate
read gateway from host configuration, and supplies a real authorization function backed by
its source readers. Importing this package directly as that service module refuses startup
because the required functions are absent. No permissive fallback exists.

The controller installs the wrapper and its transitive bundle read-only under an approved
`module_roots`, outside every runtime/source workspace. The wrapper entry must be absolute,
a regular non-symlink file with one link and no write bits, per `installedModule()`. Agents
receive only their own bound action socket and read-only tools. The installation, artifact
verification, route/socket configuration and credential provisioning belong to the host.
This source change does not provision them or remove any existing tool grant.

## Proposal and approval

Allowed payload fields: `operation`, `to`, `cc`, `bcc`, `subject`, `text`, `html`,
`attachments`, `sourceMessageRef`. Unknown fields are rejected, including actor/from/mailbox,
replyTo, senderDisplayName, threadId, arbitrary headers, raw MIME and approval flags.
`send` requires subject and forbids sourceMessageRef. `reply` requires
`sourceMessageRef: { id: '<opaque message id>' }` and **forbids subject**. The reader derives
threadId, In-Reply-To, References and Subject from that message in the configured mailbox.
An existing Re: is preserved, otherwise Re: is prefixed. Invalid/duplicate source headers
refuse the reply. Recipients remain explicit approved proposal fields.

The route must contain exactly the installed actor. `record.actors` must be exactly that
actor and all evidence actors must match. Settings and proposal data are snapshotted;
changing bound action data after step creation refuses the write.

`prepareMail` is the host's review preview. It returns normalized provider arguments and a
SHA-256 `contentHash`. Hash input includes actor, mailbox, action ID, route, operation,
sourceMessageRef, derived reply headers, sender/alias/display name/replyTo, recipient lists,
subject, bodies and every attachment byte/name/type. It excludes MIME random boundaries and
Date. Recreate it with the same installed settings when recording a human approval.

Immediately before the provider write, `authorize(record, contentHash)` must freshly verify:

- explicit instruction by the authorized owner in the current source thread;
- exact approved action/hash and source evidence, expiry, revocation and current route grant;
- sender alias changes, recipient/body changes and any replay authorization;
- for an explicit replay, independently resolved original outcome plus a new authorization
  record and a new action ID. Restart alone does not authorize replay.

A colleague assignment, high-confidence meeting fact or Slack assignment is insufficient.
The callback throws on refusal and resolves **undefined** on success; other return values
are rejected. Missing capabilities refuse factory creation. A callback's implementation is
trusted host policy: this connector cannot infer authority from model text or invent it.
Approval rejection after the broker writes intent conservatively leaves an unresolved intent
without sending; the operator must resolve it before a new authorized proposal.

The adapter's payload ceiling is 128,000 JavaScript characters. The existing broker caps the
whole candidate at 128,000 characters, so envelope/evidence reduce usable content further.
The direct MIME tool's 1 MiB limit does not enlarge the action protocol.

## Recovery and limitations

A deterministic RFC Message-ID binds action/route/actor/mailbox to the installed sender's
domain. It is a lookup key, **not a provider idempotency promise**. Reads exhaust bounded
sent-search pagination (100 pages), validate mailbox proof and reject ambiguous matches.
A unique match must have SENT, the expected Message-ID, sender/display name, Reply-To,
To/Cc/Bcc, subject, thread for replies, In-Reply-To and References.

The adapter reads the exact found message, never treats a thread-reference page as message
content, and explicitly downloads **every MIME leaf** via getAttachment, including text
already decoded by getMessage. Thus ordinary complete flags, text cursors and attachment
references never stand in for actual bytes. It checks part IDs, sizes, type, filename,
attachment classification and canonical bytes against all expected bodies/attachments.
This uses bounded M01 leaf reads instead of iterating the ordinary text cursor; every leaf's
bytes are independently complete. A missing MIME projection, oversized/unreadable part,
unsupported header encoding, changed content, cursor loop, invalid response or lost read
refuses reconciliation. The adapter does not follow providerReference URLs or enlarge caps.
Conservative header/MIME equality can leave provider-normalized messages unresolved; the
operator investigates instead of resending. It supports UTF-8/ASCII encoded headers; unusual
address/header syntax is likewise unresolved.

With the current broker:

| Observation | Broker state | Durable step | Additional send |
| --- | --- | --- | --- |
| provider reply lost | `uncertain` | `intent` | none |
| complete search, zero matches after intent | `uncertain` | `intent` | none |
| partial/ambiguous/different/unreadable result | `blocked`, reason `send_outcome_unknown` | `intent` preserved if one exists | none |
| unique independently verified match | `completed` | `verified` | none |

A blocked label still represents unresolved send outcome when it retains intent. The monitor
and operator must not interpret it as permission to retry. Route/key revocation affects that
installed adapter; other routes keep their own capabilities. Rollback must retain bound From
and read-only model grants, never restore unrestricted send/draft-send/native mail tools.

## Offline acceptance

The Google suite includes actual local MCP HTTP through both endpoints and a local provider
HTTP peer that commits MIME then drops the response. The generic core consumer contract can
load the compiled factory using `AGENT_TEST_EXTERNAL_MAIL_MODULE`; it exercises the real
broker, durable intent, restart and one-send-only behavior over a local HTTP peer. Set
`AGENT_TEST_MAILBOX_PROOF=users.getProfile` for this adapter. Its default CI fixture is generic
and is not proof of an accepted connector artifact. The controller must run the same consumer
contract against the accepted signed artifact in owner CI before production activation.
Live mailbox identity/alias checks, actual source authorization, key isolation/revocation,
removal of alternative send paths and controlled own-mailbox acceptance remain host gates.
