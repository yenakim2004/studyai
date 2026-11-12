import { z } from 'zod';
import { AccessTokenSchema, HostIdSchema, IssuedClientIdSchema, RefreshTokenSchema, type ClientMode, type HostId } from './oauth';

/**
 * The encrypted file bridge between the user's laptop and their own hosted StudyAI. The host creates a pairing and hands
 * out a public request; the laptop signs in locally, then seals the grant to the request's key; the user uploads the
 * sealed file back to the same host. ECDH P-256 with an ephemeral sender key, HKDF-SHA-256, AES-256-GCM, all WebCrypto,
 * so it runs unchanged in Node and in workerd. The cipher gives confidentiality to the pairing key's holder and binds the
 * file to one pairing and host. It does not say who sealed it: the owner-gated upload and the ID-token check do that.
 * Opening is stateless, so the host's single-use pairing is what stops a replay.
 */

export const BRIDGE_FILE_MAX_BYTES = 64 * 1024;

const PairingIdSchema = z.uuid().brand<'PairingId'>();
/** Random, single-use, bound to one Site user in the host's row. */
export type PairingId = z.infer<typeof PairingIdSchema>;

const Base64UrlSchema = (bytes: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`));
const Coordinate = Base64UrlSchema(32);
const PublicJwkSchema = z.strictObject({ kty: z.literal('EC'), crv: z.literal('P-256'), x: Coordinate, y: Coordinate });
const PrivateJwkSchema = PublicJwkSchema.extend({ d: Coordinate });
/** Exactly `{kty, crv, x, y}` for P-256. A private member or anything extra is refused. */
type PublicP256Jwk = z.infer<typeof PublicJwkSchema>;

const NonceSchema = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/);
const ClientModeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('dynamic') }),
  z.strictObject({ kind: z.literal('issued'), clientId: IssuedClientIdSchema, loginHint: z.string().min(1).max(320).nullable() }),
]);

const PairingRequestSchema = z.strictObject({
  v: z.literal('studyai-pairing/1'),
  pairingId: PairingIdSchema,
  hostId: HostIdSchema,
  nonce: NonceSchema,
  client: ClientModeSchema,
  forceConsent: z.boolean(),
  publicKey: PublicJwkSchema,
  expiresAt: z.number().int().positive(),
});

/** Downloaded from the user's own Site. Not secret: a public key and identifiers. */
export interface PairingRequest {
  v: 'studyai-pairing/1';
  pairingId: PairingId;
  hostId: HostId;
  /** Minted by the host; the laptop signs in with it and the host checks it in the transferred ID token. */
  nonce: string;
  client: ClientMode;
  forceConsent: boolean;
  publicKey: JsonWebKey;
  /** Epoch ms, host clock. */
  expiresAt: number;
}

/** What the host rebuilds from its own row to open a file, never read from the file. */
export type PairingBinding = Pick<PairingRequest, 'pairingId' | 'hostId'>;

const SealedConnectionSchema = z.strictObject({
  v: z.literal('studyai-connection/1'),
  pairingId: PairingIdSchema,
  epk: PublicJwkSchema,
  iv: Base64UrlSchema(12),
  ct: z.string().regex(/^[A-Za-z0-9_-]{22,65536}$/),
});

/** Written by the laptop, uploaded by the browser as opaque text. */
export interface SealedConnection {
  v: 'studyai-connection/1';
  pairingId: PairingId;
  epk: JsonWebKey;
  iv: string;
  ct: string;
}

const ConnectionPayloadSchema = z.strictObject({
  clientId: IssuedClientIdSchema,
  idToken: z.string().min(1).max(16 * 1024),
  accessToken: AccessTokenSchema,
  refreshToken: RefreshTokenSchema,
  expiresInS: z.number().int().positive().max(366 * 86_400),
  earliestRefreshAt: z.number().int().positive().nullable(),
  scopes: z.array(z.string().min(1).max(256)).max(64),
});

/** The plaintext. Exists only in the CLI's memory and inside one host request; never on disk, in a browser or in a log. */
export type ConnectionPayload = z.infer<typeof ConnectionPayloadSchema>;

export const parsePairingId = (raw: unknown): PairingId | null => {
  const r = PairingIdSchema.safeParse(raw);
  return r.success ? r.data : null;
};

export function newPairingId(): PairingId {
  const id = parsePairingId(crypto.randomUUID());
  if (!id) throw new Error('crypto.randomUUID returned a value that is not a UUID');
  return id;
}

/** A file's text (at most 64 KiB) or an already parsed JSON value. */
function boundedJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  if (raw.length > BRIDGE_FILE_MAX_BYTES || new TextEncoder().encode(raw).byteLength > BRIDGE_FILE_MAX_BYTES) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function parsePairingRequest(raw: unknown): PairingRequest | null {
  const r = PairingRequestSchema.safeParse(boundedJson(raw));
  return r.success ? r.data : null;
}

export function parseSealedConnection(raw: unknown): SealedConnection | null {
  const r = SealedConnectionSchema.safeParse(boundedJson(raw));
  return r.success ? r.data : null;
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const utf8 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(s));

/*
 * This file is type-checked against both the DOM lib (app, CLI, tests) and the Workers types (worker). They disagree on
 * WebCrypto signatures: Workers types return unions from generateKey/exportKey and spell ECDH's `public` as `$public`,
 * while the runtime takes the standard `public`. These helpers pin the standard shapes in one place.
 */
const newEcdhPair = async (): Promise<CryptoKeyPair> => (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair;
const exportJwk = async (key: CryptoKey): Promise<JsonWebKey> => (await crypto.subtle.exportKey('jwk', key)) as JsonWebKey;
const ecdhWith = (peer: CryptoKey) => ({ name: 'ECDH', public: peer }) as unknown as Parameters<SubtleCrypto['deriveBits']>[0];

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const publicPart = (jwk: JsonWebKey): PublicP256Jwk => PublicJwkSchema.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
const aadOf = (b: PairingBinding): Uint8Array<ArrayBuffer> => utf8(`studyai/connect/v1|${b.pairingId}|${b.hostId}`);

async function aesKey(privateKey: CryptoKey, peer: PublicP256Jwk, binding: PairingBinding, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const peerKey = await crypto.subtle.importKey('jwk', peer, ECDH, false, []);
  const shared = await crypto.subtle.deriveBits(ecdhWith(peerKey), privateKey, 256);
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(binding.pairingId), info: aadOf(binding) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

/** A fresh P-256 pair for one pairing. The host keeps the private half sealed with its row; the public half goes in the request. */
export async function newPairingKeys(): Promise<{ publicJwk: JsonWebKey; privateJwk: JsonWebKey }> {
  const priv = await exportJwk((await newEcdhPair()).privateKey);
  return { publicJwk: publicPart(priv), privateJwk: PrivateJwkSchema.parse({ ...publicPart(priv), d: priv.d }) };
}

/** Rejects when the request's public key is not a point on P-256. */
export async function sealConnection(req: PairingRequest, payload: ConnectionPayload): Promise<SealedConnection> {
  const recipient = PublicJwkSchema.parse(req.publicKey);
  const body = ConnectionPayloadSchema.parse(payload);
  const binding: PairingBinding = { pairingId: req.pairingId, hostId: req.hostId };
  const ephemeral = await newEcdhPair();
  const key = await aesKey(ephemeral.privateKey, recipient, binding, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadOf(binding) }, key, utf8(JSON.stringify(body)));
  return {
    v: 'studyai-connection/1',
    pairingId: req.pairingId,
    epk: publicPart(await exportJwk(ephemeral.publicKey)),
    iv: toBase64Url(iv),
    ct: toBase64Url(new Uint8Array(ct)),
  };
}

/** Null for anything that does not decrypt under this binding and key, or whose plaintext is not a valid payload. */
export async function openConnection(binding: PairingBinding, privateJwk: JsonWebKey, sealed: SealedConnection): Promise<ConnectionPayload | null> {
  const priv = PrivateJwkSchema.safeParse(privateJwk);
  const file = SealedConnectionSchema.safeParse(sealed);
  if (!priv.success || !file.success || file.data.pairingId !== binding.pairingId) return null;
  try {
    const privateKey = await crypto.subtle.importKey('jwk', priv.data, ECDH, false, ['deriveBits']);
    const key = await aesKey(privateKey, file.data.epk, binding, 'decrypt');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(file.data.iv), additionalData: aadOf(binding) }, key, fromBase64Url(file.data.ct));
    const payload = ConnectionPayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(plain)));
    return payload.success ? payload.data : null;
  } catch {
    return null;
  }
}
