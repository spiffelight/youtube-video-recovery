/*
 * Drives the real background.js port state machine against stubbed browser
 * APIs, with the probe chain replaced by fakes.
 *
 * This exists because the bug that made the panel sit at "waiting" forever
 * was in the background's control flow, not in any probe — a cache miss
 * returning null was treated as an abort signal. The preview harness stubs
 * the background entirely, so it could not have caught it. This runs the
 * actual file.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const core = require('../src/lib/core.js');

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}

/* Minimal stand-ins for the browser APIs background.js touches. */
function makeEnv({ cache = {}, hostAccess = true, localHit = null, perms = [] } = {}) {
  const store = { ...cache };
  const ports = [];

  const ext = {
    storage: {
      local: {
        get: (k) => Promise.resolve(k === null ? { ...store } : { [k]: store[k] }),
        set: (bag) => { Object.assign(store, bag); return Promise.resolve(); },
        remove: () => Promise.resolve()
      }
    },
    permissions: {
      contains: ({ origins, permissions }) =>
        Promise.resolve(origins ? hostAccess : permissions.every((p) => perms.includes(p))),
      onAdded: { addListener() {} }
    },
    history: {
      search: () => Promise.resolve(
        localHit ? [{ url: 'https://www.youtube.com/watch?v=' + localHit.id,
                      title: localHit.title, lastVisitTime: Date.now() }] : [])
    },
    bookmarks: { search: () => Promise.resolve([]) },
    runtime: {
      onConnect: { addListener: (fn) => ports.push(fn) },
      onMessage: { addListener() {} },
      openOptionsPage() {}
    }
  };

  return { ext, ports, store };
}

function loadBackground(env, coreStub) {
  const sandbox = {
    browser: env.ext,
    chrome: env.ext,
    globalThis: null,
    console,
    setTimeout, clearTimeout, Promise, Date, Math, Object, JSON, String, Number, Array, RegExp
  };
  sandbox.globalThis = sandbox;
  sandbox.YTRecoverCore = coreStub;
  vm.createContext(sandbox);
  // Overridable so a deliberately broken copy can be run to confirm these
  // checks actually fail when the flow regresses.
  const bgPath = process.env.YTRP_BACKGROUND || join(here, '../src/background.js');
  vm.runInContext(readFileSync(bgPath, 'utf8'), sandbox);
  return sandbox;
}

/* A lookup whose phases resolve immediately, so flow is what is tested. */
function stubCore({ fastTitle = null, archiveTitle = null }) {
  return {
    ...core,
    createLookup(id) {
      const parts = { fast: false, arch: false };
      const build = () => ({
        id, sources: [], found: !!(parts.arch ? archiveTitle : (parts.fast ? fastTitle : null)),
        title: parts.arch ? archiveTitle : (parts.fast ? fastTitle : null),
        oembedStatus: 404, thumbnail: parts.arch ? 'thumb.jpg' : null
      });
      return {
        runFast: () => { parts.fast = true; return Promise.resolve(build()); },
        runArchives: () => { parts.arch = true; return Promise.resolve(build()); },
        current: build
      };
    }
  };
}

