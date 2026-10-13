// cache-warm: shows the prompt-cache TTL in the footer and keeps the cache warm.
//
// The model API caches the conversation prefix for 5 minutes, counted from the start of
// each request that uses it; a cached read costs a tenth of an uncached one. After a
// longer pause the next prompt pays full price for the whole context. This mod sends a
// tiny side request shortly before the TTL runs out, which renews it, until the user
// has been idle for IDLE_LIMIT_MS.
//
// How a mod works, as far as this file needs it:
// - `register` receives `on`, which attaches a hook to a host event. A hook gets the
//   host handle `$`, the event `e` and `next`, the rest of the chain. Calling
//   `next(e)` (possibly with a changed event) passes control on and returns the
//   result, so a hook can act before and after the host does.
// - The module is reloaded on edits and its top-level variables are reset. State that
//   must survive lives in an atom (below), kept by the host.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CacheWarm } from '../types'

// The four values below come from the plugin's userConfig (see plugin.json); register
// fills them on every load, the defaults hold until then.
// How long the prompt cache lives after a request has read or written it, counted from
// the start of that request (5 min on API keys).
let CACHE_TTL_MS = 5 * 60_000
// A refresh is sent this long before the cache expires.
let REFRESH_LEAD_MS = 30_000
// No refreshes once the last prompt is older than this; the cache then goes cold.
let IDLE_LIMIT_MS = 30 * 60_000
// Whether a new session starts with cache-warm on; /cache-warm start and stop switch it
// for the running session.
let AUTO_START = true
// Whether a request that read less than half its input from a cache the footer calls
// warm raises a warning line and is counted. For watching the cache behaviour, off by
// default.
let DEBUG_WARNINGS = false
// A refresh at least this slow shows its duration in the footer.
const SLOW_REFRESH_MS = 10_000
// After a failed refresh, wait this long before trying again.
const RETRY_DELAY_MS = 15_000
// How long a toast stays; the host's default of 4 s is easy to miss.
const TOAST_MS = 20_000
// Shown in the footer while a compaction or a turn blocks refreshes.
const COMPACT_NOTE = 'paused (compact)'
const TURN_NOTE = 'paused (turn)'
const IDLE_NOTE = 'idle limit reached'
// Footer and status text while /cache-warm pause is in effect; derived from isPaused,
// not stored in note.
const PAUSE_NOTE = 'paused (until next prompt)'

// The shared state, kept by the host so that a reload does not lose it. `now` is part
// of it on purpose: writing it every second makes the footer redraw its countdown.
// Fields: see ../types.
const cache = atom(
  { plugin: 'cache-warm', key: 'cache' } as const,
  {
    expiresAt: null,
    now: 0,
    tokens: 0,
    disabledReason: '',
    isEnabled: null,
    isVerified: false,
    refreshCount: 0,
    totalRefreshCount: 0,
    coldPromptCount: 0,
    note: '',
  } as CacheWarm,
)

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const describe = (c: CacheWarm) => {
  if (!c.isEnabled || c.expiresAt === null) return undefined
  // A request reads the cache as it starts, which renews it, but expiresAt is only
  // written once the step has ended. Until then count from the request's start (or
  // from the prompt, which precedes it): never more time than the cache has. After an
  // ESC before the answer started, requestStartedAt is gone and the old expiry shows
  // again, since nothing tells whether the request reached the cache.
  const expiresAt =
    c.requestStartedAt === undefined
      ? c.expiresAt
      : Math.max(c.expiresAt, c.requestStartedAt + CACHE_TTL_MS)
  // c.now can be older than the request's start: never show more than the lifetime.
  const left = Math.min(expiresAt - c.now, CACHE_TTL_MS)
  const state = c.disabledReason !== ''
    ? 'keep-warm off'
    : left <= 0
      ? 'cold'
      : `warm ${fmt(left)}`
  // The count tells that refreshes ran since the last prompt; the duration is only
  // worth showing when a refresh was slow.
  const slow =
    c.lastRefreshMs !== undefined && c.lastRefreshMs >= SLOW_REFRESH_MS
      ? `, last ${(c.lastRefreshMs / 1000).toFixed(1)}s`
      : ''
  const refreshes =
    c.refreshCount > 0
      ? ` (${c.refreshCount} ${c.refreshCount === 1 ? 'refresh' : 'refreshes'}${slow})`
      : ''
  const note = c.note !== '' ? c.note : c.isPaused ? PAUSE_NOTE : ''
  return `cache ${state}${refreshes}${note ? ` · ${note}` : ''}`
}

