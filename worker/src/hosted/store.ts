import { z } from 'zod';
import { parsePairingId, type PairingId } from '../../../src/core/chatgpt/bridge';
import { parseHostId, parseIssuedClientId, parseSubject, type HostId, type IssuedClientId, type Subject } from '../../../src/core/chatgpt/oauth';
import { SIGN_IN_OUTCOMES, type ChatGptModel, type ChatGptNotice, type ChatGptPauseCode } from '../../../src/core/tutor/contract';
import type { SiteUserId } from '../sites/boundary';

/**
 * The hosted account's one D1 row (`chatgpt_account`, id = 1, drizzle/0001). Every write is one named statement whose
 * WHERE clause is the guard and whose `changes === 1` says it applied. A stale read can only make a guard miss.
 *
 *  - `intent` names the newest pairing start; `pairing_*` is written only while it is still ours.
 *  - `rev` names one stored token set. `lease_id` grants the right to send that set's refresh token once.
 *    `refresh_state = 'indeterminate'` means a send for this rev may have rotated upstream: nobody may send it again.
 *  - `generation` names one session; pause and model cache are written only for the current one.
 *  - `op` names the newest start or disconnect, so a slow revocation cannot overwrite a newer notice.
 *  - `owner_user_id` is claimed by the first install and never cleared, not even by a forgetting disconnect.
 */

/** The subset of D1 this store uses. `D1Database` and `D1DatabaseSession` both satisfy it. */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
}
export interface D1Handle {
  prepare(query: string): D1Statement;
}
export interface D1Like extends D1Handle {
  withSession?(constraint: 'first-primary'): D1Handle;
}

const RevSchema = z.uuid().brand<'Rev'>();
const LeaseIdSchema = z.uuid().brand<'LeaseId'>();
/** One stored token set. Minted per write, refreshes included. */
export type Rev = z.output<typeof RevSchema>;
/** One claim of the right to send a rev's refresh token. */
export type LeaseId = z.output<typeof LeaseIdSchema>;
export const newRev = (): Rev => RevSchema.parse(crypto.randomUUID());
export const newLeaseId = (): LeaseId => LeaseIdSchema.parse(crypto.randomUUID());

export interface Registration {
  clientId: IssuedClientId;
  subject: Subject | null;
  email: string | null;
  planDisabled: boolean;
}
export interface StoredCreds {
  rev: Rev;
  clientId: IssuedClientId;
  sealed: string;
}
export interface Pairing {
  id: PairingId;
  userId: SiteUserId;
  createdAt: number;
  expiresAt: number;
  /** `new` registers through the dynamic client; `reauth` reuses the saved one. */
  purpose: 'new' | 'reauth';
  clientId: IssuedClientId | null;
  /** AES-GCM of the pairing's private key and nonce, under the server seal key. */
  sealed: string;
}
export interface AccountRow {
  hostId: HostId;
  ownerUserId: SiteUserId | null;
  generation: number;
  op: number;
  registration: Registration | null;
  creds: StoredCreds | null;
  refreshState: 'ok' | 'indeterminate';
  lease: { id: LeaseId; until: number } | null;
  intent: PairingId | null;
  pairing: Pairing | null;
  model: string | null;
  models: { generation: number; list: ChatGptModel[] } | null;
  pause: { code: ChatGptPauseCode; since: number } | null;
  notice: ChatGptNotice | null;
}
export type SessionEndReason = Extract<ChatGptNotice, { kind: 'session-ended' }>['reason'];

const branded = <T>(parse: (raw: unknown) => T | null) => z.string().transform((v, ctx) => parse(v) ?? (ctx.addIssue({ code: 'custom' }), z.NEVER));
const userIdSchema = z.string().min(1).transform((v) => v as SiteUserId);
const SIGN_IN_OUTCOME_SCHEMA = z.enum(SIGN_IN_OUTCOMES);

