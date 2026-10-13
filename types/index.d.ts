export type CacheWarm = {
  expiresAt: number | null
  now: number
  tokens: number
  // why the mod cannot run (env variable or failed verification); '' when it can
  disabledReason: string
  // null until session.start decides it from the autoStart option
  isEnabled: boolean | null
  isVerified: boolean
  lastRefreshMs?: number
  refreshCount: number
  totalRefreshCount: number
  coldPromptCount: number
  // the host emptied the cache (compaction, model switch) and no answer has written it
  // since; the next prompt pays for that whether or not the cache was kept warm, so it
  // is not counted as cold
  isReset?: boolean
  // when the latest model request of the running turn started (the prompt's time
  // until the first one does); set only while a turn runs. The server counts the
  // cache lifetime from the start of the last request that read or wrote the cache.
  requestStartedAt?: number
  // /cache-warm pause: no refreshes until the next prompt, which is not counted as cold
  isPaused?: boolean
  // debugWarnings: requests that read under half their input from a cache that looked
  // warm
  rewriteCount?: number
  // what made the latest request that renewed the cache; named in the debugWarnings
  // line
  lastUse?: 'turn' | 'refresh'
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    'cache-warm': { cache: CacheWarm }
  }
}
