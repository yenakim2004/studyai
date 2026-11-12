import { DurableObject } from 'cloudflare:workers';
import type { AiReply, AiStatus, AiTask, SignInOutcome } from '../../src/core/tutor/contract';
import type { CallbackQuery, OutboundFetch } from '../../src/core/chatgpt/oauth';
import type { Backend, Ok } from './app';
import { ChatGptAccount, type DisconnectReply, type ModelsReply, type SelectReply, type StartOptions, type StartReply } from './chatgpt';
import { parseLoopback } from './loopback';

/**
 * The single, private brain of the local server: one Durable Object instance (named "owner" since the first release, an
 * address kept so existing state is found) holds the user's ChatGPT sign-in: registration in clear, tokens sealed with
 * AES-GCM (worker/src/chatgpt.ts owns every chatgpt:* row). It stores no lecture text, prompts or answers.
 *
 * Rows written by earlier releases (settings, a spend ledger, login counters) stay in the table untouched. Nothing reads them.
 */
export class StudyAiDO extends DurableObject<Env> implements Backend {
  private readonly chatgpt: ChatGptAccount;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.chatgpt = new ChatGptAccount({
      kv: { get: (k) => this.get(k), put: (k, v) => this.put(k, v), del: (k) => this.del(k) },
      http: this.createOpenAiFetch(),
      sealKey: env.CHATGPT_SEAL_KEY,
      loopback: parseLoopback(env),
      now: Date.now,
      browserUrl: (url) => this.browserAuthorizeUrl(url),
    });
  }

  // ---- synchronous storage ---------------------------------------------------
  private get(k: string): string | undefined {
    return this.ctx.storage.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).toArray()[0]?.v;
  }
  private put(k: string, v: string): void {
    this.ctx.storage.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }
  private del(k: string): void {
    this.ctx.storage.sql.exec('DELETE FROM kv WHERE k = ?', k);
  }

  /** Production talks to OpenAI's fixed endpoints. Only the local test entry overrides this. */
  protected createOpenAiFetch(): OutboundFetch {
    return (url, init) => fetch(url, init);
  }

  /** The authorize URL the browser follows. Only the local test entry rewrites it, to its fake issuer. */
  protected browserAuthorizeUrl(url: string): string {
    return url;
  }

  async askTask(task: AiTask): Promise<AiReply> {
    return this.chatgpt.ask(task);
  }
  async status(): Promise<AiStatus> {
    return this.chatgpt.status();
  }
  async chatgptStart(o: StartOptions): Promise<StartReply> {
    return this.chatgpt.start(o);
  }
  async chatgptCallback(q: CallbackQuery): Promise<SignInOutcome> {
    return this.chatgpt.callback(q);
  }
  async chatgptDisconnect(forget: boolean): Promise<DisconnectReply> {
    return this.chatgpt.disconnect({ forget });
  }
  async chatgptModels(): Promise<ModelsReply> {
    return this.chatgpt.models();
  }
  async chatgptResume(): Promise<Ok> {
    this.chatgpt.resume();
    return { ok: true };
  }
  async chatgptSelectModel(model: string): Promise<SelectReply> {
    return this.chatgpt.selectModel(model);
  }
}
