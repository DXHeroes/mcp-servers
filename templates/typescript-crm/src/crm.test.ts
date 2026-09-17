import assert from 'node:assert/strict';
import test from 'node:test';
import { ContactStore } from './crm.js';

test('creates, sorts and retrieves contacts', () => {
  const store = new ContactStore();
  const zoe = store.create({ name: 'Zoe', email: 'zoe@example.test' });
  store.create({ name: 'Alice', company: 'Example' });
  assert.deepEqual(
    store.list().map((contact) => contact.name),
    ['Alice', 'Zoe'],
  );
  assert.deepEqual(store.get(zoe.id), zoe);
  assert.equal(store.get('missing'), undefined);
});
