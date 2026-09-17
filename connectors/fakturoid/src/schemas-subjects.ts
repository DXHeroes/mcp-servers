/**
 * Zod input schemas for subject (contact) tools.
 */

import { z } from 'zod';

// ── Subjects (Contacts) ───────────────────────────────────────────

export const ListSubjectsSchema = z.object({
  page: z.number().int().positive().optional().describe('Page number (starts at 1)'),
  since: z.string().optional().describe('Filter subjects created since this date'),
  updated_since: z.string().optional().describe('Filter subjects updated since this datetime'),
  custom_id: z.string().optional().describe('Filter by custom ID'),
});

export const GetSubjectSchema = z.object({
  id: z.number().int().positive().describe('Subject ID'),
});

export const CreateSubjectSchema = z.object({
  name: z.string().min(1).describe('Subject/company name'),
  custom_id: z.string().optional().describe('Custom identifier'),
  type: z.enum(['customer', 'supplier', 'both']).optional().describe('Subject type'),
  full_name: z.string().optional().describe('Full legal name'),
  street: z.string().optional().describe('Street address'),
  city: z.string().optional().describe('City'),
  zip: z.string().optional().describe('ZIP/postal code'),
  country: z.string().optional().describe('Country code (e.g., "CZ", "SK")'),
  registration_no: z.string().optional().describe('Company registration number (ICO)'),
  vat_no: z.string().optional().describe('VAT number (DIC, e.g., "CZ12345678")'),
  local_vat_no: z.string().optional().describe('Local VAT number'),
  email: z.string().optional().describe('Contact email'),
  email_copy: z.string().optional().describe('Email copy address'),
  phone: z.string().optional().describe('Contact phone'),
  web: z.string().optional().describe('Website URL'),
  bank_account: z.string().optional().describe('Bank account number'),
  iban: z.string().optional().describe('IBAN'),
  swift_bic: z.string().optional().describe('SWIFT/BIC code'),
  variable_symbol: z.string().optional().describe('Default variable symbol'),
  due: z.number().int().optional().describe('Default due days'),
  currency: z.string().optional().describe('Default currency code'),
  language: z.string().optional().describe('Default language (e.g., "cz", "en")'),
  private_note: z.string().optional().describe('Private note (internal only)'),
  note: z.string().optional().describe('Internal note'),
  has_delivery_address: z.boolean().optional().describe('Has separate delivery address'),
  delivery_name: z.string().optional().describe('Delivery name'),
  delivery_street: z.string().optional().describe('Delivery street'),
  delivery_city: z.string().optional().describe('Delivery city'),
  delivery_zip: z.string().optional().describe('Delivery ZIP code'),
  delivery_country: z.string().optional().describe('Delivery country code'),
});

export const SearchSubjectsSchema = z.object({
  query: z.string().min(1).describe('Search query (searches name, registration_no, etc.)'),
  page: z.number().int().positive().optional().describe('Page number'),
});

export const UpdateSubjectSchema = z.object({
  id: z.number().int().positive().describe('Subject ID'),
  name: z.string().optional().describe('Subject/company name'),
  custom_id: z.string().optional().describe('Custom identifier'),
  type: z.enum(['customer', 'supplier', 'both']).optional().describe('Subject type'),
  full_name: z.string().optional().describe('Full legal name'),
  street: z.string().optional().describe('Street address'),
  city: z.string().optional().describe('City'),
  zip: z.string().optional().describe('ZIP/postal code'),
  country: z.string().optional().describe('Country code (e.g., "CZ", "SK")'),
  registration_no: z.string().optional().describe('Company registration number (ICO)'),
  vat_no: z.string().optional().describe('VAT number (DIC, e.g., "CZ12345678")'),
  local_vat_no: z.string().optional().describe('Local VAT number'),
  email: z.string().optional().describe('Contact email'),
  email_copy: z.string().optional().describe('Email copy address'),
  phone: z.string().optional().describe('Contact phone'),
  web: z.string().optional().describe('Website URL'),
  bank_account: z.string().optional().describe('Bank account number'),
  iban: z.string().optional().describe('IBAN'),
  swift_bic: z.string().optional().describe('SWIFT/BIC code'),
  variable_symbol: z.string().optional().describe('Default variable symbol'),
  due: z.number().int().optional().describe('Default due days'),
  currency: z.string().optional().describe('Default currency code'),
  language: z.string().optional().describe('Default language'),
  private_note: z.string().optional().describe('Private note (internal only)'),
  note: z.string().optional().describe('Internal note'),
  has_delivery_address: z.boolean().optional().describe('Has separate delivery address'),
  delivery_name: z.string().optional().describe('Delivery name'),
  delivery_street: z.string().optional().describe('Delivery street'),
  delivery_city: z.string().optional().describe('Delivery city'),
  delivery_zip: z.string().optional().describe('Delivery ZIP code'),
  delivery_country: z.string().optional().describe('Delivery country code'),
});

export const DeleteSubjectSchema = z.object({
  id: z.number().int().positive().describe('Subject ID'),
});