type RequestUsage = {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// True when a request took less than half of its input from the cache. A large pasted
// prompt also does that, so this is a hint, not proof of a discarded cache.
const isMostlyUncached = (u: RequestUsage) => {
  const read = u.cache_read_input_tokens
  const total = u.input_tokens + read + u.cache_creation_input_tokens
  return total > 0 && read * 2 < total
}

// A refresh normally reads about as many tokens from the cache as the last request of
// a turn took in. At this multiple of that it counts as read twice.
const DOUBLE_READ_FACTOR = 1.8

const inputOf = (u: RequestUsage) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

// Pinned as the status line under the prompt, where it stays until the next prompt
// clears it, for a refresh that read far more from the cache than the last request of
// a turn took in. `$` is typed `any` as in tick.
function warnDoubleRead($: any, u: RequestUsage, lastInputTokens: number) {
  $.ui.status(
    `refresh read ${u.cache_read_input_tokens} tokens from the cache, ` +
      `${(u.cache_read_input_tokens / lastInputTokens).toFixed(1)} times the ` +
      `${lastInputTokens} the last request took in`,
  )
}

// Pinned as the status line under the prompt, where it stays until the next prompt
// clears it. `$` is typed `any` as in tick.
// The timing tells a server-side early eviction (the footer had time left, the last
// cache use was recent) from a long gap (a sleeping machine, a stalled clock). Who
// made that last use matters too: a refresh may reach a cache entry that a turn does
// not, or the other way round.
// `before` is the atom as it was when the request started; its expiresAt is not null.
async function warnRewrite(
  $: any,
  source: string,
  u: RequestUsage,
  before: CacheWarm,
  startedAt: number,
) {
  await update($, cache, (c: CacheWarm) => ({
    ...c,
    rewriteCount: (c.rewriteCount ?? 0) + 1,
  }))
  const expiresAt = before.expiresAt as number
  $.ui.status(
    `${source} read ${u.cache_read_input_tokens} and wrote ` +
      `${u.cache_creation_input_tokens} tokens although the cache looked warm ` +
      `(${fmt(expiresAt - startedAt)} left, last cache use ` +
      `${fmt(startedAt - (expiresAt - CACHE_TTL_MS))} ago` +
      `${before.lastUse === undefined ? '' : `, by ${before.lastUse}`})`,
  )
}

let lastActivity = 0
let isRefreshing = false
// A running turn reads and writes the cache itself; no refresh beside it.
let isTurnRunning = false
// A compaction replaces the context; a refresh during it would warm a prefix that is
// about to be thrown away.
let isCompacting = false
let lastFailureAt = 0
let timer: { cancel: () => void } | undefined
// The last /cache-warm start or stop. /clear resets the atom but not the module, so
// this carries the choice over it; a reload resets this, but not the atom.
let userChoice: boolean | undefined

// Runs every second: updates the clock for the display and, when the cache is about to
// expire, sends the refresh. It is a top-level function because the host lets `$` be
// passed only to those; `$` is typed `any` for that reason.
async function tick($: any) {
  const now: number = await $.clock.now()
  const c: CacheWarm = await read($, cache)
  if (c.expiresAt === null) return
  // The write redraws the SessionMode hook below, which reads this atom.
  await update($, cache, (x: CacheWarm) => ({ ...x, now }))

  // A reload resets module variables; count idle time from then on, not from 1970.
  if (lastActivity === 0) lastActivity = now
  const isIdle = now - lastActivity > IDLE_LIMIT_MS
  // Say why the countdown runs down without a refresh. Only into an empty note, so it
  // is written once and never hides another message; the next prompt replaces it.
  if (isIdle && c.note === '' && now < c.expiresAt) {
    await update($, cache, (x: CacheWarm) =>
      x.note === '' ? { ...x, note: IDLE_NOTE } : x,
    )
  }
  // Not after expiry: a cold cache is rewritten at full price, which the next prompt
  // does anyway.
  const isDue = now >= c.expiresAt - REFRESH_LEAD_MS && now < c.expiresAt
  const isBackingOff = now - lastFailureAt < RETRY_DELAY_MS
  const isDisabled = c.disabledReason !== ''
  const isBlocked =
    isDisabled || isRefreshing || isTurnRunning || isCompacting || c.isPaused === true
  if (isBlocked || !isDue || isIdle || isBackingOff) return

  isRefreshing = true
  try {
    // The API counts the lifetime from the start of the request that reads the cache,
    // not from the end of its answer, so the new expiry is counted from here too.
    const startedAt: number = await $.clock.now()
    let r
    // A fork repeats the main thread's last request (same model, system prompt, tools
    // and messages) with this prompt appended and all tools denied. The API therefore
    // serves the whole conversation from its cache, which renews the TTL; only the
    // short prompt is computed fresh. Before the first reply there is nothing to fork.
    try {
      // The start time makes every prompt different. The text says what the request is
      // and what to answer, so the model has nothing to look into.
      r = await $.model.fork({
        prompt:
          `Automated keep-alive ${startedAt}: no tools, no commentary, ` +
          'your entire reply is "ok".',
      })
    } catch {
      r = { isAnswered: false as const, reason: 'error' }
    }
    const lastRefreshMs: number = (await $.clock.now()) - startedAt
    if (!r.isAnswered) {
      lastFailureAt = startedAt
      await update($, cache, (x: CacheWarm) => ({
        ...x,
        note: `refresh failed: ${r.reason}`,
      }))
      return
    }
    // Why check at all: nothing in turn.complete says whether the cache was really
    // written. The footer assumes it was and says "warm" from the first prompt; the
    // first refresh is the silent test. If it reads any tokens from the cache, caching
    // works and isVerified is set; if it reads none, the gateway drops caching (or the
    // cache entry had already expired by then), and every further refresh would pay
    // the full context price for nothing. Any hit counts, not a share of the context:
    // the context size is only known roughly (the status line's rounded percentage),
    // and a cache written just before covers only part of the context. isVerified is
    // kept in the atom, which a hot reload keeps, and is never checked again once true.
    if (!c.isVerified) {
      if (!(r.usage.cache_read_input_tokens > 0)) {
        await update($, cache, (x: CacheWarm) => ({
          ...x,
          disabledReason:
            'caching verification: first refresh read no tokens from cache',
          note: 'first refresh read no tokens from cache',
        }))
        $.ui.toast('cache-warm: caching not passed through, keep-warm switched off', {
          timeoutMs: TOAST_MS,
        })
        return
      }
    }
    if (DEBUG_WARNINGS && isMostlyUncached(r.usage)) {
      await warnRewrite($, 'refresh', r.usage, c, startedAt)
    }
    if (
      DEBUG_WARNINGS &&
      c.lastInputTokens !== undefined &&
      r.usage.cache_read_input_tokens >= c.lastInputTokens * DOUBLE_READ_FACTOR
    ) {
      warnDoubleRead($, r.usage, c.lastInputTokens)
    }
    await update($, cache, (x: CacheWarm) => ({
      ...x,
      isVerified: true,
      lastRefreshMs,
      refreshCount: x.refreshCount + 1,
      totalRefreshCount: (x.totalRefreshCount ?? 0) + 1,
      expiresAt: startedAt + CACHE_TTL_MS,
      lastUse: 'refresh',
      note: '',
    }))
  } finally {
    isRefreshing = false
  }
}

// The value of DISABLE_PROMPT_CACHING when it makes the host send no cache markers
// (1, true, yes or on), else undefined. `$` is typed `any` here as in tick; the name
// must be a string literal for `$.env.get`.
async function cachingDisabledBy($: any): Promise<string | undefined> {
  const v: string | undefined = await $.env.get('DISABLE_PROMPT_CACHING')
  return v !== undefined && /^(1|true|yes|on)$/i.test(v.trim()) ? v.trim() : undefined
}

const envReason = (value: string) => `DISABLE_PROMPT_CACHING=${value}`
const envText = (value: string) =>
  `cache-warm: ${envReason(value)}, there is no cache to keep warm`

// Decides the start state while isEnabled is still null: in a new session, and after
// /clear, which resets the atom but fires no session.start. The option sets the state,
// never overrides a stop. Without caching a refresh is billed at the normal input
// price and renews nothing, which the first-refresh check could only find out after
// paying for one; so the mod does not start at all.
async function initState($: any) {
  const envValue = await cachingDisabledBy($)
  await update($, cache, (c: CacheWarm) => ({
    ...c,
    isEnabled: c.isEnabled ?? (envValue === undefined && (userChoice ?? AUTO_START)),
    // Kept for /cache-warm status, which names why the mod is not running.
    disabledReason: envValue !== undefined ? envReason(envValue) : c.disabledReason,
  }))
  if (envValue !== undefined) $.ui.toast(envText(envValue), { timeoutMs: TOAST_MS })
}

// A number option, or the default when it is missing, not finite or out of range.
const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback

export const register: Register = (on, options) => {
  // A picker over "5" and "60" (see plugin.json); anything else counts as 5.
  CACHE_TTL_MS = (options.cacheTtlMinutes === '60' ? 60 : 5) * 60_000
  // The lead must stay below the lifetime, else a refresh is due the moment the cache
  // is written.
  REFRESH_LEAD_MS = Math.min(
    num(options.refreshLeadSeconds, 30, 5, 600) * 1000,
    CACHE_TTL_MS / 2,
  )
  IDLE_LIMIT_MS = num(options.idleLimitMinutes, 30, 1, 720) * 60_000
  AUTO_START = options.autoStart !== false
  DEBUG_WARNINGS = options.debugWarnings === true

  // A reload cancels the timer and starts the module afresh; session.start fires again.
  on('session.start', async ($, e, next) => {
    // Clears the pinned line an earlier version of this mod left behind.
    $.ui.status(undefined)
    // Also runs after a reload, when the atom already holds the user's choice (null
    // only in a new session).
    await initState($)
    await $.command.register({
      name: 'cache-warm',
      description: 'Start, stop or pause cache-warm, show its counters and settings',
      argumentHint: '[start|stop|pause|status]',
      immediate: true,
    })
    if ((await read($, cache)).isEnabled) {
      timer ??= $.clock.every(1000, () => void tick($))
    }
    return next(e)
  })

  // "status" is the default. start and stop switch the running session only; the
  // autoStart option decides how the next one begins. pause is for an absence you know
  // is long: no refreshes until the next prompt, without stopping and starting again.
  on('command.run', { command: 'cache-warm' }, async ($, e, next) => {
    const sub = e.args.trim()
    if (!['', 'status', 'start', 'stop', 'pause'].includes(sub)) {
      return { text: 'usage: /cache-warm [start|stop|pause|status]' }
    }
    if ((await read($, cache)).isEnabled === null) await initState($)
    if (sub === 'pause') {
      const c: CacheWarm = await read($, cache)
      if (!c.isEnabled || c.disabledReason !== '') {
        return { text: 'nothing to pause, cache-warm is not running' }
      }
      await update($, cache, (x: CacheWarm) => ({ ...x, isPaused: true }))
      return { text: 'paused until your next prompt (start ends it earlier)' }
    }
    if (sub === 'start' || sub === 'stop') {
      const isEnabled = sub === 'start'
      const envValue = isEnabled ? await cachingDisabledBy($) : undefined
      if (envValue !== undefined) return { text: envText(envValue) }
      // `now` is only written by tick, which does not run while stopped: refresh it, or
      // the footer shows the countdown as it was at stop.
      const now = await $.clock.now()
      userChoice = isEnabled
      await update($, cache, (c: CacheWarm) => ({
        ...c,
        isEnabled,
        now,
        isPaused: false,
      }))
      // Stopped means no timer at all, not a timer that returns at once.
      if (isEnabled) {
        timer ??= $.clock.every(1000, () => void tick($))
      } else {
        timer?.cancel()
        timer = undefined
      }
      return { text: isEnabled ? 'started' : 'stopped' }
    }
    const c: CacheWarm = await read($, cache)
    // The host puts "cache-warm:" before the text, so the first line is the state.
    // The footer already shows the cache state.
    const text = [
      c.disabledReason !== ''
        ? `disabled (${c.disabledReason})`
        : c.isEnabled
          ? c.isPaused
            ? PAUSE_NOTE
            : 'active'
          : 'stopped (start with /cache-warm start)',
      ...(c.expiresAt === null ? ['no turn completed yet, no countdown'] : []),
      `refreshes sent: ${c.totalRefreshCount ?? 0}`,
      `cold prompts (estimated): ${c.coldPromptCount ?? 0}`,
      ...(DEBUG_WARNINGS
        ? [`unexpected rewrites (estimated): ${c.rewriteCount ?? 0}`]
        : []),
      `cache lifetime ${CACHE_TTL_MS / 60_000} min, ` +
        `refresh lead ${REFRESH_LEAD_MS / 1000} s, ` +
        `idle limit ${IDLE_LIMIT_MS / 60_000} min`,
    ].join('\n')
    return { text }
  })

  // A turn starts here and ends in turn.complete; refreshes stay out in between.
  // A prompt that arrives after the expiry rewrites the cache at full price: count it.
  // The prompt's request goes out right after this, so the footer counts from here
  // (requestStartedAt) until the first step has ended. expiresAt stays: if ESC stops
  // the request before it reaches the cache, the old expiry is still the true one.
  // A prompt typed while a turn runs (e.turnId is set) fires this at Enter too, but
  // sends no request of its own: the running turn picks it up with its next step. It
  // is the user's activity and nothing else, so the cache fields stay as they are.
  // A prompt after /cache-warm pause ends the pause. It is not counted as cold: the
  // user let the cache run out on purpose, as with stop.
  on('prompt.submit', async ($, e, next) => {
    if ((await read($, cache)).isEnabled === null) await initState($)
    const now = await $.clock.now()
    lastActivity = now
    if (e.turnId !== undefined) return next(e)
    // Ends the debugWarnings line of an earlier request.
    if (DEBUG_WARNINGS) $.ui.status(undefined)
    isTurnRunning = true
    await update($, cache, (c: CacheWarm) => ({
      ...c,
      refreshCount: 0,
      coldPromptCount:
        (c.coldPromptCount ?? 0) +
        (c.isEnabled &&
        !c.isReset &&
        !c.isPaused &&
        c.expiresAt !== null &&
        now >= c.expiresAt
          ? 1
          : 0),
      isReset: false,
      isPaused: false,
      requestStartedAt: now,
      note: TURN_NOTE,
    }))
    return next(e)
  })

  // Every model request of a turn (after each tool call, too) reads the cache and so
  // renews its TTL, counted from the start of the request, not from the end of its
  // answer. The footer counts from there while the step runs (requestStartedAt);
  // without this, a step started late in the countdown would show "cold" while the
  // cache was kept alive. expiresAt is written only after the step has ended, and
  // only if a response arrived. usage is null when the request failed or was
  // interrupted before the answer started (measured: ESC about 1 s after sending;
  // after the first text it is set). Such a request may never have reached the cache,
  // so the old expiry stays. Idle until the first turn completes: the context size
  // is unknown before that. Subagents carry an agentId and have contexts of their own,
  // so only the main agent (no agentId) counts. requestStartedAt is set only within a
  // turn (isTurnRunning): turn.complete clears it, and a request outside a turn (a
  // compaction, the refresh's fork) has no turn.complete to do that.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const startedAt = await $.clock.now()
    const before: CacheWarm = await read($, cache)
    const isWarm =
      before.isEnabled === true &&
      before.expiresAt !== null &&
      startedAt < before.expiresAt
    if (isTurnRunning) {
      await update($, cache, (c: CacheWarm) => ({ ...c, requestStartedAt: startedAt }))
    }
    const r = yield* next(e)
    if (r.usage !== null) {
      const now = await $.clock.now()
      // lastInputTokens is kept even before the first turn has completed (expiresAt is
      // still null): a refresh is compared with that turn's own steps.
      await update($, cache, (c: CacheWarm) =>
        c.expiresAt === null
          ? { ...c, lastInputTokens: inputOf(r.usage) }
          : {
              ...c,
              now,
              expiresAt: startedAt + CACHE_TTL_MS,
              lastUse: 'turn',
              lastInputTokens: inputOf(r.usage),
            },
      )
      if (DEBUG_WARNINGS && isWarm && isMostlyUncached(r.usage)) {
        await warnRewrite($, 'turn step', r.usage, before, startedAt)
      }
    }
    return r
  })

  // A compaction replaces the context, so the cached prefix no longer matches it. The
  // compaction itself does not cache the new context (measured: the next request read
  // only the static system prompt and tools from the cache); the next prompt does.
  // So a successful compaction marks the cache cold (expiresAt = now) and records the
  // new, shorter size; isReset keeps the next prompt out of the cold count, and
  // requestStartedAt goes, or the footer would still count from the old request. A
  // skipped or aborted compaction leaves the context, and with it the cache,
  // unchanged. Other triggers than manual and auto are left alone.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || (e.trigger !== 'manual' && e.trigger !== 'auto')) {
      return next(e)
    }
    isCompacting = true
    await update($, cache, (c: CacheWarm) => ({ ...c, note: COMPACT_NOTE }))
    try {
      const r = await next(e)
      if (r.skip === undefined) {
        const now = await $.clock.now()
        await update($, cache, (c: CacheWarm) =>
          c.expiresAt === null
            ? c
            : {
                ...c,
                now,
                expiresAt: now,
                tokens: r.tokensAfter ?? 0,
                isReset: true,
                requestStartedAt: undefined,
                lastInputTokens: undefined,
              },
        )
      }
      return r
    } finally {
      isCompacting = false
      await update($, cache, (c: CacheWarm) =>
        c.note === COMPACT_NOTE ? { ...c, note: '' } : c,
      )
    }
  })

  // The cache belongs to one model: after a switch the new model starts with an empty
  // one, whatever the countdown says. Mark it cold, as after a compaction; the next
  // prompt writes it and is not counted as cold (isReset). isVerified stays: it
  // describes the gateway, not the model, and no refresh is sent while the cache is
  // marked cold. requestStartedAt goes for the same reason as in the compaction.
  on('classic.PostModelSwitch', async ($, e, next) => {
    if (e.from_model !== e.to_model) {
      const now = await $.clock.now()
      await update($, cache, (c: CacheWarm) =>
        c.expiresAt === null
          ? c
          : {
              ...c,
              now,
              expiresAt: now,
              isReset: true,
              requestStartedAt: undefined,
              lastInputTokens: undefined,
            },
      )
    }
    return next(e)
  })

  // Adds one entry to the footer's mode labels (SessionMode). Redrawn whenever the
  // atom changes.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const text = describe(await read($, cache))
    if (text === undefined) return next(e)
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, text] } })
  })

  // The cache lives from the start of the turn's last request (requestStartedAt), not
  // from the end of its answer: a long answer has used up part of the lifetime. Without
  // requestStartedAt (cleared by a compaction, model switch or /clear during the turn)
  // the end of the turn is the fallback. An interrupted turn may or may not have
  // reached the cache; keep the old expiry. An answer has written the cache, so a
  // reset by an automatic compaction in the middle of the turn is spent: isReset ends
  // here, not only at the next prompt.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    isTurnRunning = false
    const now = await $.clock.now()
    const isAnswer = Boolean(e.usage) && e.reason === 'answer'
    let tokens = 0
    if (isAnswer) {
      // Neither e.usage nor context.tokens is the live context: both sum several
      // requests. The status line's percentage of the window is.
      const { context } = await $.session.usage()
      tokens = Math.round(((context.percent ?? 0) / 100) * context.window)
      if (lastActivity === 0) lastActivity = now
    }
    // One write, so the footer never shows the turn as over with the old expiry.
    await update($, cache, (c: CacheWarm) => ({
      ...c,
      ...(isAnswer
        ? {
            expiresAt: (c.requestStartedAt ?? now) + CACHE_TTL_MS,
            now,
            tokens,
            isReset: false,
          }
        : {}),
      requestStartedAt: undefined,
      note: c.note === TURN_NOTE ? '' : c.note,
    }))
    if (isAnswer && (await read($, cache)).isEnabled) {
      timer ??= $.clock.every(1000, () => void tick($))
    }
    return next(e)
  })
}
