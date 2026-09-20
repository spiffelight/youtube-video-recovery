# Notes for AMO reviewers

Paste the relevant parts of this into the **"Notes for Reviewers"** field when
submitting. It is excluded from the packaged XPI.

## What the add-on does

On a YouTube watch page where the video cannot be played — private, deleted,
region-blocked, age-gated — it adds a panel to the player area showing
what the video was: title, channel, publish date and a thumbnail, recovered
from public archives.

## No account or credentials needed

The add-on has no accounts, no login, no paid tier and no server of its own.

## How to test it

The add-on only does anything on a watch page for a video that will not play.
A normal video shows nothing at all, so testing needs one of these:

| URL | Expected |
|---|---|
| `https://www.youtube.com/watch?v=X1gxkuNzMf4` | **PRIVATE** badge, title *"▶️RERUN▶️【UNARCHIVED KARAOKE】A TRIBUTE TO LOVE SONGS ~! 💄"*, channel *Elizabeth Rose Bloodflame Ch. hololive*, thumbnail, and a note that a full copy exists on archive.org |
| `https://www.youtube.com/watch?v=jrjTiWbtny0` | **PRIVATE** badge, title *"【UNARCHIVED ROCK & METAL KARAOKE】rip throat #calliolive"*, channel *Mori Calliope Ch. hololive-EN*, published 2026-06-15, plus a 3,096 MB archived copy |
| `https://www.youtube.com/watch?v=o1he09EtejI` | **DELETED** badge, title *"Sendung mit der Maus: Aufklärung über Liebe"*, channel *GrummligerTroll*, published 2010-05-20. A deliberately old case: the recovered record comes from a 2019 capture of a 2010 upload |
| `https://www.youtube.com/watch?v=AAAAAAAAAAA` | No record found. The panel explicitly says the video may never have existed rather than inventing one |
| `https://www.youtube.com/watch?v=jNQXAC9IVRw` | Nothing — the video plays normally, so no panel appears |

These are live third-party videos whose state could change. If one now plays
normally, the panel correctly does nothing; any other private or deleted video
works for testing.

A lookup takes 10–30 seconds on first run because archive.org is slow. Progress
is shown per source, and results are cached afterwards.

**Firefox host permissions:** because this is MV3, site access is not granted
at install. If the panel does not appear, grant access for `youtube.com`,
`archive.org` and `web.archive.org` under about:addons → Permissions.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `storage` | Caches lookup results so a repeat visit answers instantly, and remembers nothing else |
| `https://www.youtube.com/*` | Content script on `/watch` and `/live` pages; also the oEmbed endpoint used to tell a private video from a deleted one |
| `https://web.archive.org/*` | Wayback CDX index and archived watch pages |
| `https://archive.org/*` | Item metadata and community mirrors |
| `history` *(optional)* | Off by default. If granted, the video ID is looked up in local history: a match supplies the original title and proves the video existed |
| `bookmarks` *(optional)* | Off by default. Same purpose, for a bookmark saved while the video was alive |

The two optional permissions are requested only from the add-on's own options
page, by explicit user action, and the add-on is fully functional without them.

## Data transmission

Declared in the manifest as `browsingActivity` (required).

The only thing sent off-device is the **11-character YouTube video ID of the
page being viewed**, to `archive.org` and `web.archive.org`, over HTTPS, in
order to look up an archived copy. That is the add-on's entire purpose.

Nothing else is transmitted. Specifically there is **no** analytics, telemetry,
advertising, fingerprinting, or third-party server of ours; no cookies are set
or read; and no identifier of any kind is attached to the lookups. History and
bookmark matches are used only to fill in the panel locally and never leave the
browser.

`storage.local` holds cached results keyed by video ID (30 days for a found
record, 6 hours for a miss). The options page shows the count and can clear it.

## Notes on the code

- No build step. The submitted package **is** the source: plain ES5-style
  JavaScript, no bundler, no minification, no transpilation, no dependencies.
- No remote code is loaded or executed. There is no `eval`, no `new Function`,
  and no injected `<script>`.
- The panel is built entirely with `createElement` / `textContent`. `innerHTML`
  is never assigned — YouTube sets `require-trusted-types-for 'script'`, and
  the add-on does not relax it or any other page security header.
- `background.service_worker` is present alongside `background.scripts` for
  Chrome compatibility. Firefox correctly ignores it and uses `scripts`;
  `web-ext lint` notes this as expected.
- Desktop only. The content script matches `www.youtube.com` only, and the
  panel's layout targets the desktop watch page.
- Two URL shapes are handled: `/watch?v=<id>` and `/live/<id>`. A livestream
  that has ended keeps the `/live/` form, which carries the id in the path and
  has no `v` parameter.

## Tests included in the repository (not in the XPI)

`test/run.mjs` live integration against the four video IDs above,
`test/flow.mjs` background state machine, `test/timeout.mjs` timeout/abort
behaviour against a server that never responds, `test/audit.mjs` dead code and
permission audit.
