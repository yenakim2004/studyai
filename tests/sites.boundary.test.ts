import { describe, expect, it } from 'vitest';
import { checkSiteRequest, parseSiteOrigin } from '../worker/src/sites/boundary';

const origin = 'https://studyai.example.test';
const identity = { 'oai-authenticated-user-id': 'site-user-1' };
const postHeaders = { ...identity, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };

describe('the private Sites request boundary', () => {
  it('accepts same-origin JSON from dispatch-authenticated visitors', () => {
    expect(checkSiteRequest(new Request(`${origin}/api/chatgpt/pairing`, { method: 'POST', headers: postHeaders }), origin)).toEqual({ ok: true, userId: 'site-user-1' });
  });

  it('does not treat service access as a visitor identity', () => {
    const request = new Request(`${origin}/api/status`, { headers: { 'OAI-Sites-Authorization': 'Bearer fixture' } });
    expect(checkSiteRequest(request, origin)).toEqual({ ok: false, status: 401, code: 'site-signin-required' });
  });

  it.each([undefined, 'https://attacker.test', 'https://other.studyai.example.test'])('rejects POST origin %s', (value) => {
    const headers = new Headers(postHeaders);
    if (value) headers.set('origin', value);
    else headers.delete('origin');
    expect(checkSiteRequest(new Request(`${origin}/api/ai/ask`, { method: 'POST', headers }), origin)).toMatchObject({ ok: false, code: 'cross-site' });
  });

  it.each(['cross-site', 'same-site', 'none'])('rejects Fetch Metadata %s', (value) => {
    expect(checkSiteRequest(new Request(`${origin}/api/status`, { headers: { ...identity, 'sec-fetch-site': value } }), origin)).toMatchObject({ ok: false, code: 'cross-site' });
  });

  it('allows same-origin GETs that omit Origin and Fetch Metadata', () => {
    expect(checkSiteRequest(new Request(`${origin}/api/status`, { headers: identity }), origin).ok).toBe(true);
  });

  it('rejects simple form submissions and accepts JSON with a charset', () => {
    const request = (type: string) => new Request(`${origin}/api/chatgpt/install`, { method: 'POST', headers: { ...postHeaders, 'content-type': type } });
    expect(checkSiteRequest(request('text/plain'), origin)).toMatchObject({ ok: false, code: 'json-required' });
    expect(checkSiteRequest(request('application/json; charset=utf-8'), origin).ok).toBe(true);
  });

  it('fails closed before authentication when the public origin is missing', () => {
    expect(checkSiteRequest(new Request(`${origin}/api/status`), null)).toMatchObject({ ok: false, status: 503 });
  });
});

describe('the configured public origin', () => {
  it('accepts only an exact HTTPS origin', () => {
    expect(parseSiteOrigin(origin)).toBe(origin);
    for (const value of [undefined, '', 'http://studyai.example.test', `${origin}/`, `${origin}/path`, `${origin}?x=1`, 'https://name:password@studyai.example.test']) {
      expect(parseSiteOrigin(value)).toBeNull();
    }
  });
});
