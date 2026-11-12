import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BRIDGE_FILE_MAX_BYTES,
  newPairingId,
  newPairingKeys,
  openConnection,
  parsePairingRequest,
  parseSealedConnection,
  sealConnection,
  type ConnectionPayload,
  type PairingRequest,
  type SealedConnection,
} from '../src/core/chatgpt/bridge';
import { newHostId, parseAccessToken, parseIssuedClientId, parseRefreshToken } from '../src/core/chatgpt/oauth';

function must<T>(v: T | null): T {
  if (v === null) throw new Error('fixture did not parse');
  return v;
}

const payload: ConnectionPayload = {
  clientId: must(parseIssuedClientId('oaiapp_bridge1')),
  idToken: ['header', 'claims', 'signature'].map((part) => Buffer.from(part).toString('base64url')).join('.'),
  accessToken: must(parseAccessToken('at-secret-value')),
  refreshToken: must(parseRefreshToken('rt-secret-value')),
  expiresInS: 3599,
  earliestRefreshAt: null,
  scopes: ['openid', 'offline_access', 'chatgpt.tokens.use.direct'],
};

const requestFor = (publicKey: JsonWebKey, over: Partial<PairingRequest> = {}): PairingRequest => ({
  v: 'studyai-pairing/1',
  pairingId: newPairingId(),
  hostId: newHostId(),
  nonce: 'n'.repeat(43),
  client: { kind: 'dynamic' },
  forceConsent: false,
  publicKey,
  expiresAt: Date.UTC(2026, 10, 12, 6, 10),
  ...over,
});

async function pairing() {
  const keys = await newPairingKeys();
  const request = requestFor(keys.publicJwk);
  return { keys, request, binding: { pairingId: request.pairingId, hostId: request.hostId } };
}

const flip = (b64u: string, at = 5): string => {
  const c = b64u[at] === 'A' ? 'B' : 'A';
  return b64u.slice(0, at) + c + b64u.slice(at + 1);
};

