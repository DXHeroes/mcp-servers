export interface Contact {
  id: string;
  name: string;
  email?: string;
  company?: string;
}

export class ContactStore {
  readonly #contacts = new Map<string, Contact>();

  list(): Contact[] {
    return [...this.#contacts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Contact | undefined {
    return this.#contacts.get(id);
  }

  create(input: Omit<Contact, 'id'>): Contact {
    const contact = { id: crypto.randomUUID(), ...input };
    this.#contacts.set(contact.id, contact);
    return contact;
  }
}
