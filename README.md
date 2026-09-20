# YouTube Recall

A Firefox/Chrome extension that answers "what *was* this?" when YouTube shows
**Video unavailable**. It renders a card in the player area with the
title, channel, publish date, duration, counts, description and — when one
survives anywhere — a thumbnail.

Works for private videos, deleted videos, region blocks, copyright blocks and
age gates.

## Install

**Firefox** — `about:debugging` → *This Firefox* → *Load Temporary Add-on* →
pick `manifest.json`. Temporary add-ons are unloaded when Firefox closes; for a
persistent install the package needs signing via AMO.

> **Then grant site access.** Firefox MV3 does *not* grant `host_permissions`
> at install, so a freshly loaded add-on can reach nothing and every lookup
> comes back empty. Open `about:addons` → **YouTube Recall** →
> **Permissions**, and enable access for `youtube.com`, `archive.org` and
> `web.archive.org`. This is the single most likely reason for the panel not
> appearing at all.

**Chrome / Edge** — `chrome://extensions` → enable *Developer mode* → *Load
unpacked* → pick this folder. Chrome grants host permissions at install, so
there is no extra step.

Optional local lookups (history, bookmarks) are off by default. Turn them on in
the extension's options page; the extension is fully functional without them.

## How it works

YouTube's "unavailable" is not one state, and the states leak very different
amounts of information. Measured, not assumed:

| State | `playabilityStatus` | oEmbed | Thumbnail | Metadata on page? |
|---|---|---|---|---|
| Region-blocked | `UNPLAYABLE` | 200 | 200 | yes — no archive needed |
| Age-restricted | `LOGIN_REQUIRED` | 200 | 200 | yes |
| Copyright block | `UNPLAYABLE` | varies | often 200 | partial; reason names the claimant |
| Private | `LOGIN_REQUIRED` | **403** | 404 | no |
| Deleted | `ERROR` | **404** | 404 | no |
| Never existed | `ERROR` | **404** | 404 | no |

So the panel only reaches for archives when the page genuinely has nothing,
and `oembed 403 vs 404` is the cheap discriminator between *private* and
*gone*.

### Two phases, with a pause between them

The lookup is split by cost, because the two halves behave very differently:

- **Fast phase** (~1s): the page itself, this browser's history/bookmarks, and
  what YouTube still admits to via oEmbed and its thumbnail CDN.
- **Archive phase** (10–30s): archive.org and the Wayback Machine.

If the fast phase finds a title, the archive phase **does not run**. The card
appears immediately with a *Search archives* button, because the archives are
a slow question worth asking rather than assuming — what they add is a
thumbnail and, sometimes, a full recording.

If the fast phase finds nothing, the archives run automatically; there is
nothing to show otherwise.

Results stream as they land rather than being withheld until every probe
finishes, and each stage reports its own outcome, so a long lookup reads as
work rather than a hang. A paused result is cached with `complete: false`, so
revisiting the video answers instantly and still offers the archive search.

Because parts arrive in whatever order the network returns them, the merged
result is **rebuilt from the raw parts on every update** rather than mutated
in place — field precedence must not depend on which request happened to
finish first.

### Probe chain

0. **The URL** — `/watch?v=<id>` or `/live/<id>`. An ended livestream keeps
   the `/live/` form, with the id in the path and no `v` parameter, so reading
   only the query string missed those entirely.
1. **The page itself** — `ytInitialPlayerResponse`, read out of the inline
   script (content scripts cannot see page globals). Region/age cases stop here.
2. **This browser** — history and bookmarks, if permitted. Instant, no network,
   and the only source that proves the video *existed*.
3. **oEmbed** — state discriminator.
4. **`i.ytimg.com`** with `cache: 'force-cache'` — free if the viewer has the
   thumbnail cached; thumbnails also sometimes outlive the video.
5. **`archive.org/metadata/youtube-<ID>`** — direct key lookup, `{}` on miss.
   A hit often includes the actual video file.
6. **Wayback CDX + `id_` replay** — the general-purpose fallback.
7. **archive.org full-text search** — for mirrors under non-standard identifiers.

Filmot and Holodex are linked out to rather than queried: Filmot sits behind
Cloudflare (403 to `fetch`), and Holodex needs an API key that cannot be safely
shipped in an extension.

## Things that were not obvious

Each of these was found by measurement and cost real debugging time.

**Pick the Wayback capture by content, not size.** For a video deleted in 2019,
the 2024 capture was 504 KB and the 2018 one 193 KB — and the *larger* one was
a post-mortem snapshot of the tombstone page with an empty title. The chain
walks captures newest-first and takes the first with a non-empty title, which
also yields the title the video carried when it died.

**Wayback's `id_` endpoint returns gzip with no `Content-Encoding` header,** so
nothing decompresses it automatically. Sniff the magic bytes and run it through
`DecompressionStream('gzip')`.

