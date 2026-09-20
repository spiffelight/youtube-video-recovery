# AMO listing copy

Paste-ready text for the addons.mozilla.org listing fields. Excluded from the
packaged XPI.

Policy 1 ("No Surprises") requires the listing to say plainly what the add-on
does *and what it transmits*, so both are stated up front rather than buried.

---

## Name

    YouTube Recall

## Summary (max 250 characters)

    Shows what a YouTube video was when it can't be played. On a private, deleted or blocked video, it adds a panel with the title, channel, date and thumbnail, recovered from the Wayback Machine and archive.org.

## Description

Each paragraph below is a single unbroken line on purpose: the AMO field
renders hard line breaks, so wrapping the text here pastes a ragged
column-narrow result onto the product page.

    YouTube tells you "Video unavailable" and nothing else. This add-on tells you what the video actually was.

    On a private, deleted, region-blocked or age-gated video it adds a panel to the player area with the recovered title, channel, publish date, duration and thumbnail. When more survived, the view and like counts and the description are there too — and when someone has archived the video itself, it links to that copy.

    HOW IT WORKS

    First it checks things that are instant: the page's own data, and optionally your browsing history, which often still holds the title of a video you watched before it disappeared. If that finds an answer, you get it immediately, and the slow archive search waits for you to start it with a button.

    If not, it searches the Wayback Machine and archive.org, showing what it is checking and what each source found, with a button to stop. A first lookup can take 10-30 seconds, because archive.org is slow. Results are cached, so coming back to that video answers instantly, and you can see and clear the stored results in the add-on's options.

    WHAT IT SENDS

    Only the video ID of the page you are looking at, to archive.org and web.archive.org, to look up an archived copy. There is no analytics, no telemetry, no advertising, no tracking and no server of our own, and nothing identifies you. If you turn on the optional history or bookmark lookups, those are searched on your own machine and never leave your browser.

    FIRST RUN

    Firefox does not grant site access when the add-on is installed. If the panel does not appear, allow access for youtube.com, archive.org and web.archive.org in about:addons.

    Not affiliated with YouTube, Google, or the Internet Archive.

## Categories

    Suggested: "Search Tools" or "Other"

## Tags

    youtube, archive, wayback-machine, deleted-video, metadata

## Privacy policy

    The add-on transmits one thing: the 11-character YouTube video ID of the page you are viewing. It is sent over HTTPS to archive.org and web.archive.org in order to look up an archived record of that video. Those services' own privacy policies apply to requests they receive.

    Nothing else is transmitted. The add-on has no server, collects no analytics or telemetry, sets and reads no cookies, and attaches no identifier of any kind to its requests.

    The optional browsing-history and bookmark permissions, which are off unless you turn them on, are used only to search your own machine for the title of the video you are looking at. Those results are displayed in the panel and never leave your browser.

    Lookup results are cached in the add-on's local storage, keyed by video ID, for 30 days when a record was found and 6 hours when it was not. This data stays on your computer. The add-on's options page shows how many results are cached and lets you delete them at any time.

## Compatibility

    Firefox for desktop, 140.0 and later. Not submitted for Firefox for
    Android: the panel's layout targets the desktop watch page and has not
    been tested on mobile.

## License

    Select "MIT License" in the AMO license dropdown. The repository carries a
    matching LICENSE file, which is also inside the submitted package.
