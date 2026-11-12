import type { IncomingMessage, ServerResponse } from 'node:http';

export declare const AUTH: 'https://auth.openai.com';
export declare const API: 'https://api.openai.com';

export type FakeScript = { kind: 'text'; text?: string } | { kind: 'http'; status: number; body: unknown } | { kind: 'hang' } | { kind: 'failed'; code: string };

export interface FakeLogEntry {
  kind: 'authorize' | 'exchange' | 'refresh' | 'revoke' | 'responses' | 'models';
  clientId?: string | null;
  token?: string | null;
  /** Refresh only: the refresh token upstream rotated to, when it rotated. Never served over HTTP. */
  rotatedTo?: string;
  body?: Record<string, unknown>;
  agentNameHint?: string | null;
  prompt?: string | null;
  hasIdTokenHint?: boolean;
}

export interface FakeOpenAi {
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<Response>;
  authorize(href: string): string;
  hold(kind: 'exchange' | 'refresh' | 'revoke' | 'responses'): { release(): void; reached: Promise<void> };
  behaviour: {
    account: { sub: string; email: string };
    grantPlan: boolean;
    expiresIn: number;
    earliestRefreshAt: number | null;
    nextRefresh: 'ok' | 'terminal' | 'invalid-client' | 'transient' | 'rate-limited' | 'rejected' | 'rotate-then-hang' | 'rotate-then-504' | 'rotate-then-garbage';
    idTokenTtlS: number;
    nextExchange: 'ok' | 'invalid-grant' | 'invalid-client' | 'transient';
    models: { slug: string; display_name: string; visibility: string }[];
    responses: FakeScript[];
    script: ((body: { model: string; instructions?: string; input: { role: string; content: string }[] }) => FakeScript) | null;
    answer: string;
  };
  log: FakeLogEntry[];
  count(kind: FakeLogEntry['kind']): number;
  refreshTokenState(token: string): 'live' | 'used' | 'revoked' | null;
  revoked(): string[];
  reused(): number;
  invalidateAccess(): void;
  issued(): string[];
}

export declare function createFakeOpenAi(opts?: { now?: () => number }): FakeOpenAi;
export declare function serveFakeOpenAi(fake: FakeOpenAi, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
