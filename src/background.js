/*
 * background.js — runs the probe chain off the page and caches the result.
 *
 * The network work lives here rather than in the content script so that
 * cross-origin access is governed by the extension's host_permissions
 * instead of youtube.com's own origin policy.
 */

// Chrome loads this as a classic service worker (single entry point);
// Firefox loads core.js itself via background.scripts.
if (typeof importScripts === 'function') {
  importScripts('/src/lib/core.js');
}

var ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
var core = globalThis.YTRecoverCore;

/* ---------------------------------------------------------------- *
 * Cache
 *
 * A hit is effectively permanent — a deleted video does not come back,
 * and neither does the archive record. A miss is re-checked sooner,
 * because an archive crawl may land later.
 * ---------------------------------------------------------------- */
var TTL_HIT = 30 * 24 * 3600 * 1000;
var TTL_MISS = 6 * 3600 * 1000;
var PREFIX = 'rec:';

function cacheGet(id) {
  var key = PREFIX + id;
  return ext.storage.local.get(key).then(function (bag) {
    var entry = bag && bag[key];
    if (!entry) return null;
    var ttl = entry.data && entry.data.found ? TTL_HIT : TTL_MISS;
    if (Date.now() - entry.at > ttl) return null;
    return entry.data;
  }).catch(function () { return null; });
}

/*
 * `complete` records whether the archive half actually ran. A paused lookup
 * is still worth caching — it answers instantly next time — but it must not
 * masquerade as a finished sweep, or the archives would never be offered
 * again for that video.
 */
function cacheSet(id, data, complete) {
  data.complete = !!complete;
  var bag = {};
  bag[PREFIX + id] = { at: Date.now(), data: data };
  maybePrune();
  return ext.storage.local.set(bag).catch(function () {});
}

// Occasional sweep so storage does not grow without bound.
function maybePrune() {
  if (Math.random() > 0.05) return;
  ext.storage.local.get(null).then(function (all) {
    var drop = [];
    var now = Date.now();
    Object.keys(all || {}).forEach(function (k) {
      if (k.indexOf(PREFIX) !== 0) return;
      var e = all[k];
      var ttl = e && e.data && e.data.found ? TTL_HIT : TTL_MISS;
      if (!e || now - e.at > ttl) drop.push(k);
    });
    if (drop.length) ext.storage.local.remove(drop);
  }).catch(function () {});
}

/* ---------------------------------------------------------------- *
 * Local probes — the viewer's own browser
 *
 * Cheaper and more authoritative than any archive: if the video is in this
 * browser's history, the viewer watched it while it was alive, which both
 * supplies the title and proves the video existed. That last part is what
 * resolves "deleted" from "never existed", which YouTube itself cannot.
 *
 * Gated behind optional permissions — the extension is fully functional
 * without them, so reading history is the viewer's call, not the default.
 * ---------------------------------------------------------------- */

var LOCAL_PERMS = ['history', 'bookmarks'];

/*
 * Firefox MV3 does not grant host permissions at install — unlike Chrome,
 * where `host_permissions` are granted outright. Until the user grants them,
 * archive requests fail, so this is checked up front and reported rather than
 * surfacing as a lookup that silently finds nothing.
 */
var ARCHIVE_HOSTS = [
  'https://web.archive.org/*',
  'https://archive.org/*'
];

function hasHostAccess() {
  if (!ext.permissions || !ext.permissions.contains) return Promise.resolve(true);
  return ext.permissions.contains({ origins: ARCHIVE_HOSTS })
    .catch(function () { return true; });   // Chrome: granted at install
}

function hasPermission(name) {
  if (!ext.permissions) return Promise.resolve(false);
  return ext.permissions.contains({ permissions: [name] }).catch(function () { return false; });
}

/*
 * A history entry recorded after the video died holds the tombstone title
 * ("YouTube", "Video unavailable - YouTube") rather than the real one.
 * History keeps only the most recent title per URL, so these cannot be
 * recovered — they can only be rejected.
 */
function usableTitle(raw) {
  if (!raw) return null;
  var t = String(raw).replace(/\s*-\s*YouTube\s*$/i, '').trim();
  if (!t) return null;
  if (/^youtube$/i.test(t)) return null;
  if (/^video unavailable$/i.test(t)) return null;
  if (/^(private video|deleted video)$/i.test(t)) return null;
  return t;
}