function drive(env, sandbox, msg) {
  const messages = [];
  const port = {
    name: 'recover',
    postMessage: (m) => messages.push(m),
    onMessage: { addListener: (fn) => (port._recv = fn) },
    onDisconnect: { addListener() {} }
  };
  env.ports.forEach((fn) => fn(port));
  port._recv(msg);
  return { messages, port };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

console.log('\n=== fresh lookup, nothing cached (the regression) ===');
{
  const env = makeEnv();
  const sandbox = loadBackground(env, stubCore({ archiveTitle: 'Recovered Title' }));
  const { messages } = drive(env, sandbox, { type: 'start', id: 'X1gxkuNzMf4', state: 'gone' });
  await tick();
  const progress = messages.filter((m) => m.type === 'progress');
  const final = messages.filter((m) => m.type === 'update').pop();
  check('progress messages emitted', progress.length > 0, true);
  check('reached a done update', !!(final && final.done), true);
  check('title recovered', final && final.result && final.result.title, 'Recovered Title');
}

console.log('\n=== fast phase finds a title -> pauses before archives ===');
{
  const env = makeEnv({ perms: ['history'], localHit: { id: 'X1gxkuNzMf4', title: 'From History' } });
  const sandbox = loadBackground(env, stubCore({ fastTitle: null, archiveTitle: 'Archive Title' }));
  const { messages, port } = drive(env, sandbox, { type: 'start', id: 'X1gxkuNzMf4', state: 'gone' });
  await tick();
  const paused = messages.filter((m) => m.type === 'update').pop();
  check('paused, not done', !!(paused && paused.paused && !paused.done), true);
  check('shows the local title', paused && paused.result && paused.result.title, 'From History');

  port._recv({ type: 'resume', id: 'X1gxkuNzMf4' });
  await tick();
  const after = messages.filter((m) => m.type === 'update').pop();
  check('resume completes', !!(after && after.done), true);
  check('archives supersede the local title', after && after.result && after.result.title, 'Archive Title');
}

console.log('\n=== history matched the URL but kept only the tombstone title ===');
{
  // The real-world case: the page was revisited after the video died, so
  // history holds "Video unavailable" rather than the original title.
  // No page signals are passed here, which is the backstop path: the page
  // state could not be read, so only the English patterns are available.
  const env = makeEnv({ perms: ['history'],
                        localHit: { id: 'X1gxkuNzMf4', title: 'Video unavailable - YouTube' } });
  const sandbox = loadBackground(env, stubCore({ fastTitle: null, archiveTitle: 'Archive Title' }));
  const { messages } = drive(env, sandbox, { type: 'start', id: 'X1gxkuNzMf4', state: 'gone' });
  await tick();

  const localProgress = messages.filter((m) => m.type === 'progress' && m.stage === 'local').pop();
  check('local reported as partial, not hit', localProgress && localProgress.state, 'partial');

  const final = messages.filter((m) => m.type === 'update').pop();
  check('archives ran automatically', !!(final && final.done), true);
  check('existence still recorded', !!(final && final.result && final.result.existed), true);
  const kinds = (final && final.result && final.result.sources || []).map((s) => s.kind);
  check('history not claimed as a source', kinds.includes('your history'), false);
}

console.log('\n=== a tombstone title in any language is not a title ===');
{
  /*
   * The stored title is the page's own error text, translated. Only checking
   * for English strings works for viewers whose YouTube is in English and for
   * nobody else — the error text then arrives as if it were the video's
   * recovered title. Comparing against the page's own words does not care
   * what language they are in, which is what this covers.
   */
  const tombstone = 'Dieses Video ist nicht verfügbar';
  const env = makeEnv({ perms: ['history'],
                        localHit: { id: 'X1gxkuNzMf4', title: tombstone + ' - YouTube' } });
  const sandbox = loadBackground(env, stubCore({ fastTitle: null, archiveTitle: 'Archive Title' }));
  const { messages } = drive(env, sandbox, {
    type: 'start', id: 'X1gxkuNzMf4', state: 'gone',
    pageTitle: tombstone + ' - YouTube', reason: tombstone
  });
  await tick();

  const localProgress = messages.filter((m) => m.type === 'progress' && m.stage === 'local').pop();
  check('local reported as partial, not hit', localProgress && localProgress.state, 'partial');

  const final = messages.filter((m) => m.type === 'update').pop();
  check('title is the archived one, not the error text',
        final && final.result && final.result.title, 'Archive Title');
  check('existence still recorded', !!(final && final.result && final.result.existed), true);
  const kinds = (final && final.result && final.result.sources || []).map((s) => s.kind);
  check('history not claimed as a source', kinds.includes('your history'), false);
}

console.log('\n=== a real title survives the tombstone check, in any language ===');
{
  // The other half of the rule: a stored title that is *not* what the page is
  // showing is a genuine record, and must still be used and credited.
  const tombstone = 'Dieses Video ist nicht verfügbar';
  const env = makeEnv({ perms: ['history'],
                        localHit: { id: 'X1gxkuNzMf4', title: 'Real Title - YouTube' } });
  const sandbox = loadBackground(env, stubCore({ fastTitle: null, archiveTitle: null }));
  const { messages } = drive(env, sandbox, {
    type: 'start', id: 'X1gxkuNzMf4', state: 'gone',
    pageTitle: tombstone + ' - YouTube', reason: tombstone
  });
  await tick();

  const last = messages.filter((m) => m.type === 'update').pop();
  check('shows the local title', last && last.result && last.result.title, 'Real Title');
  const kinds = (last && last.result && last.result.sources || []).map((s) => s.kind);
  check('history credited as a source', kinds.includes('your history'), true);
}

console.log('\n=== host permissions missing ===');
{
  const env = makeEnv({ hostAccess: false });
  const sandbox = loadBackground(env, stubCore({}));
  const { messages } = drive(env, sandbox, { type: 'start', id: 'X1gxkuNzMf4', state: 'gone' });
  await tick();
  const m = messages.filter((x) => x.type === 'update').pop();
  check('reports needsHostAccess', !!(m && m.result && m.result.needsHostAccess), true);
}

console.log(`\n${failures ? failures + ' CHECK(S) FAILED' : 'ALL FLOW CHECKS PASSED'}`);
process.exit(failures ? 1 : 0);
