/**
 * Configuring the GitHub token, without ever echoing it.
 *
 * WHY THIS IS NOT A REGISTERED TOOL (read before wiring it up):
 *
 * The function below is complete and tested, but `apply()` does not register it.
 * A registered tool appears in every agent's tool list, and an agent that can
 * call `configure_token` may call it unprompted. There is no mechanism in this
 * plugin that limits a tool to "only when the user asked" — the description is a
 * request, not a fence. So the write path exists here, tested, and the decision
 * to expose it is left as a deliberate act rather than a side effect of shipping
 * a helpful-looking tool.
 *
 * WHAT THE HOST GUARANTEES (measured against @deepseek-ai/dsh-credentials and
 * its local store, not assumed):
 *
 *   - `resolve(ref)` -> `{ value, source }` or `undefined` (undefined, not null)
 *   - `describe(ref)` -> `{ configured, source?, writable }` and NEVER the value
 *   - `set(ref, value)` rejects an empty value outright
 *   - a credential supplied by the launch environment is read-only: `describe`
 *     reports `writable: false` and `set` refuses to shadow it
 *
 * THE COST, WHICH THE CALLER MUST STATE TO THE USER:
 *
 * The token has to reach this function through the conversation, so it lands in
 * the local session transcript. That is inherent to asking a user to paste a
 * secret into a chat, not a property of this implementation, and it is why
 * `tokenRemedy()` names the cost in the same breath as the offer.
 */

/** The credential reference, matching the host's own naming for this secret. */
export const GITHUB_TOKEN_REF = 'GITHUB_TOKEN'

/**
 * The subset of the host credentials service this module needs.
 *
 * Declared structurally rather than imported so the module stays free of host
 * dependencies and can be tested against a stub. `set` is optional: a host may
 * expose a read-only credentials service, and its absence is a case to report
 * rather than a crash.
 */
export interface CredentialService {
  resolve?: (ref: string) => Promise<{ value?: string; source?: string } | undefined>
  describe?: (ref: string) => Promise<{ configured: boolean; source?: string; writable?: boolean }>
  set?: (ref: string, value: string) => Promise<void>
}

/** Outcome of a configuration attempt, shaped for direct rendering. */
export interface TokenSetupResult {
  ok: boolean
  /** Message to show the user. Never contains the token. */
  message: string
  /** Observed state after the attempt, from `describe()` — never the value. */
  state?: { configured: boolean; source?: string; writable?: boolean }
}

/**
 * Read the credentials service off a plugin context.
 *
 * @param ctx - anything with a `get` function; the real plugin context qualifies.
 * @returns the service, or `undefined` when this host has none.
 */
export function credentialServiceOf(ctx: unknown): CredentialService | undefined {
  const get = (ctx as { get?: (name: string) => unknown } | undefined)?.get
  if (typeof get !== 'function') return undefined
  const service = get.call(ctx, 'credentials') as CredentialService | undefined
  return service !== undefined && service !== null && typeof service === 'object' ? service : undefined
}

/**
 * Store a GitHub token via the host credentials service.
 *
 * Order matters and is the reason this is a function rather than three inline
 * awaits: emptiness is checked *before* the store is touched (the real store
 * throws on an empty value, and a thrown error reads as a backend fault rather
 * than as "you sent me nothing"), and writability is checked *before* `set`, so
 * an environment-supplied token produces an explanation instead of an opaque
 * rejection.
 *
 * @param credentials - the host credentials service, or `undefined`.
 * @param raw - the token as the user supplied it; trimmed before any decision.
 * @returns success plus a message safe to render. Never includes the token.
 */
export async function configureGitHubToken(
  credentials: CredentialService | undefined,
  raw: string,
): Promise<TokenSetupResult> {
  if (credentials === undefined || typeof credentials.set !== 'function') {
    return {
      ok: false,
      message:
        '这个宿主没有可写的凭据存储，因此 token 无法在这里保存。\n' +
        '  可以先在启动 DSH 的环境里设置 GITHUB_TOKEN 环境变量，效果相同。',
    }
  }

  const token = String(raw ?? '').trim()
  if (token.length === 0) {
    return { ok: false, message: '没有收到 token，未做任何改动。' }
  }

  // Check the shadowing rule before writing, so the user is told WHY rather than
  // shown a rejection. An inherited value cannot be overwritten; the fix is in
  // the user's shell, not in this plugin.
  if (typeof credentials.describe === 'function') {
    let before: { configured: boolean; source?: string; writable?: boolean } | undefined
    try {
      before = await credentials.describe(GITHUB_TOKEN_REF)
    } catch {
      before = undefined
    }
    if (before !== undefined && before.writable === false) {
      return {
        ok: false,
        state: before,
        message:
          `GITHUB_TOKEN 当前由${before.source === 'env' ? '启动环境变量' : `来源 ${before.source ?? '未知'}`}提供，` +
          '该来源只读，无法从这里覆盖。\n' +
          '  请先在启动 DSH 的 shell 里清除该环境变量并重启，再配置；' +
          '或直接沿用现有值，它已经在生效。',
      }
    }
  }

  try {
    await credentials.set(GITHUB_TOKEN_REF, token)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `token 保存失败：${reason}` }
  }

  // Re-read through `describe`, which is the only status channel the host
  // provides that structurally cannot carry the value.
  let state: { configured: boolean; source?: string; writable?: boolean } | undefined
  if (typeof credentials.describe === 'function') {
    try {
      state = await credentials.describe(GITHUB_TOKEN_REF)
    } catch {
      state = undefined
    }
  }

  return {
    ok: true,
    state,
    message:
      `已保存。GITHUB_TOKEN 现在已配置${state?.source ? `（来源：${state.source}）` : ''}。\n` +
      '  生效后检索配额从「每分钟 10 次、同一出口 IP 共享」变为「每分钟 30 次、按账号计算」。\n' +
      '  提醒：token 已留在本次对话记录中；如需轮换，可随时重新配置或从凭据存储中移除。',
  }
}
