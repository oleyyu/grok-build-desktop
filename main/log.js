// Daily file logs; every line through maskSecrets. Sync append so a hard crash still leaves a trail.

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { maskSecrets } from './mask-secrets.js'

export function createLogger(dir) {
  mkdirSync(dir, { recursive: true })
  // Drop logs older than 7 days.
  try {
    const now = Date.now()
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.log')) continue
      const p = join(dir, f)
      try {
        if (now - statSync(p).mtimeMs > 7 * 24 * 3600 * 1000) unlinkSync(p)
      } catch {}
    }
  } catch {}

  function line(level, msg) {
    const ts = new Date().toISOString()
    const day = ts.slice(0, 10)
    const text = `${ts} [${level}] ${maskSecrets(String(msg))}\n`
    try { appendFileSync(join(dir, `${day}.log`), text) } catch {}
    if (process.env.GROK_DESKTOP_DEBUG) process.stderr.write(text)
  }

  return {
    info: (m) => line('info', m),
    warn: (m) => line('warn', m),
    error: (m) => line('error', m),
  }
}
