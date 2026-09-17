/**
 * Unit tests for FakturoidMcpServer — MCP tool annotations.
 *
 * Split out of the original server.test.ts; shared fixtures live in
 * server.helpers.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakturoidMcpServer } from '../src/server.js';
import { createInitializedServer, resetMocks } from './server.helpers.js';

// Module mocks are hoisted per file, so this call cannot be shared through the
// helper - only the factory body it delegates to.
vi.mock('../src/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/client.js')>();
  const { mockClientModule } = await import('./server.helpers.js');
  return mockClientModule(original);
});

describe('FakturoidMcpServer', () => {
  beforeEach(() => {
    resetMocks();
  });

  // ── MCP annotations ──────────────────────────────────────────
  //
  // The connector host classifies tools purely by `annotations.readOnlyHint`. With no
  // annotations every tool lands in the write group, so an operator cannot
  // allow the listings while gating the deletes — on accounting data that is
  // the difference between a usable tool set and one nobody connects.

  describe('tool annotations', () => {
    let server: FakturoidMcpServer;

    beforeEach(async () => {
      server = await createInitializedServer();
    });

    it('should annotate every tool, so none defaults into the write group', async () => {
      const tools = await server.listTools();
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toBeDefined();
        expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      }
    });

    it('should keep the three annotation groups pinned, not floored', async () => {
      // Pinned counts, deliberately. A floor would let a tool quietly lose its
      // annotation and fall into the write group unnoticed, which is exactly
      // the failure this block exists to catch. The groups partition the tool
      // set: 11 destructive + 10 additive writes + 24 read-only = 45.
      const tools = await server.listTools();
      const destructive = tools.filter((t) => t.annotations?.destructiveHint === true);
      const additiveWrites = tools.filter(
        (t) => t.annotations?.readOnlyHint === false && t.annotations?.destructiveHint === false,
      );
      const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true);

      expect(destructive.length).toBe(11);
      expect(additiveWrites.length).toBe(10);
      expect(readOnly.length).toBe(24);
      expect(destructive.length + additiveWrites.length + readOnly.length).toBe(tools.length);
    });

    it('should mark every destructive tool as destructive in its description', async () => {
      const tools = await server.listTools();
      const destructive = tools.filter((t) => t.annotations?.destructiveHint === true);
      // Pinned here too, so the loop cannot pass by iterating over nothing —
      // which is exactly what happens if the annotations stop being propagated.
      expect(destructive.length).toBe(11);
      for (const tool of destructive) {
        expect(tool.description, tool.name).toContain('DESTRUCTIVE');
      }
    });

    it('should mark every delete tool destructive and not read-only', async () => {
      const tools = await server.listTools();
      const deletes = tools.filter((t) => t.name.includes('_delete_'));
      expect(deletes.length).toBe(5);
      for (const tool of deletes) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
        expect(tool.annotations?.destructiveHint, tool.name).toBe(true);
      }
    });

    it('should annotate the destructive tools that are not named delete', async () => {
      // Checked by name so the set cannot shrink silently. A guard keyed on
      // `_delete_` alone would let the update family keep a "nothing is lost"
      // annotation while overwriting values no caller here can read back, and
      // would wave through an email that reaches a customer.
      const tools = await server.listTools();
      for (const name of [
        'fakturoid_update_invoice',
        'fakturoid_update_subject',
        'fakturoid_update_expense',
        'fakturoid_update_inventory_item',
        'fakturoid_invoice_action',
        'fakturoid_send_invoice_message',
      ]) {
        const tool = tools.find((t) => t.name === name);
        expect(tool?.annotations?.destructiveHint, name).toBe(true);
        expect(tool?.annotations?.readOnlyHint, name).toBe(false);
      }
    });

    it('should name every read-only tool, so a write cannot claim to be one', async () => {
      const tools = await server.listTools();
      const readOnly = [
        'fakturoid_get_account',
        'fakturoid_list_users',
        'fakturoid_list_bank_accounts',
        'fakturoid_list_invoices',
        'fakturoid_get_invoice',
        'fakturoid_search_invoices',
        'fakturoid_list_subjects',
        'fakturoid_get_subject',
        'fakturoid_search_subjects',
        'fakturoid_list_expenses',
        'fakturoid_get_expense',
        'fakturoid_search_expenses',
        'fakturoid_list_inventory_items',
        'fakturoid_get_inventory_item',
        'fakturoid_search_inventory_items',
        'fakturoid_list_inventory_moves',
        'fakturoid_list_generators',
        'fakturoid_get_generator',
        'fakturoid_list_recurring_generators',
        'fakturoid_get_recurring_generator',
        'fakturoid_list_events',
        'fakturoid_list_todos',
        'fakturoid_list_number_formats',
        'fakturoid_list_tags',
      ];
      for (const name of readOnly) {
        const tool = tools.find((t) => t.name === name);
        expect(tool?.annotations?.readOnlyHint, name).toBe(true);
      }
      expect(tools.filter((t) => t.annotations?.readOnlyHint === true).length).toBe(
        readOnly.length,
      );
    });

    it('should not mark a reversible write as destructive', async () => {
      // These three write, and are still additive under the definition used
      // here: a create loses nothing, and lock/unlock and the todo toggle each
      // have their exact inverse in this same tool set.
      const tools = await server.listTools();
      for (const name of [
        'fakturoid_create_invoice',
        'fakturoid_expense_action',
        'fakturoid_toggle_todo',
      ]) {
        const tool = tools.find((t) => t.name === name);
        expect(tool?.annotations?.readOnlyHint, name).toBe(false);
        expect(tool?.annotations?.destructiveHint, name).toBe(false);
      }
    });

    it('should never mark a destructive tool read-only', async () => {
      const tools = await server.listTools();
      for (const tool of tools.filter((t) => t.annotations?.destructiveHint === true)) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
      }
    });
  });
});