**`playabilityStatus.reason` is localized** — the same restriction arrives
translated into whatever language the viewer's YouTube is in, so any check
written against the English wording is written against one language out of
many. Branch on `status` codes only; the reason string is for display.

**Full-text search will confidently return the wrong video.** Searching the
nonexistent ID `AAAAAAAAAAA` matched a fails compilation whose *description*
contained a run of capital A's, and then an unrelated item holding
`AAAAAAAAAAA.rar`. Every search hit is now verified twice: the item must look
like a YouTube mirror at all, and the ID must appear in a structured field
(identifier, filename, source URL) or inside a YouTube URL in free text.
Matching is case-sensitive, because YouTube IDs are and archive.org's index
is not.

**Private and deleted videos have no `videoDetails`,** so SPA staleness cannot
be detected by comparing `videoDetails.videoId` — that check fails on exactly
the videos this extension exists for. The inline script is trusted only when
the URL's id still matches the id the document was served for.

**Deleted videos skew old and YouTube's HTML has been rewritten repeatedly.**
A 2010 capture exposes `"author"` and a bare `datePublished`; a 2026 capture
hides the same facts in `ytInitialPlayerResponse`. Extraction is layered per
field across eras.

**A content script's `window` is not its global in Firefox.** In Chrome the
isolated world's `window` *is* the content script global, so `window.Foo`
resolves a value another content script assigned to `globalThis`. In Firefox
`window` is an Xray wrapper around the page's window while the script's global
is a separate sandbox, so the same lookup silently yields `undefined` and the
script throws on first use — with no visible symptom beyond the background
script never waking. Shared state is read through an unqualified reference,
which resolves correctly in both.

**Firefox MV3 does not grant `host_permissions` at install.** Chrome does. An
add-on that works immediately in Chrome reaches nothing in Firefox until the
user grants site access, which looks identical to "the archives had no record".
The background checks `permissions.contains` up front and the panel says so
explicitly.

**YouTube sets `require-trusted-types-for 'script'`.** The panel is built with
`createElement`/`textContent` — no `innerHTML` anywhere. There is no `img-src`
directive, so cross-origin archived thumbnails render fine.

## Development

```bash
node test/run.mjs
```

Live integration check against four real IDs in known states: private, deleted,
alive, and never-existed. The last is a fabrication guard — it must come back
empty. Takes a few minutes; archive.org is slow and rate-limits (429/504 are
normal, and the client backs off).

```bash
node test/classify.mjs    # playabilityStatus mapping, incl. the no-panel cases
node test/flow.mjs        # background state machine
node test/dom-order.mjs   # anchors to the visible error box (needs Chrome)
node test/audit.mjs       # dead code, permissions, package contents
```

`classify.mjs` and `dom-order.mjs` both exist because of bugs that shipped: a
scheduled livestream reports `LIVE_STREAM_OFFLINE`, which had no case and fell
through to UNKNOWN, putting an "UNAVAILABLE" card on a healthy upcoming
stream; and `insertionPoint` used `document.querySelector`, which returned the
first `#full-bleed-container` in the document rather than the one holding this
error box, so the card rendered *above* it. The harness now contains a decoy
element reproducing that trap.

```bash
WATCH_SECONDS=55 node test/live-firefox.mjs
```

The only check that stubs nothing: loads the real add-on into a real Firefox
via `web-ext run` and visits real YouTube, asserting against the add-on's own
console output. It is what confirms the Firefox-specific parts — the sandbox
global, `background.scripts`, MV3 host permissions — and that a working video
is never even looked at. Slow, needs network, and depends on live third-party
videos keeping their state, so it is not part of the routine suite.

Two things make it work: `web-ext run` has no `--headless` flag for
firefox-desktop (the browser reads `MOZ_HEADLESS`), and web-ext discards the
browser's stdout unless `--verbose`, which is where the content script's
output arrives.

```bash
node test/flow.mjs
```

Runs the real `background.js` against stubbed browser APIs with the probes
faked, covering fresh lookup, pause, resume and missing permissions. Fast and
offline.

This exists because a bug that froze the panel indefinitely lived in the
background's control flow, not in any probe: `cacheGet` returns `null` on a
cache miss, and `null` was being used as the abort signal, so every
first-time lookup returned immediately without starting. The preview harness
stubs the background out entirely and could never have caught it. Set
`YTRP_BACKGROUND=/path/to/copy.js` to run these checks against a modified
copy — useful for confirming they still fail when the flow regresses.

```bash
node test/make-preview.mjs
```

Captures real probe output to `test/preview-data.js`, then `test/preview.html`
renders the panel through the real `content.js` with the background script
stubbed on a replayed timeline. Serve the folder and open
`test/preview.html`. Query flags select the case:

