/** Structural broker contract: no dependency on a private host/runtime package. */
import type { GmailMessageArgs } from './gmail-message.js';

export type ActionRoute = { adapter: string; agents: string[]; audiences: string[] };
export type ActionRecord = {
  id: string;
  route: string;
  key: string;
  kind: 'task' | 'idea';
  payload: Record<string, unknown>;
  evidence: unknown[];
  evidence_actors: string[];
  facts: { event: string; audience: string; [key: string]: unknown }[];
  actors: string[];
  steps: Record<string, { status: 'verified' | 'intent'; [key: string]: unknown }>;
  status: string;
  created_at: string;
};
export type StepRead =
  | { status: 'found'; receipt: unknown }
  | { status: 'absent' }
  | { status: 'unknown' | 'conflict'; reason?: string };
export type ActionStep = { key: string; read(): Promise<StepRead>; write(): Promise<unknown> };
export type ActionAdapter = {
  validate(payload: Record<string, unknown>, route: ActionRoute): void;
  steps(record: ActionRecord, route: ActionRoute): ActionStep[];
};
export type MailGateway = { call(alias: string, args: Record<string, unknown>): Promise<unknown> };
export type MailSettings = {
  gateway: MailGateway;
  reader: MailGateway;
  actor: string;
  mailbox: string;
  sender: string;
  replyTo?: string;
  senderDisplayName?: string;
  /** Trusted host capability. Throws unless current evidence grants this exact content hash. */
  authorize(record: ActionRecord, contentHash: string): Promise<void>;
};
export type PreparedMail = {
  operation: 'send' | 'reply';
  args: GmailMessageArgs;
  contentHash: string;
};
