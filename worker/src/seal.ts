import { fromBase64Url, toBase64Url } from './encoding';

// AAD binds each v1 AES-GCM value to its slot and revision, so copying ciphertext into another row cannot open it.

export function parseSealKeyBytes(raw: string | undefined): Uint8Array<ArrayBuffer> | null {
  if (!raw) return null;
  const bytes = fromBase64Url(raw.trim());
  return bytes && bytes.length === 32 ? bytes : null;
}

export async function seal(key: CryptoKey, aad: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, new TextEncoder().encode(plaintext)));
  return `v1.${toBase64Url(iv)}.${toBase64Url(ct)}`;
}

export async function unseal(key: CryptoKey, aad: string, sealed: string): Promise<string | undefined> {
  const [v, ivText, ctText, ...rest] = sealed.split('.');
  if (v !== 'v1' || !ivText || !ctText || rest.length > 0) return undefined;
  const iv = fromBase64Url(ivText);
  const ct = fromBase64Url(ctText);
  if (!iv || iv.length !== 12 || !ct) return undefined;
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, ct));
  } catch {
    return undefined;
  }
}

export const credsAad = (rev: string) => `studyai/chatgpt/creds/v1/${rev}`;
export const pendingAad = (attemptId: string) => `studyai/chatgpt/pending/v1/${attemptId}`;
