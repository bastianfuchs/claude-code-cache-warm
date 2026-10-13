# cache-warm

A Claude Code mod that shows the prompt-cache countdown in the footer and keeps the
cache warm while you are away from the keyboard.

```
cache warm 3:42 (2 refreshes)
```

## Why

The model API caches the conversation for 5 minutes (by default), counted from the
start of each request. A cached read costs a fraction of an uncached one. If you pause
longer than that (reading, a meeting, a coffee), your next prompt pays full price for
the whole context again.

cache-warm sends a tiny side request shortly before the cache expires. That request
is served from the cache and renews its lifetime. By default it stops after 30
minutes without a prompt (`idleLimitMinutes`). The cache then stays warm for up to
one more cache lifetime.

> **Assumes the standard 5-minute prompt cache.** If your setup uses the 1-hour
> cache, set `cacheTtlMinutes` first (see [Configuration](#configuration)).

## Install

Type this at the prompt of a terminal session:

```
/plugin install cache-warm --marketplace bastianfuchs/claude-code-cache-warm
```

Answer `y` to add the marketplace, then choose a scope (user scope applies to all
your sessions). The mod is active right away.

## What the footer shows

| Footer | Meaning |
|---|---|
| `cache warm m:ss` | Time left until the cache expires. Until the first refresh has read the cache, this assumes that caching works (see [Cost](#cost)). |
| `cache cold` | Cache has expired (or a compaction or a model switch just ran). The next prompt rewrites it. |
| `cache keep-warm off` | The first refresh found no cache hit; the mod switched itself off. |
| `(N refreshes)` | Refreshes sent since your last prompt. Starts again from 0 with each prompt. |
| `, last X.Xs` | Added inside the brackets when the latest refresh took half of the refresh lead or longer (15 seconds with the default lead of 30). |
| `paused (turn)` | A turn is running; it renews the cache itself, so no refresh is sent. The countdown restarts at your prompt and again with each model request of the turn. |
| `paused (compact)` | A compaction is running; a refresh would warm a context about to be replaced. |
| `paused (until next prompt)` | You typed `/cache-warm pause`. No refreshes; your next prompt ends it. |
| `idle limit reached` | Your last prompt is older than `idleLimitMinutes`; no more refreshes, the countdown runs out. |
| `refresh failed: <reason>` | The last refresh did not get an answer; retried after 15 seconds. |

## Command

| Command | Effect |
|---|---|
| `/cache-warm start` | Turns cache-warm on for the running session. |
| `/cache-warm stop` | Turns it off for the running session: no footer entry, no countdown, no refreshes, and prompts are no longer counted as cold. |
| `/cache-warm pause` | No refreshes until your next prompt, for an absence you know is long. The countdown runs out; the prompt after it is not counted as cold. `start` ends the pause earlier. |
| `/cache-warm status` | Prints the state, the counters and the active settings. Plain `/cache-warm` does the same. |

The state is one of:

- `active`
- `paused (until next prompt)`: after `/cache-warm pause`.
- `stopped (start with /cache-warm start)`: after `/cache-warm stop`, or in a new
  session when `autoStart` is off.
- `disabled (DISABLE_PROMPT_CACHING=1)`: with the value found, see [Cost](#cost).
- `disabled (caching verification: first refresh read no tokens from cache)`: the
  first refresh found no cache hit. The footer then shows `keep-warm off`.

`start` and `stop` last for the running session only, and changing a setting in
`/config` does not undo them. `/clear` resets the counters to 0 but keeps the last
`start` or `stop`. Whether a new session starts with cache-warm on is the
`autoStart` option (see [Configuration](#configuration)). While stopped, no timer
runs. To disable the mod for good, use `/plugin disable cache-warm`.

The counters count per session and start at 0 with a new one:

- **refreshes sent:** all successful refreshes so far, across prompts.
- **cold prompts (estimated):** prompts sent after the countdown had reached `cold`
  because the cache lifetime ran out, which paid the full price to rewrite the
  context. Prompts after a compaction, a model switch, `/clear` or a pause are not
  counted: the first three empty the cache whether or not it was kept warm, and a
  pause lets it run out on purpose, so the counter stays comparable with and without
  cache-warm. An estimate: it follows the configured cache lifetime, not the real
  cache state.

- **unexpected rewrites (estimated):** only with `debugWarnings` on (see
  [Configuration](#configuration)). Requests that read less than half of their input
  from a cache the footer showed as warm, counted for your turns and for refreshes.
  A large pasted prompt counts too, so this is a hint, not proof of a discarded
  cache.

Compare `refreshes sent` with `cold prompts` to see whether keeping the cache warm
paid off. A cold prompt costs about as much as 25 refreshes of the same context on
Sonnet 5.5 and Opus 5.5, and 12.5 on Haiku 5.5. Other models differ (see
[Cost](#cost)).

## Configuration

Install shows a screen for these options. Later, change them in the config menu
(`/config`). A change reloads the mod.

| Option | Default | Meaning |
|---|---|---|
| `autoStart` | on | Whether cache-warm is on when a session starts. Off: type `/cache-warm start` when you want it. |
| `cacheTtlMinutes` | 5 | Cache lifetime, a choice of `5` (standard cache) or `60` (1-hour cache). |
| `refreshLeadSeconds` | 30 | A refresh is sent this long before the cache expires. Accepted: 5 to 600, and the effective lead is capped at half of `cacheTtlMinutes` (150 s at 5 minutes). |
| `idleLimitMinutes` | 30 | No refreshes once your last prompt is older than this. |
| `debugWarnings` | off | For watching the cache: a warning line under the prompt and an `unexpected rewrites (estimated)` counter in `/cache-warm status` when a request reads less than half of its input from a cache the footer shows as warm. Covers your turns and the refreshes. The line also gives the time the footer showed as left, the time since the last cache use and whether a turn or a refresh made it, which tells an early eviction from a long gap. A large pasted prompt can trigger it too. A second kind of line warns when a refresh read at least 1.8 times as many tokens from the cache as the last request of your turn took in, which a refresh does not normally do; it is not counted. There is one line at a time, a newer one replaces the older, and it stays until your next prompt. |

A value that is not a number or out of range (5 to 600 seconds lead, 1 to 720
minutes idle limit) falls back to its default.

## Cost

Each refresh re-reads your whole context from the cache at the cached-read price (a
fraction of the normal input price) plus a few output tokens. With the defaults it
runs roughly every 4 minutes 30 seconds, at most about 6 times per absence (30-minute
idle limit). With a large context this is visible on the bill, though far below
what one cold prompt costs.

Examples, with the prices per million tokens for a cache read and for a cache write
(5 minutes):

- Sonnet 5.5: $0.10 and $2.50.
- Opus 5.5: $0.20 and $5.
- Haiku 5.5: $0.01 and $0.125 for prompts up to 100k tokens, $0.05 and $0.625 above.
  The higher price applies to the whole prompt.

| Model | Context | One refresh | Six refreshes | One cold rewrite |
|---|---|---|---|---|
| Sonnet 5.5 | 100k tokens | $0.010 | $0.06 | $0.25 |
| Sonnet 5.5 | 1M tokens | $0.10 | $0.60 | $2.50 |
| Opus 5.5 | 100k tokens | $0.020 | $0.12 | $0.50 |
| Opus 5.5 | 1M tokens | $0.20 | $1.20 | $5.00 |
| Haiku 5.5 | 100k tokens | $0.001 | $0.006 | $0.0125 |
| Haiku 5.5 | 200k tokens | $0.010 | $0.06 | $0.125 |

Output tokens add a little per refresh. Six refreshes cost less than one rewrite,
but they are wasted if you do not come back. Other models have other prices and
another ratio between a cache read and a cache write, so the numbers above do not
carry over. They are the prices of the Anthropic API. Other services such as Amazon
Bedrock can charge more, depending on the region. Check the
[pricing page](https://platform.claude.com/docs/en/about-claude/pricing) and your
provider's price list.

The footer assumes that caching works and says `warm` from your first prompt. The
first refresh checks that: it must read at least some tokens from the cache. If it
reads none, your gateway or setup does not pass caching through. The mod then
switches itself off, the footer shows `keep-warm off` and a toast tells you. That
one refresh was billed at the normal input price (no cache read, no cache write) and
renewed nothing; no further one is sent. Each session checks afresh, so switching
between gateways needs no setting.

If the environment variable `DISABLE_PROMPT_CACHING` is set to `1`, `true`, `yes` or
`on` (any case; `0` or empty does not count), Claude Code sends no cache markers, so
there is nothing to keep warm. The mod then stays off for the session and shows a
toast, whatever `autoStart` says, and `/cache-warm start` refuses. The variable is
read at session start only.

## Limits

- **The mod cannot detect the cache lifetime.** It assumes 5 minutes. With the
  1-hour cache, set `cacheTtlMinutes` to 60 (see [Configuration](#configuration));
  left at 5, the countdown is wrong (it shows `cold` after 5 minutes) and every
  refresh is wasted money. A wrong value is never caught by the mod.
- The cache lifetime counts from the start of a model request, not from the end of
  its answer. After a long answer the footer shows the time that is really left, for
  example 1:00 after an answer that took 4 minutes. A single request that takes
  longer than the cache lifetime lets the cache expire while it runs.
- **If you interrupt a turn (ESC) before the answer has started, the footer falls
  back to the countdown from before your prompt.** The mod cannot tell whether your
  request had already reached the cache. The footer may then show less time than is
  left, never more. A prompt after that can count as a cold prompt although the
  cache was renewed. Once the first text has appeared, the interrupted request
  counts like a finished one.
- After a compaction the display shows `cold` until your next prompt. The compaction
  does not cache the new, shorter context. Your next prompt writes it to the cache.
- **A change of effort level is not detected.** Claude Code warns that it may
  discard the cached conversation, as a model switch does. Some setups keep the
  cache, but the mod gets no signal either way. Until your next prompt the footer
  still shows `warm`. If the cache was discarded, that prompt pays the full price and
  is not counted as a cold prompt. A model switch is detected: the footer shows
  `cold` at once.

## Development

Run it from the folder instead of installing:

```
claude --plugin-dir /path/to/cache-warm
```

or set `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (`env` block). Saving
`hooks/register.tsx` reloads the mod in a running session. Check the manifest with
`claude plugin validate /path/to/cache-warm`.

The type declarations in `.claude-plugin/types/` are written by Claude Code when it
loads the mod from a folder. They are not part of the repository. `tsconfig.json`
refers to them, so an editor reports missing types until you have loaded it once.

`RETRY_DELAY_MS` at the top of `hooks/register.tsx` is not an option. Edit it there.

For maintainers: `claude plugin update` looks at the `version` in
`.claude-plugin/plugin.json`. Raise it with every release, or installed copies are
not offered the change.
