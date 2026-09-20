/*
 * Live integration check for the probe chain.
 *
 * These fixtures are real video IDs in known states, confirmed by hand:
 * they are what the classifier and probes must keep working against.
 * Requires network. Node 18+ (fetch, DecompressionStream, Blob).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../src/lib/core.js');

const FIXTURES = [
  {
    id: 'X1gxkuNzMf4',
    label: 'private (archived while public, hidden later)',
    expect: { oembed: 403, found: true, thumbnail: true }
  },
  {
    id: 'o1he09EtejI',
    label: 'deleted years ago (2010 upload, gone by 2024)',
    expect: { oembed: 404, found: true, thumbnail: false }
  },
  {
    id: 'jNQXAC9IVRw',
    label: 'alive (control — "Me at the zoo")',
    expect: { oembed: 200, found: true, thumbnail: true }
  },
  {
    id: 'AAAAAAAAAAA',
    label: 'never existed (control — must not fabricate)',
    expect: { oembed: 404, found: false, thumbnail: false }
  }
];

function fmtDuration(s) {
  if (!s) return '--';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0');
}

/*
 * Preflight: these fixtures assert what the archives hold, so a rate-limited
 * archive.org produces failures that look exactly like a code regression.
 * Checking first turns "1 CHECK FAILED" into a usable diagnosis.
 */
const probe = await fetch(
  'https://web.archive.org/cdx/search/cdx?url=example.com&output=json&limit=1'
).then((r) => r.status).catch(() => 0);

if (probe !== 200) {
  console.log(`\n!! web.archive.org returned ${probe || 'no response'} on a trivial query.`);
  console.log('!! It is rate-limiting or down. Failures below are probably not code.');
  console.log('!! Wait a few minutes and re-run before investigating.\n');
}

let failures = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`      ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${actual}, expected ${expected}`);
}

for (const f of FIXTURES) {
  console.log(`\n=== ${f.id} — ${f.label}`);
  const t0 = Date.now();
  let r;
  try {
    r = await core.recover(f.id);
  } catch (e) {
    console.log('      FAIL  threw:', e.message);
    failures++;
    continue;
  }
  const ms = Date.now() - t0;

  console.log(`    title    : ${r.title ?? '(none)'}`);
  console.log(`    channel  : ${r.channel ?? '(none)'}`);
  console.log(`    published: ${r.published ?? '(none)'}   duration: ${fmtDuration(r.duration)}`);
  console.log(`    views    : ${r.views ?? '-'}   likes: ${r.likes ?? '-'}   live: ${r.isLive}`);
  console.log(`    thumb    : ${r.thumbnail ? r.thumbnailSource + ' -> ' + r.thumbnail.slice(0, 96) : '(none)'}`);
  console.log(`    mirror   : ${r.mirror ? r.mirror.name.split('/').pop() + ' (' + r.mirror.sizeMB + ' MB)' : '(none)'}`);
  console.log(`    sources  : ${r.sources.map(s => s.kind + '@' + (s.date ?? '?')).join(', ') || '(none)'}`);
  const state = r.oembedStatus === 200 ? core.STATE.OK
              : r.oembedStatus === 403 ? core.STATE.PRIVATE
              : core.STATE.GONE;
  console.log(`    verdict  : ${core.verdictFor(state, r)}   [${ms} ms]`);

  check('oembed status', r.oembedStatus, f.expect.oembed);
  check('found', r.found, f.expect.found);
  check('has thumbnail', !!r.thumbnail, f.expect.thumbnail);
}

console.log(`\n${failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'}`);
process.exit(failures ? 1 : 0);
