import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const installationChecks = sqliteTable('installation_checks', {
  key: text('key').primaryKey(),
  value: integer('value').notNull(),
});

export const chatGptAccount = sqliteTable('chatgpt_account', {
  id: integer('id').primaryKey(),
  hostId: text('host_id').notNull(),
  ownerUserId: text('owner_user_id'),
  generation: integer('generation').notNull().default(0),
  op: integer('op').notNull().default(0),
  clientId: text('client_id'),
  subject: text('subject'),
  email: text('email'),
  planDisabled: integer('plan_disabled').notNull().default(0),
  rev: text('rev'),
  credsClientId: text('creds_client_id'),
  credsSealed: text('creds_sealed'),
  refreshState: text('refresh_state', { enum: ['ok', 'indeterminate'] }).notNull().default('ok'),
  leaseId: text('lease_id'),
  leaseUntil: integer('lease_until'),
  intent: text('intent'),
  pairingId: text('pairing_id'),
  pairingUserId: text('pairing_user_id'),
  pairingCreatedAt: integer('pairing_created_at'),
  pairingExpiresAt: integer('pairing_expires_at'),
  pairingPurpose: text('pairing_purpose'),
  pairingClientId: text('pairing_client_id'),
  pairingSealed: text('pairing_sealed'),
  model: text('model'),
  modelsJson: text('models_json'),
  modelsGeneration: integer('models_generation'),
  pauseJson: text('pause_json'),
  noticeJson: text('notice_json'),
}, (table) => [
  check('single_installation', sql`${table.id} = 1`),
  check('refresh_state_valid', sql`${table.refreshState} IN ('ok', 'indeterminate')`),
]);