/** A JSON column that is never compared: unreadable means absent, never a thrown read. */
const jsonColumn = <S extends z.ZodType>(schema: S) =>
  z.string().nullable().transform((raw): z.output<S> | null => {
    if (raw === null) return null;
    try {
      const r = schema.safeParse(JSON.parse(raw));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  });

const ModelListSchema = z.array(z.object({ slug: z.string(), displayName: z.string() }));
const PauseSchema = z.object({ code: z.enum(['usage-limit', 'not-eligible']), since: z.number() });
const NoticeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sign-in'), outcome: SIGN_IN_OUTCOME_SCHEMA, at: z.number() }),
  z.object({ kind: z.literal('session-ended'), reason: z.enum(['refresh-rejected', 'refresh-indeterminate', 'invalid-client', 'unreadable']), at: z.number() }),
  z.object({ kind: z.literal('disconnected'), remoteRevoked: z.boolean().nullable(), at: z.number() }),
]);

const RowSchema = z
  .object({
    host_id: branded(parseHostId),
    owner_user_id: userIdSchema.nullable(),
    generation: z.number().int(),
    op: z.number().int(),
    client_id: branded(parseIssuedClientId).nullable(),
    subject: branded(parseSubject).nullable(),
    email: z.string().max(320).nullable(),
    plan_disabled: z.number().int(),
    rev: RevSchema.nullable(),
    creds_client_id: branded(parseIssuedClientId).nullable(),
    creds_sealed: z.string().nullable(),
    refresh_state: z.enum(['ok', 'indeterminate']),
    lease_id: LeaseIdSchema.nullable(),
    lease_until: z.number().int().nullable(),
    intent: branded(parsePairingId).nullable(),
    pairing_id: branded(parsePairingId).nullable(),
    pairing_user_id: userIdSchema.nullable(),
    pairing_created_at: z.number().int().nullable(),
    pairing_expires_at: z.number().int().nullable(),
    pairing_purpose: z.enum(['new', 'reauth']).nullable(),
    pairing_client_id: branded(parseIssuedClientId).nullable(),
    pairing_sealed: z.string().nullable(),
    model: z.string().nullable(),
    models_json: jsonColumn(ModelListSchema),
    models_generation: z.number().int().nullable(),
    pause_json: jsonColumn(PauseSchema),
    notice_json: jsonColumn(NoticeSchema),
  })
  .transform(
    (r): AccountRow => ({
      hostId: r.host_id,
      ownerUserId: r.owner_user_id,
      generation: r.generation,
      op: r.op,
      registration: r.client_id ? { clientId: r.client_id, subject: r.subject, email: r.email, planDisabled: r.plan_disabled === 1 } : null,
      creds: r.rev && r.creds_client_id && r.creds_sealed ? { rev: r.rev, clientId: r.creds_client_id, sealed: r.creds_sealed } : null,
      refreshState: r.refresh_state,
      lease: r.lease_id && r.lease_until !== null ? { id: r.lease_id, until: r.lease_until } : null,
      intent: r.intent,
      pairing:
        r.pairing_id && r.pairing_user_id && r.pairing_created_at !== null && r.pairing_expires_at !== null && r.pairing_purpose && r.pairing_sealed
          ? { id: r.pairing_id, userId: r.pairing_user_id, createdAt: r.pairing_created_at, expiresAt: r.pairing_expires_at, purpose: r.pairing_purpose, clientId: r.pairing_client_id, sealed: r.pairing_sealed }
          : null,
      model: r.model,
      models: r.models_json && r.models_generation !== null ? { generation: r.models_generation, list: r.models_json } : null,
      pause: r.pause_json,
      notice: r.notice_json,
    }),
  );

const PAIRING_CLEARED = `pairing_id = NULL, pairing_user_id = NULL, pairing_created_at = NULL, pairing_expires_at = NULL, pairing_purpose = NULL, pairing_client_id = NULL, pairing_sealed = NULL`;
const SESSION_CLEARED = `rev = NULL, creds_client_id = NULL, creds_sealed = NULL, refresh_state = 'ok', lease_id = NULL, lease_until = NULL, pause_json = NULL, models_json = NULL, models_generation = NULL, generation = generation + 1`;

