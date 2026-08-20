// Shared spawn opts for ipc engine:start and main.js autostart.
// xaiApiBaseUrl / env must be explicitly null when no provider is active:
// #doStart shallow-merges, so omitted keys leave the old baseURL and API key in the child.

/**
 * @param {object} settings
 * @param {object} opts only { model, effort }
 * @param {Function} loadCredentialsFn
 * @returns {{model: string|null, effort: string|null, xaiApiBaseUrl: string|null, env: object|null}}
 */
export function buildSpawnOpts(settings, opts = {}, loadCredentialsFn) {
  const s = settings || {}
  const out = {
    model: opts.model ?? s.engine?.model ?? null,
    effort: opts.effort ?? s.engine?.effort ?? null,
    xaiApiBaseUrl: null,
    env: null,
  }
  const providerId = s.providers?.active
  const p = providerId ? s.providers?.[providerId] : null
  if (p?.baseURL) out.xaiApiBaseUrl = p.baseURL
  if (p?.apiKeyEnv && typeof loadCredentialsFn === 'function') {
    const v = loadCredentialsFn()?.[p.apiKeyEnv]
    if (v) out.env = { XAI_API_KEY: v }
  }
  return out
}
