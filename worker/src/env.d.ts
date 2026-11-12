/** Not in wrangler.jsonc, so `wrangler types` cannot know them. Optional on purpose: a missing one must fail closed. */
interface Env {
  /** "127.0.0.1:<port>". Written only by scripts/local.mjs. Absent in every hosted copy, which then has no AI routes. */
  STUDYAI_LOOPBACK?: string;
  /** base64url of 32 random bytes: the AES-GCM key for the sealed ChatGPT credentials. Written only by scripts/local.mjs. */
  CHATGPT_SEAL_KEY?: string;
}