const json = (v: unknown): string => JSON.stringify(v);

export class HostedStore {
  readonly #db: D1Handle;

  /** One store per operation: with read replication, a `first-primary` session starts on the primary and never reads older than its own writes. */
  constructor(db: D1Like) {
    this.#db = db.withSession ? db.withSession('first-primary') : db;
  }

  async #run(sql: string, ...values: unknown[]): Promise<boolean> {
    const r = await this.#db.prepare(sql).bind(...values).run();
    return r.meta.changes === 1;
  }

  /** Never writes. An absent row is null; `ensureRow` creates it when a write needs one. */
  async read(): Promise<AccountRow | null> {
    const raw = await this.#db.prepare(`/* read */ SELECT * FROM chatgpt_account WHERE id = 1`).first();
    if (raw === null) return null;
    const r = RowSchema.safeParse(raw);
    if (!r.success) throw new Error('chatgpt_account row is unreadable');
    return r.data;
  }

  /** Concurrent first writers converge on one host id. */
  async ensureRow(hostId: HostId): Promise<void> {
    await this.#db.prepare(`/* ensureRow */ INSERT OR IGNORE INTO chatgpt_account (id, host_id) VALUES (1, ?)`).bind(hostId).run();
  }

  /** Stamps the newest start and drops any older pairing (its private key with it). */
  beginPairing(a: { intent: PairingId; user: SiteUserId }): Promise<boolean> {
    return this.#run(
      `/* beginPairing */ UPDATE chatgpt_account SET intent = ?, ${PAIRING_CLEARED}, op = op + 1 WHERE id = 1 AND (owner_user_id IS NULL OR owner_user_id = ?)`,
      a.intent,
      a.user,
    );
  }

  storePairing(p: Pairing): Promise<boolean> {
    return this.#run(
      `/* storePairing */ UPDATE chatgpt_account SET pairing_id = ?, pairing_user_id = ?, pairing_created_at = ?, pairing_expires_at = ?, pairing_purpose = ?, pairing_client_id = ?, pairing_sealed = ? WHERE id = 1 AND intent = ?`,
      p.id,
      p.userId,
      p.createdAt,
      p.expiresAt,
      p.purpose,
      p.clientId,
      p.sealed,
      p.id,
    );
  }

  /** Compare-and-swap on the sealed key just read: exactly one upload wins, and the key then exists only in its memory. */
  consumePairing(a: { pairingId: PairingId; user: SiteUserId; sealed: string; now: number }): Promise<boolean> {
    return this.#run(
      `/* consumePairing */ UPDATE chatgpt_account SET ${PAIRING_CLEARED} WHERE id = 1 AND pairing_id = ? AND pairing_user_id = ? AND pairing_sealed = ? AND pairing_expires_at > ?`,
      a.pairingId,
      a.user,
      a.sealed,
      a.now,
    );
  }

  /** Ends a pairing attempt without installing anything. */
  settlePairing(a: { intent: PairingId; notice: ChatGptNotice }): Promise<boolean> {
    return this.#run(`/* settlePairing */ UPDATE chatgpt_account SET intent = NULL, ${PAIRING_CLEARED}, notice_json = ? WHERE id = 1 AND intent = ?`, json(a.notice), a.intent);
  }

  /** A new session: fresh generation, `ok` refresh state, no lease, and the owner claimed if still unclaimed. */
  install(a: { intent: PairingId; user: SiteUserId; expectRev: Rev | null; next: StoredCreds; registration: Registration; notice: ChatGptNotice }): Promise<boolean> {
    return this.#run(
      `/* install */ UPDATE chatgpt_account SET generation = generation + 1, rev = ?, creds_client_id = ?, creds_sealed = ?, refresh_state = 'ok', lease_id = NULL, lease_until = NULL, client_id = ?, subject = ?, email = ?, plan_disabled = ?, owner_user_id = COALESCE(owner_user_id, ?), models_json = NULL, models_generation = NULL, pause_json = NULL, intent = NULL, ${PAIRING_CLEARED}, notice_json = ? WHERE id = 1 AND intent = ? AND rev IS ? AND (owner_user_id IS NULL OR owner_user_id = ?)`,
      a.next.rev,
      a.next.clientId,
      a.next.sealed,
      a.registration.clientId,
      a.registration.subject,
      a.registration.email,
      a.registration.planDisabled ? 1 : 0,
      a.user,
      json(a.notice),
      a.intent,
      a.expectRev,
      a.user,
    );
  }

  /** The right to send this rev's refresh token. Only from `ok` with no lease at all: an expired lease is not free. */
  claimRefresh(a: { rev: Rev; leaseId: LeaseId; until: number }): Promise<boolean> {
    return this.#run(
      `/* claimRefresh */ UPDATE chatgpt_account SET lease_id = ?, lease_until = ? WHERE id = 1 AND rev = ? AND refresh_state = 'ok' AND lease_id IS NULL`,
      a.leaseId,
      a.until,
      a.rev,
    );
  }

  /** No time check: a holder whose lease ran out may still commit, since nobody else could have sent this rev. */
  commitRefresh(a: { rev: Rev; leaseId: LeaseId; next: { rev: Rev; sealed: string } }): Promise<boolean> {
    return this.#run(
      `/* commitRefresh */ UPDATE chatgpt_account SET rev = ?, creds_sealed = ?, lease_id = NULL, lease_until = NULL, refresh_state = 'ok' WHERE id = 1 AND rev = ? AND lease_id = ?`,
      a.next.rev,
      a.next.sealed,
      a.rev,
      a.leaseId,
    );
  }

  /** The send definitely did not spend the token (a complete 3xx, 429 or other 4xx answer). */
  releaseRefresh(a: { rev: Rev; leaseId: LeaseId }): Promise<boolean> {
    return this.#run(`/* releaseRefresh */ UPDATE chatgpt_account SET lease_id = NULL, lease_until = NULL, refresh_state = 'ok' WHERE id = 1 AND rev = ? AND lease_id = ?`, a.rev, a.leaseId);
  }

  /** The send may have rotated upstream. The current access token keeps working; nobody sends this rev again. */
  markIndeterminate(a: { rev: Rev; leaseId: LeaseId }): Promise<boolean> {
    return this.#run(`/* markIndeterminate */ UPDATE chatgpt_account SET refresh_state = 'indeterminate', lease_id = NULL, lease_until = NULL WHERE id = 1 AND rev = ? AND lease_id = ?`, a.rev, a.leaseId);
  }

  /** A waiter gives up on a silent holder. The lease id stays, so that holder's late commit still lands. */
  abandonStaleLease(a: { rev: Rev; leaseId: LeaseId; now: number }): Promise<boolean> {
    return this.#run(
      `/* abandonStaleLease */ UPDATE chatgpt_account SET refresh_state = 'indeterminate' WHERE id = 1 AND rev = ? AND lease_id = ? AND lease_until < ? AND refresh_state = 'ok'`,
      a.rev,
      a.leaseId,
      a.now,
    );
  }

  /** Only the lease holder ends a rev from a refresh answer. `dropRegistration` forgets a client the issuer refused. */
  endSessionByRefresh(a: { rev: Rev; leaseId: LeaseId; dropRegistration: boolean; notice: ChatGptNotice }): Promise<boolean> {
    return this.#run(
      `/* endSessionByRefresh */ UPDATE chatgpt_account SET ${SESSION_CLEARED}, client_id = CASE WHEN ?1 AND client_id = creds_client_id THEN NULL ELSE client_id END, subject = CASE WHEN ?1 AND client_id = creds_client_id THEN NULL ELSE subject END, email = CASE WHEN ?1 AND client_id = creds_client_id THEN NULL ELSE email END, notice_json = ?2 WHERE id = 1 AND rev = ?3 AND lease_id = ?4`,
      a.dropRegistration ? 1 : 0,
      json(a.notice),
      a.rev,
      a.leaseId,
    );
  }

  /** The access token is gone and its refresh is unresolved: ask for a new pairing. */
  endIndeterminateSession(a: { rev: Rev; notice: ChatGptNotice }): Promise<boolean> {
    return this.#run(`/* endIndeterminateSession */ UPDATE chatgpt_account SET ${SESSION_CLEARED}, notice_json = ? WHERE id = 1 AND rev = ? AND refresh_state = 'indeterminate'`, json(a.notice), a.rev);
  }

  /** The sealed set does not open under this server's key. */
  endUnreadableSession(a: { rev: Rev; notice: ChatGptNotice }): Promise<boolean> {
    return this.#run(`/* endUnreadableSession */ UPDATE chatgpt_account SET ${SESSION_CLEARED}, notice_json = ? WHERE id = 1 AND rev = ?`, json(a.notice), a.rev);
  }

  /**
   * Clears exactly the token set the caller read (`rev IS expectRev`), so a refresh that commits first makes this miss and
   * retry instead of clearing a set it never revokes. The owner stays bound, `forget` included. Returns the new op.
   */
  async disconnect(a: { expectRev: Rev | null; forget: boolean; notice: ChatGptNotice | null }): Promise<number | null> {
    const r = await this.#db
      .prepare(
        `/* disconnect */ UPDATE chatgpt_account SET ${SESSION_CLEARED}, intent = NULL, ${PAIRING_CLEARED}, client_id = CASE WHEN ?1 THEN NULL ELSE client_id END, subject = CASE WHEN ?1 THEN NULL ELSE subject END, email = CASE WHEN ?1 THEN NULL ELSE email END, plan_disabled = CASE WHEN ?1 THEN 0 ELSE plan_disabled END, model = CASE WHEN ?1 THEN NULL ELSE model END, op = op + 1, notice_json = COALESCE(?2, notice_json) WHERE id = 1 AND rev IS ?3 RETURNING op`,
      )
      .bind(a.forget ? 1 : 0, a.notice === null ? null : json(a.notice), a.expectRev)
      .first<{ op: number }>();
    return r?.op ?? null;
  }

  setPause(a: { generation: number; pause: { code: ChatGptPauseCode; since: number } }): Promise<boolean> {
    return this.#run(`/* setPause */ UPDATE chatgpt_account SET pause_json = ? WHERE id = 1 AND generation = ? AND rev IS NOT NULL`, json(a.pause), a.generation);
  }

  clearPause(a: { generation: number }): Promise<boolean> {
    return this.#run(`/* clearPause */ UPDATE chatgpt_account SET pause_json = NULL WHERE id = 1 AND generation = ?`, a.generation);
  }

  cacheModels(a: { generation: number; models: ChatGptModel[] }): Promise<boolean> {
    return this.#run(`/* cacheModels */ UPDATE chatgpt_account SET models_json = ?2, models_generation = ?1 WHERE id = 1 AND generation = ?1 AND rev IS NOT NULL`, a.generation, json(a.models));
  }

  selectModel(a: { generation: number; slug: string }): Promise<boolean> {
    return this.#run(`/* selectModel */ UPDATE chatgpt_account SET model = ? WHERE id = 1 AND generation = ? AND rev IS NOT NULL`, a.slug, a.generation);
  }

  /** Only the newest start or disconnect may replace the notice. */
  putNotice(a: { op: number; notice: ChatGptNotice }): Promise<boolean> {
    return this.#run(`/* putNotice */ UPDATE chatgpt_account SET notice_json = ? WHERE id = 1 AND op = ?`, json(a.notice), a.op);
  }
}