function probeHistory(id) {
  if (!ext.history) return Promise.resolve(null);
  return ext.history.search({ text: id, startTime: 0, maxResults: 25 })
    .then(function (items) {
      for (var i = 0; i < (items || []).length; i++) {
        var it = items[i];
        if (!it.url || it.url.indexOf(id) === -1) continue;
        var title = usableTitle(it.title);
        if (!title) continue;
        return {
          title: title,
          kind: 'your history',
          date: it.lastVisitTime ? new Date(it.lastVisitTime).toISOString().slice(0, 10) : null,
          existed: true
        };
      }
      // A URL match with no usable title still proves the video existed.
      for (var j = 0; j < (items || []).length; j++) {
        if (items[j].url && items[j].url.indexOf(id) !== -1) {
          return { title: null, kind: 'your history', date: null, existed: true };
        }
      }
      return null;
    })
    .catch(function () { return null; });
}

function probeBookmarks(id) {
  if (!ext.bookmarks) return Promise.resolve(null);
  return ext.bookmarks.search({ query: id })
    .then(function (items) {
      for (var i = 0; i < (items || []).length; i++) {
        var it = items[i];
        if (!it.url || it.url.indexOf(id) === -1) continue;
        return {
          title: usableTitle(it.title),
          kind: 'your bookmarks',
          date: null,
          existed: true
        };
      }
      return null;
    })
    .catch(function () { return null; });
}

function probeLocal(id) {
  return Promise.all(LOCAL_PERMS.map(hasPermission)).then(function (granted) {
    var jobs = [
      granted[0] ? probeHistory(id) : Promise.resolve(null),
      granted[1] ? probeBookmarks(id) : Promise.resolve(null)
    ];
    return Promise.all(jobs).then(function (res) {
      var hit = res[0] || res[1];
      return {
        available: granted[0] || granted[1],
        hit: hit
      };
    });
  });
}

function applyLocal(result, local) {
  result.localAvailable = local.available;
  if (!local.hit) return result;

  result.existed = true;

  /*
   * Existence alone is not a source of the record. Listing "your history"
   * among the sources of a title it did not supply overstates what it
   * contributed — the `existed` flag already carries that evidence, and it
   * is what separates a deleted video from an ID that never existed.
   */
  if (!local.hit.title) return result;

  result.localTitle = local.hit.title;
  // Archives carry far more fields, so they stay authoritative when they
  // hit; local evidence fills the gap when they do not.
  if (!result.title) {
    result.title = local.hit.title;
    result.found = true;
  }
  result.sources.unshift({
    kind: local.hit.kind,
    date: local.hit.date,
    url: null,
    local: true
  });
  return result;
}

/* ---------------------------------------------------------------- *
 * Request handling
 * ---------------------------------------------------------------- */

/*
 * Progress subscribers, keyed by video id.
 *
 * Keyed rather than per-request so that a lookup already in flight for one
 * tab still reports its stages to a second tab asking about the same video —
 * the work is shared, so the progress has to be too.
 */
var progressSubs = Object.create(null);

function subscribe(id, port) {
  (progressSubs[id] = progressSubs[id] || []).push(port);
}

function unsubscribe(id, port) {
  var subs = progressSubs[id];
  if (!subs) return;
  var i = subs.indexOf(port);
  if (i !== -1) subs.splice(i, 1);
  if (!subs.length) delete progressSubs[id];
}

function emit(id, message) {
  var subs = progressSubs[id] || [];
  for (var i = 0; i < subs.length; i++) {
    // A port disconnects when its tab navigates away mid-lookup.
    try { subs[i].postMessage(message); } catch (e) { /* gone */ }
  }
}

/*
 * Port-based lookup, streamed in two phases.
 *
 * Message order on the port:
 *   progress {stage, state}          — as each source starts and lands
 *   update   {result, paused, done}  — whenever the merged answer changes
 *
 * The fast phase always runs. The archive phase runs automatically only when
 * the fast phase found nothing: if a title is already in hand, the expensive
 * half is left paused and the viewer decides whether it is worth the wait.
 */
// Distinct from null/undefined, which are ordinary "nothing cached" values.
var HALT = {};