| Flag | Shows |
|---|---|
| `?v=X1gxkuNzMf4` | archives run automatically, full result |
| `?v=X1gxkuNzMf4&local=1` | found locally → **paused** with *Search archives* |
| `?v=AAAAAAAAAAA` | nothing found anywhere |
| `&noaccess=1` | host permissions not granted |
| `&slow=1` | 3× slower, to watch the progress card |
| `&hold=1` | freezes mid-progress for inspection |

Two things about the harness are load-bearing. The stylesheet is cache-busted,
because `python -m http.server` sends no cache headers and a stale `panel.css`
makes the preview quietly lie about current styling. And measurements must be
taken with the tab **fronted**: background tabs throttle rendering, so CSS
transitions never advance and animated widths read as `0px`.

```bash
npx web-ext lint --source-dir=. --self-hosted
```

Mozilla's own validator. Should report **0 errors**. Two warnings are expected
and intentional: `BACKGROUND_SERVICE_WORKER_IGNORED` (the `service_worker` key
exists for Chrome and is correctly ignored by Firefox, which uses
`background.scripts`) and `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`
(`data_collection_permissions` on Firefox for Android; this is a desktop
extension).

## Bounding the lookup

Archive lookups are slow and sometimes never answer at all — archive.org will
accept a connection and then hold it open indefinitely. Four things keep that
from becoming a spinner with no end:

| Bound | Value |
|---|---|
| Per-request timeout | 15s (35s for an archived watch page, which is large) |
| Retry on 429/503/504 | up to 3 attempts, exponential backoff |
| Retry on timeout | 2 attempts — the server already had its full window |
| Whole archive phase | 120s deadline, then every in-flight request is aborted |

A stage that is retrying shows `retrying 2/3` rather than looking stalled, and
one that is abandoned reports **timed out** or **stopped** rather than
"nothing" — a source that never answered has not told you it has no record.
There is also a **×** control to stop the search by hand; whatever is already
on the card stays.

A lookup that timed out or was stopped is cached for its speed but is *not*
marked complete, so the archives can be tried again later.

## Storage

Everything lives in the extension's own `storage.local`, on this machine. No
data is sent anywhere; the only outbound requests are the archive lookups
themselves, which carry the video ID and nothing else.

| | |
|---|---|
| Key | `rec:<videoId>` |
| Found records | kept 30 days |
| Misses | kept 6 hours |
| Pruning | expired entries swept on ~5% of writes |
| Survives browser restart | yes — it is not session storage |

The options page shows how many results are cached and has a button to clear
them.

One caveat specific to development: a **temporary** add-on is unloaded when
Firefox closes, and storage tied to a temporary extension ID should not be
relied on to survive. For a signed, permanently installed build it persists
normally.

## Submitting to addons.mozilla.org

```bash
npx web-ext lint --source-dir=. --self-hosted   # expect 0 errors
node test/audit.mjs                             # expect AUDIT CLEAN
npx web-ext build --source-dir=. --overwrite-dest
```

The built `.zip` in `web-ext-artifacts/` is the upload. It contains nine
files — the add-on, its icon and its licence — and no tests, configs or docs.
The licence is in the package because MIT requires the notice to travel with
copies of the software; the other documents here are excluded.

- **[REVIEWERS.md](REVIEWERS.md)** — paste into "Notes for Reviewers". The
  add-on does nothing on a working video, so reviewers need known-dead video
  IDs to test with; they are listed there along with per-permission
  justification.
- **[LISTING.md](LISTING.md)** — name, summary, description and privacy
  policy, written to satisfy policy 1 ("No Surprises"), which requires the
  listing to state what the add-on transmits.

Two points worth knowing before you submit:

**Data collection must be declared accurately.** Under policy 6.2.1, a
Firefox 140+ add-on using the built-in consent experience must state its data
practices in the manifest per Mozilla's taxonomy. This add-on sends the video
ID of the page being viewed to the Internet Archive, which is `browsingActivity`
("specific URLs, domains, or categories of pages users view"). Declaring
`none` here would be a false declaration.

**Set the listing to desktop only.** The content script matches
`www.youtube.com` only and the panel targets the desktop watch page; Firefox
for Android is untested. `web-ext lint` notes
`KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` for exactly this reason —
it is expected, and resolved by the compatibility setting in the AMO listing
rather than in the manifest.

## Limitations

- **Deleted and never-existed are indistinguishable from YouTube alone.** With
  no archive hit and no local history, the panel says so rather than guessing.
- A private video hidden before any crawler saw it is unrecoverable.
- History only keeps the most recent title per URL, so if you revisited the
  page after it died, your history holds the tombstone title. Those are
  filtered out rather than shown, and the step reports **"seen before, no
  title"** rather than "found" — the URL match still proves the video
  existed, but it has nothing to display, and history is not then listed
  among the sources of a title it did not supply.
- The archive chain takes tens of seconds on a cold lookup. Results are cached
  (30 days for hits, 6 hours for misses) and the local pass renders first.

## License

MIT — see [LICENSE](LICENSE).
