/*
 * content.js — detects an unavailable video and renders the recovered record
 * in the watch page's player area, next to YouTube's error box.
 *
 * Built entirely with createElement/textContent. YouTube sends
 * `require-trusted-types-for 'script'`, and assigning innerHTML is both the
 * thing that policy exists to stop and unnecessary here.
 */
(function () {
  'use strict';

  var ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

  /*
   * Read the shared module off the bare global, NOT off `window`.
   *
   * In Chrome a content script's `window` is its own isolated global, so
   * `window.YTRecoverCore` resolves. In Firefox `window` is an Xray wrapper
   * around the *page's* window while core.js assigned to the sandbox global —
   * two different objects — so `window.YTRecoverCore` is undefined and every
   * later use throws. An unqualified reference finds the sandbox global in
   * Firefox and the isolated global in Chrome.
   */
  var core = (typeof YTRecoverCore !== 'undefined') ? YTRecoverCore : null;
  if (!core) {
    console.error('[yt-recover] core.js did not load; check the manifest content_scripts order');
    return;
  }

  var PANEL_ID = 'ytrp-panel';

  /*
   * Deliberately always on. The failure mode of this extension is "nothing
   * appears", which is indistinguishable from "not installed" without a
   * trace of how far it got.
   */
  function log() {
    var args = ['[yt-recover]'].concat(Array.prototype.slice.call(arguments));
    console.log.apply(console, args);
  }

  /* -------------------------------------------------------------- *
   * Reading the page's own state
   * -------------------------------------------------------------- */

  /*
   * Content scripts run in an isolated world, so window.ytInitialPlayerResponse
   * is not reachable. The value is, however, assigned in an inline <script> in
   * the document YouTube served, so it can be read back out of the source.
   *
   * Brace-balanced rather than regex: the blob contains nested objects and
   * braces inside strings.
   */
  function extractJsonAfter(text, marker) {
    var at = text.indexOf(marker);
    if (at === -1) return null;
    var start = text.indexOf('{', at);
    if (start === -1) return null;

    var depth = 0, inStr = false, esc = false;
    for (var i = start; i < text.length; i++) {
      var c = text[i];
      if (inStr) {
        if (esc) { esc = false; }
        else if (c === '\\') { esc = true; }
        else if (c === '"') { inStr = false; }
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') { depth++; continue; }
      if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); }
          catch (e) { return null; }
        }
      }
    }
    return null;
  }

  function readPlayerResponse() {
    var scripts = document.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var t = scripts[i].textContent;
      if (!t || t.indexOf('ytInitialPlayerResponse') === -1) continue;
      var pr = extractJsonAfter(t, 'ytInitialPlayerResponse');
      if (pr && pr.playabilityStatus) return pr;
    }
    return null;
  }

  function currentVideoId() {
    return core.videoIdFromUrl(location.href);
  }

  /*
   * The error box, newest markup first. On a current desktop page this is
   * `yt-playability-error-supported-renderers#error-screen`, nested inside
   * `#player-full-bleed-container` — note the `yt-` prefix; the older
   * `ytd-`-prefixed element no longer exists.
   */
  var ERROR_SELECTORS = [
    'yt-playability-error-supported-renderers#error-screen',
    'yt-playability-error-supported-renderers',
    'ytd-playability-error-supported-renderers',
    '#error-screen',
    '#player-unavailable'
  ];

  var reportedSelector = null;

  /*
   * Does this element put anything on screen?
   *
   * Not a plain rect test. `yt-playability-error-supported-renderers` is a
   * custom element and can be `display: contents`, generating no box of its
   * own while its children render normally — so an element with no rect may
   * still be the real, visible error box. Its descendants are what settle it.
   */
  function isRendered(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
    var kids = el.querySelectorAll('*');
    for (var i = 0; i < kids.length; i++) {
      var kr = kids[i].getBoundingClientRect();
      if (kr.width > 0 && kr.height > 0) return true;
    }
    return false;
  }

  /*
   * Pick the error box that is actually on screen.
   *
   * `document.querySelector` returns the first match in document order, which
   * is not necessarily the visible one: YouTube can hold a hidden placeholder
   * earlier in the DOM. Anchoring to that put the whole panel above the real
   * error box. Every match is considered, and the first rendered one wins;
   * if none render, the first match is used so the panel still appears.
   */
  function findErrorAnchor() {
    var firstMatch = null;

    for (var i = 0; i < ERROR_SELECTORS.length; i++) {
      var found = document.querySelectorAll(ERROR_SELECTORS[i]);
      for (var j = 0; j < found.length; j++) {
        if (!firstMatch) firstMatch = found[j];
        if (!isRendered(found[j])) continue;

        if (reportedSelector !== ERROR_SELECTORS[i]) {
          reportedSelector = ERROR_SELECTORS[i];
          log('error box matched:', ERROR_SELECTORS[i],
              '(' + (j + 1) + ' of ' + found.length + ')',
              '- own layout boxes:', found[j].getClientRects().length);
        }
        return found[j];
      }
    }

    if (firstMatch && reportedSelector !== 'fallback') {
      reportedSelector = 'fallback';
      log('no rendered error box found; using the first match as a fallback');
    }
    return firstMatch;
  }

  // Ancestors that mark the end of the player area. The card is attached
  // beside the outermost player wrapper.
  //
  // Where it lands relative to the error graphic depends on how YouTube has
  // laid the watch page out, and in practice it often ends up above it. That
  // is accepted: the card is adjacent to the player area either way, which is
  // what matters. What is NOT accepted is anchoring to the wrong element
  // entirely — see findErrorAnchor.
  var PAGE_ROOTS = /^(YTD-WATCH-FLEXY|YTD-PAGE-MANAGER|BODY)$/;

  /*
   * Walk up from the error box rather than searching the document.
   *
   * An earlier version did `document.querySelector('#full-bleed-container')`,
   * which returns the *first* match in document order — not necessarily the
   * one containing this error box. On a real watch page that resolved to an
   * earlier container, so the card was inserted above the error box instead
   * of beside it. Climbing from the anchor cannot pick the wrong element.
   */
  function insertionPoint(anchor) {
    var node = anchor;
    while (node.parentElement && !PAGE_ROOTS.test(node.parentElement.tagName)) {
      node = node.parentElement;
    }
    return node.parentElement ? node : anchor;
  }

  /* -------------------------------------------------------------- *
   * Formatting
   * -------------------------------------------------------------- */

  function fmtDate(value) {
    if (!value) return null;
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value).slice(0, 10);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function fmtDuration(s) {
    if (!s || s <= 0) return null;
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    var mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
  }

  function fmtCount(n) {
    if (n === null || n === undefined) return null;
    try { return Number(n).toLocaleString(); } catch (e) { return String(n); }
  }

  /* -------------------------------------------------------------- *
   * DOM building
   * -------------------------------------------------------------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function link(href, text, cls) {
    var a = el('a', cls || 'ytrp-link', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  var BADGES = {
    'private': ['Private', 'ytrp-badge--private'],
    'deleted': ['Deleted', 'ytrp-badge--deleted'],
    'gone-unconfirmed': ['Unavailable', 'ytrp-badge--unknown'],
    'age': ['Age-restricted', 'ytrp-badge--limited'],
    'unplayable': ['Blocked', 'ytrp-badge--limited'],
    'unknown': ['Unavailable', 'ytrp-badge--unknown']
  };

  function shell(verdict, statusText) {
    var root = el('section', 'ytrp');
    root.id = PANEL_ID;

    var head = el('div', 'ytrp-head');
    var badge = BADGES[verdict] || BADGES.unknown;
    head.appendChild(el('span', 'ytrp-badge ' + badge[1], badge[0]));
    head.appendChild(el('span', 'ytrp-status', statusText || ''));
    root.appendChild(head);
    return root;
  }

  function metaRow(pairs) {
    var row = el('div', 'ytrp-meta');
    var any = false;
    pairs.forEach(function (p) {
      if (!p[1]) return;
      any = true;
      var item = el('span', 'ytrp-meta-item');
      item.appendChild(el('span', 'ytrp-meta-k', p[0]));
      item.appendChild(el('span', 'ytrp-meta-v', p[1]));
      row.appendChild(item);
    });
    return any ? row : null;
  }

  function thumbBlock(url, sourceLabel) {
    var wrap = el('div', 'ytrp-thumb');
    var img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = url;
    // An archived image URL can still 404; collapse rather than show a broken
    // box, and reclaim the column the grid was holding for it.
    img.addEventListener('error', function () {
      var body = wrap.parentElement;
      wrap.remove();
      if (body) body.classList.add('ytrp-body--nothumb');
    });
    wrap.appendChild(img);
    if (sourceLabel) wrap.appendChild(el('span', 'ytrp-thumb-src', sourceLabel));
    return wrap;
  }

  function descBlock(text) {
    if (!text) return null;
    var wrap = el('div', 'ytrp-desc-wrap');
    var p = el('p', 'ytrp-desc', text.trim());
    wrap.appendChild(p);

    // Only offer expansion when there is something hidden.
    if (text.trim().length > 260) {
      var btn = el('button', 'ytrp-more', 'Show more');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        var open = p.classList.toggle('ytrp-desc--open');
        btn.textContent = open ? 'Show less' : 'Show more';
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function linksRow(links) {
    var row = el('div', 'ytrp-links');
    row.appendChild(el('span', 'ytrp-links-label', 'Search'));
    links.forEach(function (l) { row.appendChild(link(l.url, l.label, 'ytrp-chip')); });
    return row;
  }

  /* -------------------------------------------------------------- *
   * Panel states
   * -------------------------------------------------------------- */

  var SOURCE_NAMES = {
    'wayback': 'Wayback Machine',
    'archive.org': 'archive.org',
    'your history': 'your history',
    'your bookmarks': 'your bookmarks'
  };

  /*
   * The strip under a result card.
   *
   * A paused lookup is the interesting case: something was found cheaply, and
   * the archives are a separate, slow question — worth offering rather than
   * spending thirty seconds on by default.
   */
  /*
   * Names the source still outstanding rather than saying "archives".
   *
   * The archive sources run concurrently, so one can land a full result while
   * another is still going — at which point a generic "Searching archives…"
   * under a complete-looking card reads as though it is searching for
   * something it already has.
   */
  function searchingText(stageState) {
    var running = STAGES.filter(function (s) {
      return stageState[s.key] === 'running';
    }).map(function (s) { return s.label; });

    if (!running.length) return 'Finishing…';
    if (running.length === 1) return 'Also checking ' + running[0] + '…';
    return 'Also checking ' + running.slice(0, -1).join(', ') +
           ' and ' + running[running.length - 1] + '…';
  }

  function archiveFooter(flags, stageState, onResume, onStop) {
    if (flags.done) return null;

    var wrap = el('div', 'ytrp-hint ytrp-footer');
    if (flags.paused) {
      wrap.appendChild(el('span', null,
        'Archives not searched yet — they may hold a thumbnail or a full recording. '));
      var btn = el('button', 'ytrp-more', 'Search archives');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        wrap.textContent = '';
        wrap.appendChild(el('span', 'ytrp-footer-text', 'Starting…'));
        onResume();
      });
      wrap.appendChild(btn);
    } else {
      wrap.appendChild(el('span', 'ytrp-footer-text', searchingText(stageState)));
      // Archive lookups can be slow enough that abandoning them is a
      // reasonable choice; what is already on the card is kept either way.
      var stop = el('button', 'ytrp-stop', '×');
      stop.type = 'button';
      stop.title = 'Stop searching';
      stop.setAttribute('aria-label', 'Stop searching');
      stop.addEventListener('click', function () {
        stop.remove();
        var txt = wrap.querySelector('.ytrp-footer-text');
        if (txt) { txt.classList.remove('ytrp-footer-text'); txt.textContent = 'Stopped.'; }
        onStop();
      });
      wrap.appendChild(stop);
    }
    return wrap;
  }

  function renderFound(verdict, r, extra) {
    var srcLabel = r.sources && r.sources.length
      ? 'Recovered from ' + r.sources.map(function (s) {
          return (SOURCE_NAMES[s.kind] || s.kind) + (s.date ? ' · ' + fmtDate(s.date) : '');
        }).join('  +  ')
      : 'Recovered from archives';

    var root = shell(verdict, srcLabel);
    // Without an image the reserved thumbnail column just squeezes the text.
    var body = el('div', 'ytrp-body' + (r.thumbnail ? '' : ' ytrp-body--nothumb'));

    if (r.thumbnail) body.appendChild(thumbBlock(r.thumbnail, r.thumbnailSource));

    var info = el('div', 'ytrp-info');
    info.appendChild(el('h3', 'ytrp-title', r.title));

    if (r.channel) {
      var chLine = el('div', 'ytrp-channel');
      if (r.channelId) {
        chLine.appendChild(link('https://www.youtube.com/channel/' + r.channelId,
                                r.channel, 'ytrp-channel-link'));
      } else {
        chLine.appendChild(el('span', 'ytrp-channel-link', r.channel));
      }
      info.appendChild(chLine);
    }

    var row = metaRow([
      ['Published', fmtDate(r.published)],
      ['Duration', fmtDuration(r.duration)],
      ['Views', fmtCount(r.views)],
      ['Likes', fmtCount(r.likes)],
      ['Type', r.isLive ? 'Live stream' : null]
    ]);
    if (row) info.appendChild(row);

    var desc = descBlock(r.description);
    if (desc) info.appendChild(desc);

    // A community mirror means the video itself survived, not just its title.
    if (r.mirror && r.sources) {
      var iaSource = r.sources.filter(function (s) { return s.kind === 'archive.org'; })[0];
      if (iaSource) {
        var m = el('div', 'ytrp-mirror');
        m.appendChild(el('span', 'ytrp-mirror-icon', '▶'));
        var size = r.mirror.sizeMB ? ' (' + fmtCount(r.mirror.sizeMB) + ' MB)' : '';
        m.appendChild(el('span', null, 'A full copy is archived' + size + ' — '));
        m.appendChild(link(iaSource.url, 'open on archive.org'));
        info.appendChild(m);
      }
    }

    if (extra) info.appendChild(extra);
    if (r.links) info.appendChild(linksRow(r.links));

    body.appendChild(info);
    root.appendChild(body);
    return root;
  }

  function optionsButton(label) {
    var btn = el('button', 'ytrp-more', label);
    btn.type = 'button';
    btn.addEventListener('click', function () {
      ext.runtime.sendMessage({ type: 'openOptions' }).catch(function () {});
    });
    return btn;
  }

  /*
   * Firefox MV3 installs without host permissions, so the archive lookup is
   * blocked until the user grants them. Without this the panel would just sit
   * there reporting that nothing was found.
   */
  function renderNeedsAccess(verdict, r) {
    var root = shell(verdict, 'Archive access not granted');
    var body = el('div', 'ytrp-body ytrp-body--empty');
    var info = el('div', 'ytrp-info');
    info.appendChild(el('p', 'ytrp-empty',
      'Firefox does not grant add-ons access to other sites at install time. ' +
      'Allow access to the Internet Archive once, and lookups will work.'));
    var hint = el('div', 'ytrp-hint');
    hint.appendChild(optionsButton('Grant archive access'));
    info.appendChild(hint);
    if (r && r.links) info.appendChild(linksRow(r.links));
    body.appendChild(info);
    root.appendChild(body);
    return root;
  }

  // Offered only when local lookups are off, since they are the one source
  // that can answer instantly and confirm the video ever existed.
  function localHint() {
    var wrap = el('div', 'ytrp-hint');
    wrap.appendChild(el('span', null, 'Your own history may still have the title. '));
    wrap.appendChild(optionsButton('Enable local lookups'));
    return wrap;
  }

  function renderNotFound(verdict, r) {
    var root = shell(verdict, 'No archived record found');
    var body = el('div', 'ytrp-body ytrp-body--empty');
    var info = el('div', 'ytrp-info');

    /*
     * YouTube answers identically for "deleted last week" and "no such
     * video", so absence of an archive hit cannot distinguish them. Say that
     * plainly instead of implying the video existed.
     */
    var msg;
    if (verdict === 'private') {
      msg = 'This video is private and no public archive captured it before it was hidden.';
    } else if (r && r.existed) {
      msg = 'You visited this video before, so it did exist — but no title was recorded locally and no public archive has a copy.';
    } else {
      msg = 'Nothing in the Wayback Machine or archive.org references this ID. It was either never crawled, or never existed — YouTube returns the same error for both.';
    }

    info.appendChild(el('p', 'ytrp-empty', msg));
    if (r && r.localAvailable === false) info.appendChild(localHint());
    if (r && r.links) info.appendChild(linksRow(r.links));
    body.appendChild(info);
    root.appendChild(body);
    return root;
  }

  var STAGES = [
    { key: 'local', label: 'Your history' },
    { key: 'youtube', label: 'YouTube' },
    { key: 'ia', label: 'archive.org' },
    { key: 'wayback', label: 'Wayback Machine' }
  ];

  var STAGE_NOTE = {
    pending: 'waiting',
    running: 'checking…',
    hit: 'found',
    // Matched, but with nothing displayable — see the `partial` note in
    // background.js on history keeping only the most recent title per URL.
    partial: 'seen before, no title',
    miss: 'nothing',
    // The source refused to answer; it did not say there was no record.
    unavailable: 'no answer',
    timeout: 'timed out',
    stopped: 'stopped'
  };

  var STAGE_ICON = {
    pending: '·', hit: '✓', partial: '✓', miss: '–',
    running: '', retry: '', timeout: '✗', stopped: '✗', unavailable: '!'
  };

  function stageNote(state, detail) {
    if (state === 'retry' && detail && detail.attempt) {
      return 'retrying ' + detail.attempt + '/' + detail.max + '…';
    }
    return STAGE_NOTE[state] || '';
  }

  /*
   * The lookup takes tens of seconds against archive.org, so a bare spinner
   * is indistinguishable from a hang. Naming the source currently outstanding
   * makes the wait legible — and the per-source outcomes are worth seeing in
   * their own right, since "archive.org: nothing" is a real answer.
   */
  // States a stage cannot move on from; anything else still counts as work.
  var SETTLED = {
    hit: true, partial: true, miss: true,
    timeout: true, stopped: true, unavailable: true
  };

  function renderProgress(verdict) {
    var root = shell(verdict, 'Looking for a record of this video…');
    var wrap = el('div', 'ytrp-progress');

    var bar = el('div', 'ytrp-bar');
    var fill = el('div', 'ytrp-bar-fill');
    bar.appendChild(fill);
    wrap.appendChild(bar);

    var list = el('div', 'ytrp-steps');
    var rows = {};
    STAGES.forEach(function (s) {
      var row = el('div', 'ytrp-step ytrp-step--pending');
      var icon = el('span', 'ytrp-step-icon', STAGE_ICON.pending);
      var note = el('span', 'ytrp-step-note', STAGE_NOTE.pending);
      row.appendChild(icon);
      row.appendChild(el('span', 'ytrp-step-label', s.label));
      row.appendChild(note);
      list.appendChild(row);
      rows[s.key] = { row: row, icon: icon, note: note, state: 'pending' };
    });
    wrap.appendChild(list);
    root.appendChild(wrap);

    function refreshBar() {
      var total = 0, done = 0;
      Object.keys(rows).forEach(function (k) {
        total++;
        if (SETTLED[rows[k].state]) done++;
      });
      fill.style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
    }

    var titleEl = null;

    return {
      root: root,

      update: function (stage, state, detail) {
        var r = rows[stage];
        if (!r) return;
        // A source the user has not enabled is dropped rather than shown as
        // failing, and stops counting toward the total.
        if (state === 'skipped') {
          r.row.remove();
          delete rows[stage];
          refreshBar();
          return;
        }
        r.state = state;
        // A retry is still the same stage working, so it keeps the running
        // spinner and only changes its note.
        r.row.className = 'ytrp-step ytrp-step--' + (state === 'retry' ? 'running' : state);
        r.icon.textContent = STAGE_ICON[state] || '';
        r.note.textContent = stageNote(state, detail);
        refreshBar();
      },

      // A local hit arrives long before the archives answer; show it at once
      // rather than making the person wait for a title we already have.
      setEarlyTitle: function (title, kind) {
        if (titleEl) { titleEl.textContent = title; return; }
        titleEl = el('h3', 'ytrp-title', title);
        wrap.insertBefore(titleEl, bar);
        wrap.insertBefore(el('div', 'ytrp-early', 'from ' + kind + ' — still checking archives'), bar);
      }
    };
  }

  // Region-blocked and age-restricted videos keep their metadata on the page,
  // so they are rendered straight from it without touching the network.
  function renderFromPage(verdict, state) {
    var i = state.info || {};
    var r = {
      title: i.title,
      channel: i.channel,
      channelId: i.channelId,
      description: i.description,
      duration: i.duration,
      views: i.views,
      likes: null,
      published: null,
      isLive: false,
      thumbnail: 'https://i.ytimg.com/vi/' + currentVideoId() + '/hqdefault.jpg',
      thumbnailSource: 'YouTube',
      sources: [],
      links: core.externalLinks(currentVideoId())
    };
    var root = renderFound(verdict, r);
    var status = root.querySelector('.ytrp-status');
    if (status) status.textContent = state.reason || 'Metadata still published by YouTube';
    return root;
  }

  /* -------------------------------------------------------------- *
   * Mount
   * -------------------------------------------------------------- */

  function removePanel() {
    var old = document.getElementById(PANEL_ID);
    if (old) old.remove();
  }

  /*
   * Firefox caches extension resources across a temporary add-on reload, and
   * it does not always invalidate the stylesheet. The result is new markup
   * styled by an old panel.css: the card renders, but its layout rules are
   * missing and the steps collapse into run-together text. Checked once, so
   * that looks-broken becomes a named cause in the console.
   */
  var cssChecked = false;

  function verifyStyles(root) {
    if (cssChecked) return;
    cssChecked = true;
    var probe = el('div', 'ytrp-step');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    root.appendChild(probe);
    var applied = getComputedStyle(probe).display === 'grid';
    probe.remove();
    if (!applied) {
      log('panel.css is stale or missing (.ytrp-step is not a grid). ' +
          'Remove the add-on and load it again to clear Firefox\'s extension cache.');
    }
  }

  function mount(node, anchor) {
    removePanel();
    var target = insertionPoint(anchor);
    if (target && target.parentNode) {
      target.parentNode.insertBefore(node, target.nextSibling);
      verifyStyles(node);
    } else {
      log('could not insert panel — no usable container');
    }
  }

  var activeId = null;

  /*
   * The id this document was served for. The inline ytInitialPlayerResponse
   * describes this video and nothing else: after an SPA navigation it is
   * stale, and it cannot be re-derived by comparing videoDetails.videoId
   * because private and deleted videos carry no videoDetails at all.
   */
  var documentId = currentVideoId();

  function run(id, anchor) {
    var pr = id === documentId ? readPlayerResponse() : null;
    var state = pr
      ? core.classify(pr)
      : { state: core.STATE.UNKNOWN, reason: null, info: null };

    log('anchor found for', id, '- status:', state.status || '(unreadable)',
        'state:', state.state);

    if (core.healthy(state.state)) { removePanel(); return; }

    /*
     * A status we successfully read but do not recognise is not a reason to
     * guess. Only an unreadable player response (an SPA navigation, where
     * `pr` is null) justifies falling back to asking the network.
     */
    if (pr && state.state === core.STATE.UNKNOWN) {
      log('unhandled playability status:', state.status, '- leaving the page alone');
      removePanel();
      return;
    }

    if (core.selfSufficient(state.state) && state.info) {
      mount(renderFromPage(state.state, state), anchor);
      return;
    }

    var verdict = state.state === core.STATE.PRIVATE ? 'private'
                : state.state === core.STATE.GONE ? 'deleted'
                : 'unknown';

    var progress = renderProgress(verdict);
    mount(progress.root, anchor);

    var port;
    try {
      port = ext.runtime.connect({ name: 'recover' });
    } catch (e) {
      log('could not connect to background:', (e && e.message) || e);
      removePanel();
      return;
    }

    var stageState = {};

    function resume() {
      log('resuming archive search for', id);
      try { port.postMessage({ type: 'resume', id: id }); } catch (e) {}
    }

    function stop() {
      log('stopping archive search for', id);
      try { port.postMessage({ type: 'stop', id: id }); } catch (e) {}
    }

    port.onMessage.addListener(function (m) {
      if (!m || activeId !== id) return;

      if (m.type === 'progress') {
        stageState[m.stage] = m.state;
        progress.update(m.stage, m.state, m.detail);
        // Update the footer in place; re-rendering the card would reload the
        // thumbnail and flicker.
        var footer = document.querySelector('#' + PANEL_ID + ' .ytrp-footer-text');
        if (footer) footer.textContent = searchingText(stageState);
        return;
      }

      if (m.type !== 'update') return;

      var anchorNow = findErrorAnchor();
      if (!anchorNow) return;

      var r = m.result;
      if (m.error) log('lookup error:', m.error);

      if (!r) {
        if (m.done) { log('lookup produced no result'); removePanel(); }
        return;
      }

      var v = r.verdict || verdict;

      // After an SPA navigation the state came from oEmbed; if that says the
      // video is fine, there is nothing to show.
      if (core.healthy(v)) {
        log('video is available - removing panel');
        removePanel();
        return;
      }

      log('update - verdict:', v, 'found:', r.found, 'paused:', !!m.paused,
          'done:', !!m.done, 'sources:',
          (r.sources || []).map(function (s) { return s.kind; }).join(',') || 'none');

      if (r.needsHostAccess) { mount(renderNeedsAccess(v, r), anchorNow); return; }

      /*
       * Results are shown the moment there is anything to show, and replaced
       * as better sources land, rather than withheld until every probe has
       * finished.
       */
      if (r.found) {
        mount(renderFound(v, r, archiveFooter(m, stageState, resume, stop)), anchorNow);
      } else if (m.done) {
        mount(renderNotFound(v, r), anchorNow);
      } else if (!document.getElementById(PANEL_ID)) {
        mount(progress.root, anchorNow);
      }
    });

    port.postMessage({ type: 'start', id: id, state: state.state });
  }

  function tick() {
    var id = currentVideoId();
    if (!id) { removePanel(); activeId = null; return; }

    var anchor = findErrorAnchor();
    if (!anchor) {
      if (activeId) { removePanel(); activeId = null; }
      return;
    }
    if (id === activeId && document.getElementById(PANEL_ID)) return;

    activeId = id;
    run(id, anchor);
  }

  var pending = null;
  function schedule() {
    if (pending) return;
    pending = setTimeout(function () { pending = null; tick(); }, 300);
  }

  // YouTube is a single-page app; the error box appears and disappears
  // without a document load.
  window.addEventListener('yt-navigate-finish', schedule, true);
  window.addEventListener('popstate', schedule, true);

  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var t = records[i].target;
      // Ignore our own insertions, or the observer re-triggers itself.
      if (t && t.closest && t.closest('#' + PANEL_ID)) continue;
      schedule();
      return;
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // If this line appears but "anchor found" never does, the error box did not
  // match any known selector — a markup change rather than a permissions or
  // loading problem.
  log('loaded on', location.pathname + location.search, '- video id:', documentId);

  schedule();

  // One-shot check so a silent no-op still leaves a trace in the console.
  setTimeout(function () {
    if (document.getElementById(PANEL_ID)) return;
    if (findErrorAnchor()) return;
    log('no error box found after 8s — either the video plays normally, ' +
        'or none of these selectors matched:', ERROR_SELECTORS.join(', '));
  }, 8000);
})();
