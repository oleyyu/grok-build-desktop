// Redact secrets before any log/diagnostic write. Over-mask rather than leak.

// Bearer/Basic must be first in the value alt: otherwise [^\s,;}{]{6,} eats "Bearer" and the token remains.
// [a-z0-9]*[-_]?token 兜住 access_token/refresh_token/session_token/id_token/idToken/裸 token 及任意 *token 后缀。
const FIELD_NAMES = /("?(?:api[-_]?key|authorization|[a-z0-9]*[-_]?token|secret|password|passwd|credential|cookie|signature)"?\s*[:=]\s*)((?:Bearer|Basic)\s+\S+|"[^"]{6,}"|'[^']{6,}'|[^\s,;}{]{6,})/gi

// Already-masked `Bearer ****` must not become `"****"` (would drop the scheme).
const MASKED_SCHEME = /^(?:Bearer|Basic)\s+\*{4}$/i

// 关键词允许出现在参数名任意位置（?id_token= 这类前缀形式也要中）。
const URL_QUERY_SECRETS = /([?&][^=&\s]*(?:auth|code|credential|key|password|secret|signature|token)[^=&\s]*=)[^&\s]+/gi

const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]{8,}/g

// Prefixed keys and isolated long tokens.
const PREFIXED_KEY = /\b(sk|xai|sess|ghp|gho)-[A-Za-z0-9_-]{10,}/g
const LONG_TOKEN = /\b[A-Za-z0-9]{40,}\b/g

export function maskSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  // BEARER before FIELD_NAMES so the token is gone before the field regex can match "Bearer" alone.
  out = out.replace(BEARER, (_, scheme) => `${scheme} ****`)
  out = out.replace(FIELD_NAMES, (_, head, val) => (MASKED_SCHEME.test(val) ? `${head}${val}` : `${head}"****"`))
  out = out.replace(URL_QUERY_SECRETS, (_, head) => `${head}****`)
  out = out.replace(PREFIXED_KEY, (m) => `${m.slice(0, 6)}****`)
  out = out.replace(LONG_TOKEN, (m) => `${m.slice(0, 3)}****`)
  return out
}