describe('sealing a connection to one pairing', () => {
  it('opens only for the pairing it was sealed to, and returns the payload unchanged', async () => {
    const { keys, request, binding } = await pairing();
    const sealed = await sealConnection(request, payload);
    const file = must(parseSealedConnection(JSON.stringify(sealed)));
    expect(await openConnection(binding, keys.privateJwk, file)).toEqual(payload);
  });

  it('never carries the payload in clear text, and seals afresh each time', async () => {
    const { request } = await pairing();
    const a = JSON.stringify(await sealConnection(request, payload));
    const b = JSON.stringify(await sealConnection(request, payload));
    for (const secret of [payload.accessToken, payload.refreshToken, payload.idToken, payload.clientId]) expect(a).not.toContain(secret);
    expect(a).not.toBe(b);
  });

  it('refuses a wrong pairing id or host id in the binding, even with the right key', async () => {
    const { keys, request, binding } = await pairing();
    const sealed = await sealConnection(request, payload);
    expect(await openConnection({ ...binding, hostId: newHostId() }, keys.privateJwk, sealed)).toBeNull();
    expect(await openConnection({ ...binding, pairingId: newPairingId() }, keys.privateJwk, sealed)).toBeNull();
    const other = newPairingId();
    expect(await openConnection({ ...binding, pairingId: other }, keys.privateJwk, { ...sealed, pairingId: other })).toBeNull();
  });

  it("refuses another pairing's private key", async () => {
    const { request, binding } = await pairing();
    const sealed = await sealConnection(request, payload);
    expect(await openConnection(binding, (await newPairingKeys()).privateJwk, sealed)).toBeNull();
  });

  it('refuses a flipped ciphertext byte, a changed iv, a swapped or invalid ephemeral key and a truncated ciphertext', async () => {
    const { keys, request, binding } = await pairing();
    const sealed = await sealConnection(request, payload);
    const open = (s: SealedConnection) => openConnection(binding, keys.privateJwk, s);
    expect(await open({ ...sealed, ct: flip(sealed.ct, 10) })).toBeNull();
    expect(await open({ ...sealed, ct: flip(sealed.ct, sealed.ct.length - 3) })).toBeNull();
    expect(await open({ ...sealed, iv: flip(sealed.iv, 2) })).toBeNull();
    expect(await open({ ...sealed, epk: (await newPairingKeys()).publicJwk })).toBeNull();
    expect(await open({ ...sealed, epk: { ...sealed.epk, x: sealed.epk.y } })).toBeNull();
    expect(await open({ ...sealed, ct: sealed.ct.slice(0, 40) })).toBeNull();
    expect(await open(sealed)).toEqual(payload);
  });

  it('is stateless: the same file opens twice, so the host must refuse a replay by consuming the pairing once', async () => {
    const { keys, request, binding } = await pairing();
    const sealed = await sealConnection(request, payload);
    expect(await openConnection(binding, keys.privateJwk, sealed)).toEqual(payload);
    expect(await openConnection(binding, keys.privateJwk, sealed)).toEqual(payload);
  });

  it('refuses to seal to a key that is not on P-256, or an invalid payload', async () => {
    const { keys } = await pairing();
    const offCurve = { ...keys.publicJwk, y: keys.publicJwk.x };
    await expect(sealConnection(requestFor(offCurve), payload)).rejects.toThrow();
    await expect(sealConnection(requestFor(keys.publicJwk), { ...payload, expiresInS: 0 })).rejects.toThrow();
    await expect(sealConnection(requestFor(keys.publicJwk), { ...payload, accessToken: '' as ConnectionPayload['accessToken'] })).rejects.toThrow();
  });

  it('publishes exactly kty, crv, x and y as the public key, and keeps d only in the private key', async () => {
    const keys = await newPairingKeys();
    expect(Object.keys(keys.publicJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(Object.keys(keys.privateJwk).sort()).toEqual(['crv', 'd', 'kty', 'x', 'y']);
  });
});

describe('parsing the files at the boundary', () => {
  it('accepts a request as file text or as parsed JSON', async () => {
    const { request } = await pairing();
    expect(parsePairingRequest(JSON.stringify(request))).toEqual(request);
    expect(parsePairingRequest(request)).toEqual(request);
    const reauth = { ...request, client: { kind: 'issued', clientId: 'oaiapp_again', loginHint: 'me@example.test' }, forceConsent: true };
    expect(parsePairingRequest(JSON.stringify(reauth))).toEqual(reauth);
  });

  it('refuses a request with a private key, extra fields, or malformed members', async () => {
    const { keys, request } = await pairing();
    const bad: Record<string, unknown>[] = [
      { publicKey: keys.privateJwk },
      { publicKey: { ...keys.publicJwk, ext: true } },
      { publicKey: { ...keys.publicJwk, crv: 'P-384' } },
      { publicKey: { ...keys.publicJwk, x: 'short' } },
      { siteOrigin: 'https://attacker.example' },
      { v: 'studyai-pairing/2' },
      { pairingId: 'not-a-uuid' },
      { hostId: 'laptop' },
      { nonce: 'short' },
      { nonce: 'has spaces in it but is long enough' },
      { client: { kind: 'issued', clientId: 'dynamic_agent_client', loginHint: null } },
      { client: { kind: 'dynamic', clientId: 'oaiapp_x' } },
      { forceConsent: 'yes' },
      { expiresAt: -1 },
      { expiresAt: 1.5 },
    ];
    for (const over of bad) expect(parsePairingRequest(JSON.stringify({ ...request, ...over })), JSON.stringify(over)).toBeNull();
    const { expiresAt: _drop, ...missing } = request;
    expect(parsePairingRequest(JSON.stringify(missing))).toBeNull();
  });

  it('refuses text that is not JSON or is larger than 64 KiB, before parsing it', async () => {
    const { request } = await pairing();
    expect(parsePairingRequest('{')).toBeNull();
    expect(parsePairingRequest('')).toBeNull();
    expect(parsePairingRequest(null)).toBeNull();
    const padded = JSON.stringify(request) + ' '.repeat(BRIDGE_FILE_MAX_BYTES);
    expect(JSON.parse(padded)).toEqual(request);
    expect(parsePairingRequest(padded)).toBeNull();
    const multibyte = JSON.stringify({ ...request }).replace('}', `,"x":"${'가'.repeat(30_000)}"}`);
    expect(multibyte.length).toBeLessThan(BRIDGE_FILE_MAX_BYTES);
    expect(parsePairingRequest(multibyte)).toBeNull();
  });

  it('refuses the request file uploaded in place of the connection file', async () => {
    const { request } = await pairing();
    expect(parseSealedConnection(JSON.stringify(request))).toBeNull();
  });

  it('refuses a connection file with a private ephemeral key, a bad iv, extra fields, or too much text', async () => {
    const { request } = await pairing();
    const sealed = await sealConnection(request, payload);
    const keys = await newPairingKeys();
    for (const over of [{ epk: keys.privateJwk }, { iv: 'AAAA' }, { ct: 'not base64!' }, { v: 'studyai-connection/2' }, { pairingId: 'x' }, { note: 'hi' }])
      expect(parseSealedConnection({ ...sealed, ...over }), JSON.stringify(over)).toBeNull();
    expect(parseSealedConnection(JSON.stringify(sealed) + ' '.repeat(BRIDGE_FILE_MAX_BYTES))).toBeNull();
    expect(parseSealedConnection({ ...sealed, ct: 'A'.repeat(BRIDGE_FILE_MAX_BYTES + 4) })).toBeNull();
  });
});

describe('the same bridge in workerd, the Workers runtime', () => {
  type Mf = { dispatchFetch(url: string, init: { method: string; body: string }): Promise<Response>; dispose(): Promise<void> };
  let mf: Mf;
  let dir: string;
  const call = async (body: Record<string, unknown>): Promise<unknown> => {
    const res = await mf.dispatchFetch('http://bridge.test/', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`workerd answered ${res.status}: ${await res.text()}`);
    return res.json();
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'studyai-bridge-'));
    const entry = join(dir, 'entry.ts');
    const bridge = pathToFileURL(resolve('src/core/chatgpt/bridge.ts')).pathname;
    writeFileSync(
      entry,
      `import { newPairingKeys, openConnection, parsePairingRequest, parseSealedConnection, sealConnection } from ${JSON.stringify(bridge)};
export default {
  async fetch(request) {
    const a = await request.json();
    if (a.op === 'runtime') return Response.json({ userAgent: navigator.userAgent });
    if (a.op === 'keys') return Response.json(await newPairingKeys());
    if (a.op === 'open') {
      const file = parseSealedConnection(a.text);
      return Response.json({ payload: file && (await openConnection(a.binding, a.privateJwk, file)) });
    }
    if (a.op === 'seal') return Response.json(await sealConnection(parsePairingRequest(a.request), a.payload));
    return new Response('unknown op', { status: 400 });
  },
};
`,
    );
    const out = (await build({
      configFile: false,
      logLevel: 'silent',
      publicDir: false,
      build: { ssr: entry, write: false, target: 'es2022', minify: false, rollupOptions: { output: { format: 'es' } } },
      ssr: { noExternal: true, target: 'webworker' },
    })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
    const chunk = (Array.isArray(out) ? out[0]! : out).output[0];
    const wrangler = createRequire(import.meta.url).resolve('wrangler/package.json');
    const miniflare = (await import(pathToFileURL(createRequire(wrangler).resolve('miniflare')).href)) as {
      Miniflare: new (o: unknown) => Mf;
      convertV4MiniflareOptions: (o: unknown) => unknown;
    };
    mf = new miniflare.Miniflare(miniflare.convertV4MiniflareOptions({ modules: true, script: chunk.code, compatibilityDate: '2026-10-01', host: '127.0.0.1', port: 0 }));
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens in workerd what Node sealed, with keys workerd made, and refuses the same tampering', async () => {
    expect(await call({ op: 'runtime' })).toEqual({ userAgent: 'Cloudflare-Workers' });
    const keys = (await call({ op: 'keys' })) as { publicJwk: JsonWebKey; privateJwk: JsonWebKey };
    expect(Object.keys(keys.publicJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    const request = must(parsePairingRequest(JSON.stringify(requestFor(keys.publicJwk))));
    const binding = { pairingId: request.pairingId, hostId: request.hostId };
    const sealed = await sealConnection(request, payload);
    const open = async (s: SealedConnection, b = binding) => ((await call({ op: 'open', binding: b, privateJwk: keys.privateJwk, text: JSON.stringify(s) })) as { payload: unknown }).payload;
    expect(await open(sealed)).toEqual(payload);
    expect(await open({ ...sealed, ct: flip(sealed.ct, 10) })).toBeNull();
    expect(await open(sealed, { ...binding, hostId: newHostId() })).toBeNull();
    expect(await open({ ...sealed, epk: (await newPairingKeys()).publicJwk })).toBeNull();
  });

  it('opens in Node what workerd sealed', async () => {
    const { keys, request, binding } = await pairing();
    const sealed = must(parseSealedConnection((await call({ op: 'seal', request, payload })) as unknown));
    expect(await openConnection(binding, keys.privateJwk, sealed)).toEqual(payload);
  });
});
