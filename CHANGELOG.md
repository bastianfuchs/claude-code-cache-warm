# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.1] - 2026-10-13

### Fixed

- The refresh prompt now says that it is an automated keep-alive, that no tools are
  to be used and that the whole reply is "ok". Before, many refreshes read the
  context twice from the cache, which is a second model request per refresh. The
  likely cause was that the model tried to use a tool or to look into the prompt;
  with the new text this no longer showed in testing.

### Added

- With `debugWarnings` on, a warning line says when a refresh read at least 1.8 times
  as many tokens from the cache as the last request of your turn took in.

### Removed

- The counter for refreshes with double-reads in `/cache-warm status`, which 0.2.0
  added. The warning line replaces it.

## [0.2.0] - 2026-10-13

### Added

- `/cache-warm status` counts the refreshes with double-reads (estimated), the ones
  that read the context twice from the cache.

## [0.1.1] - 2026-10-13

### Fixed

- Refreshes now carry their start time in the prompt. With a fixed text, later
  refreshes of a run could come back as a copy of the first, which renews nothing,
  and the next prompt then rewrote almost the whole cache. The cause is not known.

### Added

- The `debugWarnings` line says whether a turn or a refresh made the last cache use.

## [0.1.0] - 2026-10-12

### Added

- Footer countdown of the prompt-cache lifetime, counted from the start of the last
  request that read or wrote the cache.
- Refresh: a cheap side request shortly before the cache expires, until
  `idleLimitMinutes` without a prompt. The first refresh checks that caching works
  and switches the mod off if it does not.
- Commands `/cache-warm start`, `stop`, `pause` and `status`. `pause` holds back
  refreshes until the next prompt.
- Counters in `/cache-warm status`: refreshes sent and estimated cold prompts.
- Options `autoStart`, `cacheTtlMinutes`, `refreshLeadSeconds`, `idleLimitMinutes`
  and `debugWarnings`. With `debugWarnings`, a warning line and an
  `unexpected rewrites (estimated)` counter report requests that read under half
  of their input from a cache shown as warm. The line gives the time left in the
  footer and the time since the last cache use.
- Pauses in the footer while a turn or a compaction runs. A compaction and a model
  switch show the cache as cold.
