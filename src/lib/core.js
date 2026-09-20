/*
 * core.js — classification + archive probes.
 *
 * Pure logic: no DOM, no extension APIs. Shared by the background script and
 * the Node test runner (test/run.mjs), so it must stay environment-neutral.
 */
(function (root, factory) {
  var api = factory();
  root.YTRecoverCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * State model
   *
   * Keyed on playabilityStatus.status only. The `reason` string YouTube
   * ships is localized ("Privat video" on a sv-SE session), so it is safe
   * to display but never safe to branch on.
   * ------------------------------------------------------------------ */
  var STATE = {
    OK: 'ok',
    PRIVATE: 'private',
    GONE: 'gone',              // deleted OR never existed — indistinguishable
    UPCOMING: 'upcoming',      // scheduled or offline livestream — not missing
    AGE_RESTRICTED: 'age',
    UNPLAYABLE: 'unplayable',  // region block, copyright block, terminated
    UNKNOWN: 'unknown'
  };

  var VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

  /*
   * The video id for a watch page, from any of the URL shapes YouTube uses.
   *
   * It is not always `/watch?v=<id>`: a livestream that has ended keeps its
   * `/live/<id>` URL, where the id is in the path and there is no `v`
   * parameter at all. Reading only the query string missed those entirely.
   */
  function videoIdFromUrl(href) {
    var url;
    try { url = new URL(href); } catch (e) { return null; }

    var v = url.searchParams.get('v');
    if (v && VIDEO_ID.test(v)) return v;

    /*
     * Deliberately parses more shapes than the manifest injects on. The
     * content script is only declared for /watch and /live, but YouTube is a
     * single-page app: an already-running script can be carried to a /shorts
     * or /embed URL by in-page navigation, and it needs to read those too.
     */
    var path = url.pathname.match(/^\/(?:live|shorts|embed|v)\/([A-Za-z0-9_-]{11})/);
    if (path) return path[1];

    // youtu.be/<id> normally redirects to /watch, but handle it anyway.
    if (/(^|\.)youtu\.be$/i.test(url.hostname)) {
      var short = url.pathname.match(/^\/([A-Za-z0-9_-]{11})/);
      if (short) return short[1];
    }
    return null;
  }

  // States where YouTube still hands us full metadata; no archive needed.
  function selfSufficient(state) {
    return state === STATE.OK ||
           state === STATE.AGE_RESTRICTED ||
           state === STATE.UNPLAYABLE;
  }

  // Nothing to recover: the video is fine, or simply has not started yet.
  function healthy(state) {
    return state === STATE.OK || state === STATE.UPCOMING;
  }

  function textOf(node) {
    if (!node) return null;
    if (typeof node === 'string') return node;
    if (node.simpleText) return node.simpleText;
    if (Array.isArray(node.runs)) {
      return node.runs.map(function (r) { return r.text || ''; }).join('');
    }
    return null;
  }

  function classify(pr) {
    var ps = (pr && pr.playabilityStatus) || {};
    var vd = (pr && pr.videoDetails) || null;
    var status = ps.status || null;
    var err = ps.errorScreen && ps.errorScreen.playerErrorMessageRenderer;
    var hasMetadata = !!(vd && vd.title);
    var state;

    switch (status) {
      case 'OK':
        state = STATE.OK; break;
      case 'LOGIN_REQUIRED':
        // Age-gated videos keep their metadata; private ones do not.
        state = hasMetadata ? STATE.AGE_RESTRICTED : STATE.PRIVATE; break;
      case 'AGE_VERIFICATION_REQUIRED':
      case 'CONTENT_CHECK_REQUIRED':
        state = STATE.AGE_RESTRICTED; break;
      case 'ERROR':
        state = STATE.GONE; break;
      /*
       * A scheduled premiere or an offline livestream. The video is not
       * missing — it simply has not started. Without this case it fell
       * through to UNKNOWN, which triggered a recovery lookup and put an
       * "UNAVAILABLE" card on a perfectly healthy upcoming stream.
       */
      case 'LIVE_STREAM_OFFLINE':
        state = STATE.UPCOMING; break;
      case 'UNPLAYABLE':
        state = STATE.UNPLAYABLE; break;
      default:
        state = STATE.UNKNOWN;
    }

    return {
      status: status,
      state: state,
      reason: textOf(ps.reason),
      subreason: err ? textOf(err.subreason) : null,
      hasMetadata: hasMetadata,
      info: hasMetadata ? fromVideoDetails(vd) : null
    };
  }

  function fromVideoDetails(vd) {
    return {
      title: vd.title || null,
      channel: vd.author || null,
      channelId: vd.channelId || null,
      description: vd.shortDescription || null,
      duration: vd.lengthSeconds ? Number(vd.lengthSeconds) : null,
      views: vd.viewCount ? Number(vd.viewCount) : null,
      published: null,
      thumbnail: null
    };
  }

  /* ------------------------------------------------------------------ *
   * HTML / JSON scraping helpers
   * ------------------------------------------------------------------ */

  var NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'"
  };

  function decodeEntities(s) {
    if (!s) return s;
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, ent) {
      if (ent.charAt(0) === '#') {
        var code = ent.charAt(1) === 'x' || ent.charAt(1) === 'X'
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
        return isFinite(code) ? String.fromCodePoint(code) : m;
      }
      var hit = NAMED_ENTITIES[ent.toLowerCase()];
      return hit === undefined ? m : hit;
    });
  }

  // Parse every <meta> tag into an attribute bag, order-independent.
  function metaTags(html) {
    var out = [];
    var tagRe = /<meta\b[^>]*>/gi;
    var m;
    while ((m = tagRe.exec(html))) {
      var attrs = {};
      var attrRe = /([a-zA-Z:_-]+)\s*=\s*"([^"]*)"/g;
      var a;
      while ((a = attrRe.exec(m[0]))) attrs[a[1].toLowerCase()] = a[2];
      out.push(attrs);
    }
    return out;
  }

  function metaContent(tags, key) {
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      if ((t.property === key || t.name === key || t.itemprop === key) &&
          t.content != null && t.content !== '') {
        return decodeEntities(t.content);
      }
    }
    return null;
  }

  // Matches a JSON string value inside raw page source, honouring escapes.
  var JSON_STR_BODY = '((?:[^"\\\\]|\\\\.)*)';

  function jsonStr(html, key) {
    var re = new RegExp('"' + key + '"\\s*:\\s*"' + JSON_STR_BODY + '"');
    var m = html.match(re);
    if (!m) return null;
    try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
  }

  function firstNonEmpty() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== null && v !== undefined && String(v).trim() !== '') return v;
    }
    return null;
  }

  /*
   * Extract metadata from an archived watch page.
   *
   * Deleted videos skew old, and YouTube's HTML has been rewritten several
   * times. A 2010 capture exposes "author" and a bare datePublished; a 2026
   * capture hides the same facts inside ytInitialPlayerResponse. Each field
   * is therefore tried across eras, newest markup first.
   */
  function parseArchivedPage(html) {
    if (!html) return null;
    var tags = metaTags(html);

    var title = firstNonEmpty(
      metaContent(tags, 'og:title'),
      metaContent(tags, 'title'),
      metaContent(tags, 'name'),
      (function () {
        var m = html.match(/<title>([^<]*)<\/title>/i);
        if (!m) return null;
        return decodeEntities(m[1]).replace(/\s*-\s*YouTube\s*$/, '').trim();
      })()
    );

    // A capture taken after the video died parses fine but yields no title.
    // That is the signal the caller uses to keep walking back through time.
    if (!title) return null;

    var channel = firstNonEmpty(
      jsonStr(html, 'ownerChannelName'),
      jsonStr(html, 'author'),
      (function () {
        // <span itemprop="author"><link itemprop="name" content="...">
        var m = html.match(/itemprop="author"[\s\S]{0,400}?itemprop="name"[^>]*content="([^"]*)"/i);
        return m ? decodeEntities(m[1]) : null;
      })()
    );

    var channelId = firstNonEmpty(
      jsonStr(html, 'externalChannelId'),
      jsonStr(html, 'channelId'),
      (function () {
        var m = html.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/);
        return m ? m[1] : null;
      })()
    );

    var published = firstNonEmpty(
      metaContent(tags, 'uploadDate'),
      metaContent(tags, 'datePublished'),
      jsonStr(html, 'publishDate'),
      jsonStr(html, 'uploadDate')
    );

    var lengthSeconds = jsonStr(html, 'lengthSeconds');
    var duration = lengthSeconds ? Number(lengthSeconds) : null;
    if (!duration) {
      var iso = metaContent(tags, 'duration');           // PT1H2M3S
      if (iso) {
        var d = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (d) duration = (+(d[1] || 0)) * 3600 + (+(d[2] || 0)) * 60 + (+(d[3] || 0));
      }
    }
    if (!duration) duration = null;

    var views = null;
    var vc = jsonStr(html, 'viewCount');
    if (vc && /^\d+$/.test(vc)) views = Number(vc);
    if (views === null) {
      // <meta itemprop="interactionType" .../><meta itemprop="userInteractionCount" content="N">
      var wm = html.match(/WatchAction[\s\S]{0,200}?userInteractionCount"\s*content="(\d+)"/i);
      if (wm) views = Number(wm[1]);
    }

    var likes = null;
    var lm = html.match(/LikeAction[\s\S]{0,200}?userInteractionCount"\s*content="(\d+)"/i);
    if (lm) likes = Number(lm[1]);

    var description = firstNonEmpty(
      jsonStr(html, 'shortDescription'),
      metaContent(tags, 'og:description'),
      metaContent(tags, 'description')
    );

    var isLive = /"isLiveContent"\s*:\s*true/.test(html);

    return {
      title: title,
      channel: channel,
      channelId: channelId,
      published: published,
      duration: duration,
      views: views,
      likes: likes,
      description: description,
      isLive: isLive,
      thumbnail: metaContent(tags, 'og:image')
    };
  }

  /* ------------------------------------------------------------------ *
   * Networking: rate limiting, gzip, fetch helpers
   * ------------------------------------------------------------------ */

  // archive.org rate-limits hard (429) and times out (504) under casual load.
  // An extension firing on every dead video hits this far sooner than a human
  // does, so every outbound request goes through one small queue.
  function makeLimiter(concurrency, minGapMs) {
    var active = 0, last = 0, queue = [];

    function pump() {
      if (active >= concurrency || !queue.length) return;
      var wait = Math.max(0, last + minGapMs - Date.now());
      setTimeout(function () {
        var job = queue.shift();
        if (!job) return;
        active++;
        last = Date.now();
        job.run().then(job.resolve, job.reject).then(function () {
          active--;
          pump();
        });
      }, wait);
    }

    return function limit(run) {
      return new Promise(function (resolve, reject) {
        queue.push({ run: run, resolve: resolve, reject: reject });
        pump();
      });
    };
  }

  var limit = makeLimiter(2, 250);

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // Retries 429/503/504 with exponential backoff.
  var REQUEST_TIMEOUT = 15000;
  /*
   * Separate budgets by failure type. A 429/503/504 is transient and backing
   * off genuinely helps. A timeout means the server already had the full
   * window and did not answer, so retrying it twice more mostly just triples
   * the wait — one more try, then give up.
   */
  var MAX_ATTEMPTS = 3;
  var MAX_TIMEOUT_ATTEMPTS = 2;

  function aborted(signal) {
    return !!(signal && signal.aborted);
  }

  // Carries the caller's abort signal and retry reporter into every request.
  function reqOpts(ctx, extra) {
    var o = {};
    if (extra) { for (var k in extra) if (extra.hasOwnProperty(k)) o[k] = extra[k]; }
    if (ctx) {
      o.signal = ctx.signal;
      o.onRetry = ctx.onRetry;
      o.onError = ctx.onError;
      if (ctx.timeout && !o.timeout) o.timeout = ctx.timeout;
    }
    return o;
  }

  /*
   * Retries 429/503/504 and timeouts with exponential backoff.
   *
   * Every request is bounded by its own timeout. Without one a stage can hang
   * indefinitely: archive.org will accept a connection and then simply never
   * answer, and a fetch with no signal waits forever — which shows up as a
   * spinner that never resolves and no way to tell it apart from slow work.
   */
  function request(url, opts, attempt) {
    opts = opts || {};
    attempt = attempt || 0;

    function retry(e, res) {
      var cap = res ? MAX_ATTEMPTS : MAX_TIMEOUT_ATTEMPTS;
      // A deliberate abort is final; only transport failures are retried.
      if (aborted(opts.signal) || attempt + 1 >= cap) {
        if (res) return res;
        throw e;
      }
      if (opts.onRetry) opts.onRetry(attempt + 2, cap);
      return sleep(800 * Math.pow(3, attempt)).then(function () {
        return request(url, opts, attempt + 1);
      });
    }

    return limit(function () {
      if (aborted(opts.signal)) return Promise.reject(new Error('aborted'));

      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = null;
      var onOuterAbort = function () { if (ctl) ctl.abort(); };

      if (ctl) {
        timer = setTimeout(onOuterAbort, opts.timeout || REQUEST_TIMEOUT);
        if (opts.signal) opts.signal.addEventListener('abort', onOuterAbort, { once: true });
      }

      function cleanup() {
        if (timer) clearTimeout(timer);
        if (opts.signal && opts.signal.removeEventListener) {
          opts.signal.removeEventListener('abort', onOuterAbort);
        }
      }

      return fetch(url, {
        credentials: 'omit',
        redirect: 'follow',
        cache: opts.cache || 'default',
        headers: opts.headers || undefined,
        signal: ctl ? ctl.signal : undefined
      }).then(function (res) { cleanup(); return res; },
              function (e) { cleanup(); throw e; });
    }).then(function (res) {
      var retryable = res.status === 429 || res.status === 503 || res.status === 504;
      return retryable ? retry(null, res) : res;
    }, function (e) {
      return retry(e, null);
    });
  }

  /*
   * Wayback's `id_` endpoint replays the original bytes, which for YouTube
   * means gzip *without* a Content-Encoding header — so nothing upstream
   * decompresses it. Sniff the magic number and inflate by hand.
   */
  function readBody(res) {
    return res.arrayBuffer().then(function (ab) {
      var buf = new Uint8Array(ab);
      if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        if (typeof DecompressionStream === 'undefined') {
          throw new Error('gzip body but no DecompressionStream');
        }
        var stream = new Blob([buf]).stream()
          .pipeThrough(new DecompressionStream('gzip'));
        return new Response(stream).text();
      }
      return new TextDecoder('utf-8').decode(buf);
    });
  }

  /*
   * Distinguishes "the source answered, and has no record" from "the source
   * did not answer". archive.org returns 503 under load, and reporting that
   * as `nothing found` claims the archive told us something it never did.
   */
  function getJSON(url, ctx) {
    function failed() {
      if (ctx && ctx.onError) ctx.onError();
      return null;
    }
    return request(url, ctx && ctx.timeout ? ctx : reqOpts(ctx)).then(function (res) {
      if (!res.ok) return failed();
      return res.json().catch(failed);
    }).catch(failed);
  }

  /* ------------------------------------------------------------------ *
   * Probes
   * ------------------------------------------------------------------ */

  var WATCH = 'https://www.youtube.com/watch?v=';

  /*
   * oEmbed is the cheapest state discriminator there is:
   *   200 -> alive and public (or region/age limited)
   *   403 -> exists but restricted  => private
   *   404 -> no such public video   => deleted or never existed
   */
  function probeOEmbed(id, ctx) {
    var url = 'https://www.youtube.com/oembed?format=json&url=' +
              encodeURIComponent(WATCH + id);
    return request(url, reqOpts(ctx)).then(function (res) {
      if (res.status !== 200) return { httpStatus: res.status, info: null };
      return res.json().then(function (j) {
        return {
          httpStatus: 200,
          info: {
            title: j.title || null,
            channel: j.author_name || null,
            channelUrl: j.author_url || null,
            thumbnail: j.thumbnail_url || null
          }
        };
      }).catch(function () { return { httpStatus: 200, info: null }; });
    }).catch(function () { return { httpStatus: 0, info: null }; });
  }

  function cdx(params, ctx) {
    var url = 'https://web.archive.org/cdx/search/cdx?' + params;
    // CDX routinely takes far longer than a plain metadata lookup and answers
    // 504 under load, so it gets its own, longer window.
    return getJSON(url, reqOpts(ctx, { timeout: 30000 })).then(function (rows) {
      if (!Array.isArray(rows) || rows.length < 2) return [];
      var head = rows[0];
      return rows.slice(1).map(function (r) {
        var o = {};
        for (var i = 0; i < head.length; i++) o[head[i]] = r[i];
        return o;
      });
    });
  }

  /*
   * Walk Wayback captures newest-first and take the first one that still has
   * a title.
   *
   * Do NOT pick by size: for a video deleted in 2019, the 2024 capture of the
   * tombstone page was 504 KB while the useful 2018 capture was 193 KB.
   * Newest-first also means the title we surface is the one the video carried
   * when it died, rather than whatever it was called years earlier.
   */
  function probeWayback(id, ctx, maxFetches) {
    maxFetches = maxFetches || 3;
    var q = 'url=' + encodeURIComponent('youtube.com/watch?v=' + id) +
            '&output=json&filter=statuscode:200&collapse=digest&limit=25';
    return cdx(q, ctx).then(function (rows) {
      if (!rows.length) return null;
      rows.sort(function (a, b) { return b.timestamp.localeCompare(a.timestamp); });

      var i = 0;
      function attempt() {
        if (aborted(ctx && ctx.signal)) return Promise.resolve(null);
        if (i >= rows.length || i >= maxFetches) return Promise.resolve(null);
        var row = rows[i++];
        var url = 'https://web.archive.org/web/' + row.timestamp + 'id_/' +
                  (row.original || WATCH + id);
        // Archived watch pages are large; allow longer than a metadata call.
        return request(url, reqOpts(ctx, { timeout: 35000 }))
          .then(readBody)
          .then(function (html) {
            var info = parseArchivedPage(html);
            if (!info) return attempt();   // died before this capture
            info.source = {
              kind: 'wayback',
              timestamp: row.timestamp,
              date: waybackDate(row.timestamp),
              url: 'https://web.archive.org/web/' + row.timestamp + '/' + WATCH + id
            };
            return info;
          })
          .catch(function () {
            if (ctx && ctx.onError) ctx.onError();
            return attempt();
          });
      }
      return attempt();
    }).catch(function () { return null; });
  }

  function waybackDate(ts) {
    if (!ts || ts.length < 8) return null;
    return ts.slice(0, 4) + '-' + ts.slice(4, 6) + '-' + ts.slice(6, 8);
  }

  var IMAGE_RANK = ['maxresdefault', 'sddefault', 'hq720', 'hqdefault', 'mqdefault', 'default'];

  function rankThumb(name) {
    for (var i = 0; i < IMAGE_RANK.length; i++) {
      if (name.indexOf(IMAGE_RANK[i]) !== -1) return i;
    }
    return IMAGE_RANK.length;
  }

  /*
   * Try i.ytimg.com directly before reaching for any archive.
   *
   * `force-cache` means that if the viewer has seen this video before, the
   * image comes straight out of their own HTTP cache with no request at all.
   * Thumbnails also sometimes outlive the video itself on YouTube's CDN, so
   * this occasionally wins outright for a video that is already gone.
   */
  function probeLiveThumbnail(id, ctx) {
    var names = ['maxresdefault', 'hqdefault'];
    var i = 0;

    function attempt() {
      if (i >= names.length) return Promise.resolve(null);
      var url = 'https://i.ytimg.com/vi/' + id + '/' + names[i++] + '.jpg';
      return request(url, reqOpts(ctx, { cache: 'force-cache' }))
        .then(function (res) {
          if (!res.ok) return attempt();
          return { url: url, source: 'YouTube' };
        })
        .catch(function () { return attempt(); });
    }
    return attempt();
  }

  // Thumbnails outlive watch pages surprisingly often — i.ytimg.com URLs get
  // crawled independently, so a dead video can still have a recoverable image.
  function probeArchivedThumbnail(id, ctx) {
    var q = 'url=' + encodeURIComponent('i.ytimg.com/vi/' + id + '/') +
            '&matchType=prefix&output=json&filter=statuscode:200' +
            '&filter=mimetype:image/.*&collapse=urlkey&limit=40';
    return cdx(q, ctx).then(function (rows) {
      if (!rows.length) return null;
      rows.sort(function (a, b) {
        var ra = rankThumb(a.original), rb = rankThumb(b.original);
        if (ra !== rb) return ra - rb;
        return Number(b.length || 0) - Number(a.length || 0);
      });
      var best = rows[0];
      return {
        url: 'https://web.archive.org/web/' + best.timestamp + 'im_/' + best.original,
        source: 'Wayback Machine'
      };
    }).catch(function () { return null; });
  }

  /*
   * archive.org uses a `youtube-<ID>` identifier convention, which turns
   * mirror discovery into a single key lookup instead of a search. An absent
   * item returns `{}` — a clean negative.
   */
  function probeIaItem(id, ctx) {
    return getJSON('https://archive.org/metadata/youtube-' + id, ctx)
      .then(function (d) {
        return iaMentionsId(d, id) ? iaItemToResult(d) : null;
      });
  }

  /*
   * Fallback for mirrors filed under a non-standard identifier — this is how
   * the 4.4 GB hololive mirror was found, since it is not filed as
   * `youtube-<ID>`.
   *
   * Full-text search is the one probe that can confidently return the wrong
   * video: searching a nonexistent ID matched an unrelated fails compilation
   * and reported it as the answer. Every hit is therefore verified against
   * the raw item record before it is allowed to count.
   */
  function probeIaSearch(id, ctx) {
    var url = 'https://archive.org/advancedsearch.php?q=' +
              encodeURIComponent('"' + id + '"') +
              '&fl%5B%5D=identifier&rows=3&page=1&output=json';
    return getJSON(url, ctx).then(function (d) {
      var docs = (d && d.response && d.response.docs) || [];
      if (!docs.length) return null;

      var i = 0;
      function attempt() {
        if (i >= docs.length) return Promise.resolve(null);
        var ident = docs[i++].identifier;
        return getJSON('https://archive.org/metadata/' + ident, ctx).then(function (meta) {
          if (!iaMentionsId(meta, id)) return attempt();
          return iaItemToResult(meta);
        });
      }
      return attempt();
    }).catch(function () { return null; });
  }

  /*
   * True only if the item genuinely references this exact video ID.
   *
   * Matching is case-sensitive on purpose: YouTube IDs are case-sensitive
   * while archive.org's index is not, so a case-insensitive match is one way
   * an unrelated item slips through.
   *
   * The other way is free text. Fields are split by how structured they are:
   * an ID inside an identifier or a filename is a deliberate reference, but
   * an ID inside a description is just a string — a compilation whose
   * description contained a run of capital A's matched the ID "AAAAAAAAAAA"
   * and was reported as a confident answer. Free-text fields must therefore
   * carry a YouTube URL around the ID to count.
   */
  var YT_CONTEXT = ['watch?v=', 'youtu.be/', '/vi/', '/embed/', '/v/', 'video_id=', 'videoId='];

  function inStructuredField(s, id) {
    return String(s).indexOf(id) !== -1;
  }

  function inFreeText(s, id) {
    var str = String(s);
    for (var i = 0; i < YT_CONTEXT.length; i++) {
      if (str.indexOf(YT_CONTEXT[i] + id) !== -1) return true;
    }
    return false;
  }

  function anyValue(md, field, test, id) {
    var v = md[field];
    if (v == null) return false;
    var vals = Array.isArray(v) ? v : [v];
    for (var i = 0; i < vals.length; i++) {
      if (test(vals[i], id)) return true;
    }
    return false;
  }

  /*
   * Is this item a YouTube mirror at all?
   *
   * Required alongside the ID evidence, because the ID can occur innocently:
   * an item holding "AAAAAAAAAAA.rar" matches the ID "AAAAAAAAAAA" in a
   * filename without being a video of any kind.
   */
  function isYouTubeItem(d) {
    var md = d.metadata || {};
    var ident = String(md.identifier || '');

    if (/^youtube-/i.test(ident) || /youtube|yt_archive/i.test(ident)) return true;

    var marked = ['originalurl', 'source', 'external-identifier', 'subject',
                  'collection', 'scanner', 'description'];
    for (var i = 0; i < marked.length; i++) {
      var v = md[marked[i]];
      if (v == null) continue;
      var vals = Array.isArray(v) ? v : [v];
      for (var j = 0; j < vals.length; j++) {
        if (/youtube\.com|youtu\.be|yt-dlp|youtube-dl/i.test(String(vals[j]))) return true;
      }
    }

    // yt-dlp sidecar artifacts are a reliable fingerprint of a real rip.
    var files = d.files || [];
    for (var k = 0; k < files.length; k++) {
      if (/\.(info\.json|description|live_chat\.json)$/i.test(String(files[k].name || ''))) {
        return true;
      }
    }
    return false;
  }

  function iaMentionsId(d, id) {
    if (!d || !d.metadata || !id) return false;
    if (!isYouTubeItem(d)) return false;
    var md = d.metadata;

    // Structured: the ID is there because someone put it there on purpose.
    if (inStructuredField(md.identifier || '', id)) return true;

    var STRUCTURED = ['originalurl', 'source', 'external-identifier'];
    for (var i = 0; i < STRUCTURED.length; i++) {
      if (anyValue(md, STRUCTURED[i], inStructuredField, id)) return true;
    }

    var files = d.files || [];
    for (var k = 0; k < files.length; k++) {
      if (inStructuredField(files[k].name || '', id)) return true;
    }

    // Free text: only counts as a real reference inside a YouTube URL.
    var FREE = ['description', 'title', 'subject', 'notes'];
    for (var j = 0; j < FREE.length; j++) {
      if (anyValue(md, FREE[j], inFreeText, id)) return true;
    }

    return false;
  }

  function iaItemToResult(d) {
    if (!d || !d.metadata || !d.metadata.identifier) return null;
    var md = d.metadata;
    var ident = md.identifier;
    var files = d.files || [];

    var thumb = null;
    var video = null;
    for (var i = 0; i < files.length; i++) {
      var name = files[i].name || '';
      if (name.indexOf('.thumbs/') !== -1) continue;
      if (!thumb && /(thumbnail|__ia_thumb|_itemimage)\.(png|jpe?g|webp)$/i.test(name)) {
        thumb = name;
      }
      if (!video && /\.(mp4|mkv|webm)$/i.test(name)) video = files[i];
    }

    return {
      title: Array.isArray(md.title) ? md.title[0] : (md.title || null),
      channel: Array.isArray(md.creator) ? md.creator[0] : (md.creator || null),
      published: md.date || null,
      description: null,
      identifier: ident,
      mirror: video ? {
        name: video.name,
        sizeMB: video.size ? Math.round(Number(video.size) / 1048576) : null
      } : null,
      thumbnail: thumb
        ? 'https://archive.org/download/' + ident + '/' +
          thumb.split('/').map(encodeURIComponent).join('/')
        : null,
      source: {
        kind: 'archive.org',
        date: md.addeddate ? String(md.addeddate).slice(0, 10) : (md.date || null),
        url: 'https://archive.org/details/' + ident
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * Orchestration
   * ------------------------------------------------------------------ */

  function merge(target, src, fields) {
    if (!src) return target;
    fields.forEach(function (f) {
      if ((target[f] === null || target[f] === undefined || target[f] === '') &&
          src[f] !== null && src[f] !== undefined && src[f] !== '') {
        target[f] = src[f];
      }
    });
    return target;
  }

  /*
   * Runs the probe chain for a video that YouTube will not describe.
   *
   * Everything here is independent, so it fires in parallel and the limiter
   * decides the real pacing. Precedence on merge: the archived watch page is
   * richest, then the archive.org mirror's catalogue record, then oEmbed.
   */
  function emptyResult(id) {
    return {
      id: id,
      title: null, channel: null, channelId: null, published: null,
      duration: null, views: null, likes: null, description: null,
      isLive: false,
      thumbnail: null, thumbnailSource: null, thumbnailRank: 99,
      mirror: null,
      sources: [],
      oembedStatus: 0,
      existed: false,
      found: false
    };
  }

  // Lower wins. A still-live image (often served from the viewer's own cache)
  // beats a mirror's own copy, which beats a crawled one, which beats an
  // og:image pointing at a now-404 ytimg URL.
  var THUMB_LIVE = 0, THUMB_IA = 1, THUMB_CRAWLED = 2, THUMB_OEMBED = 3;

  function setThumb(out, url, source, rank) {
    if (!url || rank >= out.thumbnailRank) return;
    out.thumbnail = url;
    out.thumbnailSource = source;
    out.thumbnailRank = rank;
  }

  function applyWaybackPart(out, wb) {
    var page = wb && wb.page, thumb = wb && wb.thumb;
    if (page) {
      merge(out, page, ['title', 'channel', 'channelId', 'published',
                        'duration', 'views', 'likes', 'description']);
      if (page.isLive) out.isLive = true;
      if (page.source) out.sources.push(page.source);
    }
    if (thumb) setThumb(out, thumb.url, thumb.source, THUMB_CRAWLED);
  }

  function applyIaPart(out, ia) {
    if (!ia) return;
    merge(out, ia, ['title', 'channel', 'published']);
    if (ia.source) out.sources.push(ia.source);
    if (ia.mirror) out.mirror = ia.mirror;
    setThumb(out, ia.thumbnail, 'archive.org', THUMB_IA);
  }

  function applyFastPart(out, fast) {
    if (!fast) return;
    var oembed = fast.oembed, thumb = fast.thumb;
    out.oembedStatus = oembed ? oembed.httpStatus : 0;
    merge(out, oembed && oembed.info, ['title', 'channel']);
    if (thumb) setThumb(out, thumb.url, thumb.source, THUMB_LIVE);
    if (oembed && oembed.info) setThumb(out, oembed.info.thumbnail, 'YouTube', THUMB_OEMBED);
  }

  /*
   * Rebuilt from the raw parts on every update rather than mutated in place.
   *
   * Parts arrive in whatever order the network returns them, but field
   * precedence must not depend on that order: the archived watch page is the
   * richest and most faithful source, then the mirror's catalogue record,
   * then whatever YouTube still admits to. Rebuilding keeps that fixed.
   */
  function buildResult(id, parts) {
    var out = emptyResult(id);
    applyWaybackPart(out, parts.wayback);
    applyIaPart(out, parts.ia);
    applyFastPart(out, parts.fast);
    out.found = !!out.title;
    return out;
  }

  function probeFastGroup(id, ctx) {
    return Promise.all([probeOEmbed(id, ctx), probeLiveThumbnail(id, ctx)])
      .then(function (r) { return { oembed: r[0], thumb: r[1] }; })
      .catch(function () { return {}; });
  }

  // The full-text search is a fallback for mirrors filed under a
  // non-standard identifier, so it stays inside this group rather than
  // showing up as a separate step that usually does not run.
  function probeIaGroup(id, ctx, opts) {
    return probeIaItem(id, ctx).then(function (hit) {
      if (hit || (opts && opts.skipIaSearch)) return hit;
      return probeIaSearch(id, ctx);
    }).catch(function () { return null; });
  }

  function probeWaybackGroup(id, ctx) {
    return Promise.all([probeWayback(id, ctx), probeArchivedThumbnail(id, ctx)])
      .then(function (r) { return { page: r[0], thumb: r[1] }; })
      .catch(function () { return {}; });
  }

  /*
   * A lookup split into two phases so it can be stopped between them.
   *
   * The fast phase costs about a second; the archive phase costs tens of
   * seconds and is frequently unnecessary once a title is already in hand.
   * Separating them lets the caller show an answer immediately and leave the
   * expensive half to be asked for — which is the difference between a panel
   * that feels instant and one that appears to hang.
   */
  var ARCHIVE_DEADLINE = 120000;

  function createLookup(id, opts) {
    opts = opts || {};
    var report = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var publish = typeof opts.onUpdate === 'function' ? opts.onUpdate : function () {};
    var parts = { fast: null, ia: null, wayback: null };

    /*
     * One controller for the whole lookup. Aborting it cancels every in-flight
     * request at once, which is what both the overall deadline and a manual
     * stop need — per-request timeouts alone cannot bound a stage that keeps
     * starting new requests.
     */
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var endedAs = null;   // 'timeout' | 'stopped'

    var stageErrors = {};

    function ctxFor(stage) {
      return {
        signal: controller ? controller.signal : undefined,
        onRetry: function (attempt, max) {
          report(stage, 'retry', { attempt: attempt, max: max });
        },
        onError: function () { stageErrors[stage] = true; }
      };
    }

    function halt(reason) {
      if (endedAs) return;
      endedAs = reason;
      if (controller) controller.abort();
    }

    // Whatever a probe returned, an aborted lookup reports why it stopped
    // rather than claiming the source held nothing.
    function settle(stage, hit) {
      if (endedAs) { report(stage, endedAs); return; }
      if (hit) { report(stage, 'hit'); return; }
      // Nothing found, but only because the source refused to answer.
      report(stage, stageErrors[stage] ? 'unavailable' : 'miss');
    }

    function current() { return buildResult(id, parts); }

    function runFast() {
      report('youtube', 'running');
      return probeFastGroup(id, ctxFor('youtube')).then(function (f) {
        parts.fast = f;
        settle('youtube', !!(f && ((f.oembed && f.oembed.info) || f.thumb)));
        return current();
      });
    }

    function runArchives() {
      report('ia', 'running');
      report('wayback', 'running');

      var timer = setTimeout(function () { halt('timeout'); },
                             opts.deadlineMs || ARCHIVE_DEADLINE);

      var iaJob = probeIaGroup(id, ctxFor('ia'), opts).then(function (r) {
        parts.ia = r;
        settle('ia', !!r);
        publish(current(), 'ia');
      });

      var wbJob = probeWaybackGroup(id, ctxFor('wayback')).then(function (r) {
        parts.wayback = r;
        settle('wayback', !!(r && (r.page || r.thumb)));
        publish(current(), 'wayback');
      });

      return Promise.all([iaJob, wbJob]).then(function () {
        clearTimeout(timer);
        var out = current();
        out.stoppedAs = endedAs;
        return out;
      }, function (e) {
        clearTimeout(timer);
        var out = current();
        out.stoppedAs = endedAs || 'error';
        return out;
      });
    }

    return {
      runFast: runFast,
      runArchives: runArchives,
      current: current,
      stop: function () { halt('stopped'); }
    };
  }

  // Convenience wrapper that runs everything, used by the test runner.
  function recover(id, opts) {
    var lookup = createLookup(id, opts);
    return lookup.runFast().then(function () { return lookup.runArchives(); });
  }
  /*
   * A `gone` video with no archive hit is genuinely ambiguous: YouTube
   * answers identically for "deleted last week" and "never existed". Say so
   * rather than inventing a verdict.
   */
  function verdictFor(state, result) {
    var oembed = result ? result.oembedStatus : 0;

    /*
     * After an SPA navigation the page's own state is unreadable, so oEmbed
     * becomes the primary signal rather than a confirmation of it:
     * 403 means restricted-but-present, 404 means no public video.
     */
    if (state === STATE.UNKNOWN || !state) {
      if (oembed === 200) return STATE.OK;
      if (oembed === 403) return 'private';
      if (oembed === 404) return result && result.found ? 'deleted' : 'gone-unconfirmed';
      return 'unknown';
    }

    if (state === STATE.PRIVATE) return 'private';
    if (state === STATE.GONE) {
      if (oembed === 403) return 'private';
      // Local history is proof of prior existence even with no archive hit.
      if (result && (result.found || result.existed)) return 'deleted';
      return 'gone-unconfirmed';
    }
    return state;
  }

  function externalLinks(id) {
    return [
      { label: 'Wayback', url: 'https://web.archive.org/web/2*/' + WATCH + id },
      { label: 'archive.org', url: 'https://archive.org/search?query=%22' + id + '%22' },
      { label: 'Filmot', url: 'https://filmot.com/video/' + id },
      { label: 'Google', url: 'https://www.google.com/search?q=%22' + id + '%22' }
    ];
  }

  /*
   * Deliberately small. Everything else above is internal: the individual
   * probes, the HTML scrapers and the merge helpers are implementation
   * detail, and exposing them only invites a reader to work out who calls
   * what before concluding that nobody does.
   */
  return {
    // Page-state classification.
    STATE: STATE,
    selfSufficient: selfSufficient,
    healthy: healthy,
    videoIdFromUrl: videoIdFromUrl,
    classify: classify,

    // Lookups.
    createLookup: createLookup,   // two-phase, pausable — used by the background
    recover: recover,             // runs both phases — used by the test runner
    probeIaItem: probeIaItem,     // single probe — used by the timeout tests

    // Presentation helpers.
    verdictFor: verdictFor,
    externalLinks: externalLinks
  };
});