ext.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'recover') return;

  var subscribedId = null;
  var session = null;

  port.onDisconnect.addListener(function () {
    if (subscribedId) unsubscribe(subscribedId, port);
    session = null;
  });

  function send(message) {
    try { port.postMessage(message); } catch (e) { /* port closed */ }
  }

  function finish(id, result, flags) {
    result.verdict = core.verdictFor(session ? session.state : core.STATE.GONE, result);
    result.links = core.externalLinks(id);
    result.localAvailable = session ? session.localAvailable : false;
    send({ type: 'update', result: result, paused: !!flags.paused, done: !!flags.done,
           stoppedAs: flags.stoppedAs || null });
    /*
     * Only a sweep that actually finished counts as complete. One that was
     * stopped or hit the deadline is cached for its speed but stays
     * resumable, so the archives can be tried again later.
     */
    cacheSet(id, result, !!flags.done && !flags.paused && !flags.stoppedAs);
  }

  function startArchives(id) {
    if (!session || session.archivesRunning) return;
    session.archivesRunning = true;

    /*
     * Resuming from an incomplete cached result means this session never ran
     * the fast phase, so its parts are empty. Running it first costs about a
     * second and keeps the merged result whole, rather than having to splice
     * the cached half back in.
     */
    var chain = session.fastDone
      ? Promise.resolve()
      : session.lookup.runFast();

    chain.then(function () { return session.lookup.runArchives(); }).then(function (result) {
      if (!session) return;
      finish(id, applyLocal(result, session.local),
             { paused: false, done: true, stoppedAs: result.stoppedAs || null });
    }).catch(function (e) {
      send({ type: 'update', result: session ? session.lookup.current() : null,
             paused: false, done: true, error: String((e && e.message) || e) });
    });
  }

  port.onMessage.addListener(function (msg) {
    if (!msg) return;

    if (msg.type === 'resume') {
      if (session) startArchives(session.id);
      return;
    }

    if (msg.type === 'stop') {
      if (session && session.lookup) session.lookup.stop();
      return;
    }

    if (msg.type !== 'start') return;
    var id = msg.id;
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
      send({ type: 'update', result: null, paused: false, done: true });
      return;
    }

    subscribedId = id;
    subscribe(id, port);

    hasHostAccess().then(function (allowed) {
      if (!allowed) {
        send({ type: 'update', paused: false, done: true, result: {
          id: id, found: false, needsHostAccess: true, sources: [],
          links: core.externalLinks(id), localAvailable: false
        } });
        return HALT;
      }
      return cacheGet(id);
    }).then(function (cached) {
      /*
       * HALT, not null: `cacheGet` returns null on a cache miss, which is the
       * ordinary case for a video being looked up for the first time. Using
       * null as the abort signal made every fresh lookup return immediately
       * and do nothing at all.
       */
      if (cached === HALT) return;

      session = {
        id: id,
        state: msg.state || core.STATE.GONE,
        local: { available: false, hit: null },
        localAvailable: false,
        archivesRunning: false,
        fastDone: false,
        lookup: null
      };

      session.lookup = core.createLookup(id, {
        onProgress: function (stage, state, detail) {
          emit(id, { type: 'progress', id: id, stage: stage, state: state,
                     detail: detail || null });
        },
        onUpdate: function (result) {
          if (!session) return;
          finish(id, applyLocal(result, session.local), { paused: false, done: false });
        }
      });

      /*
       * A cached answer is instant. If the previous sweep stopped early the
       * archive half is still on the table, so the card is shown paused and
       * nothing further runs until the viewer asks.
       */
      if (cached) {
        cached.links = core.externalLinks(id);
        send({ type: 'update', result: cached, cached: true,
               paused: !cached.complete, done: !!cached.complete });
        return;
      }

      // Local first: no network, and it settles long before YouTube answers.
      send({ type: 'progress', id: id, stage: 'local', state: 'running' });
      return probeLocal(id).then(function (local) {
        if (!session) return;
        session.local = local;
        session.localAvailable = local.available;
        /*
         * A URL match with no usable title is not a "hit". History keeps only
         * the most recent title per URL, so revisiting the page after the
         * video died overwrites the real title with the tombstone one. That
         * still proves the video existed, but it has nothing to show —
         * reporting it as found claims more than was actually recovered.
         */
        var localState = !local.available ? 'skipped'
                       : !local.hit ? 'miss'
                       : (local.hit.title ? 'hit' : 'partial');
        send({ type: 'progress', id: id, stage: 'local', state: localState });

        if (local.hit && local.hit.title) {
          finish(id, applyLocal(session.lookup.current(), local), { paused: false, done: false });
        }
        return session.lookup.runFast();
      }).then(function (fastResult) {
        if (!session || !fastResult) return;
        session.fastDone = true;
        var merged = applyLocal(fastResult, session.local);

        /*
         * Stop here when there is already something to show. The archives
         * add a thumbnail and sometimes a full recording, but that is a
         * thirty-second question, and it should be asked rather than assumed.
         */
        if (merged.found) {
          finish(id, merged, { paused: true, done: false });
          return;
        }
        finish(id, merged, { paused: false, done: false });
        startArchives(id);
      });
    }).catch(function (e) {
      send({ type: 'update', result: null, paused: false, done: true,
             error: String((e && e.message) || e) });
    });
  });
});

ext.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'openOptions') {
    ext.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }
  return false;
});

// Newly granted access changes what a lookup can find, so previously cached
// answers are stale by definition.
if (ext.permissions && ext.permissions.onAdded) {
  ext.permissions.onAdded.addListener(function () {
    ext.storage.local.get(null).then(function (all) {
      var drop = Object.keys(all || {}).filter(function (k) { return k.indexOf(PREFIX) === 0; });
      if (drop.length) ext.storage.local.remove(drop);
    }).catch(function () {});
  });
}
