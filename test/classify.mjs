/*
 * Classification of every playabilityStatus we expect to meet.
 *
 * The case that matters most is the negative one. A scheduled livestream
 * reports LIVE_STREAM_OFFLINE, which had no case and fell through to UNKNOWN;
 * UNKNOWN then triggered a recovery lookup, so a healthy upcoming stream got
 * an "UNAVAILABLE" card. Showing nothing is a result worth testing.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../src/lib/core.js');

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}

const details = { title: 'A video', author: 'Someone', videoId: 'X1gxkuNzMf4' };

const CASES = [
  {
    label: 'playing normally',
    pr: { playabilityStatus: { status: 'OK' }, videoDetails: details },
    state: core.STATE.OK, healthy: true
  },
  {
    label: 'scheduled livestream (not started)',
    pr: { playabilityStatus: { status: 'LIVE_STREAM_OFFLINE', reason: 'Premieres in 2 hours' },
          videoDetails: details },
    state: core.STATE.UPCOMING, healthy: true
  },
  {
    label: 'private',
    pr: { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'This video is private' } },
    state: core.STATE.PRIVATE, healthy: false
  },
  {
    label: 'age-gated (keeps its metadata)',
    pr: { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age' },
          videoDetails: details },
    state: core.STATE.AGE_RESTRICTED, healthy: false
  },
  {
    label: 'deleted or never existed',
    pr: { playabilityStatus: { status: 'ERROR', reason: 'Video unavailable' } },
    state: core.STATE.GONE, healthy: false
  },
  {
    label: 'region or copyright blocked',
    pr: { playabilityStatus: { status: 'UNPLAYABLE', reason: 'Not available in your country' },
          videoDetails: details },
    state: core.STATE.UNPLAYABLE, healthy: false
  },
  {
    label: 'a status YouTube has not shipped yet',
    pr: { playabilityStatus: { status: 'SOMETHING_NEW' } },
    state: core.STATE.UNKNOWN, healthy: false
  }
];

console.log('\n=== playabilityStatus mapping ===');
for (const c of CASES) {
  const got = core.classify(c.pr);
  check(c.label, got.state, c.state);
  check(`  ↳ healthy(${c.state})`, core.healthy(got.state), c.healthy);
}

console.log('\n=== localisation must not affect classification ===');
{
  // Observed on a sv-SE session: the reason is translated, the status is not.
  const sv = core.classify({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Privat video' } });
  check('Swedish "Privat video" still classifies as private', sv.state, core.STATE.PRIVATE);
  check('reason passed through verbatim for display', sv.reason, 'Privat video');
}

console.log('\n=== video id from the URL ===');
{
  const ID = 'X1gxkuNzMf4';
  const cases = [
    ['https://www.youtube.com/watch?v=' + ID, ID, 'ordinary watch page'],
    ['https://www.youtube.com/watch?v=' + ID + '&t=42s', ID, 'watch page with extra params'],
    // The reported bug: an ended stream keeps this URL and has no `v` param.
    ['https://www.youtube.com/live/' + ID, ID, 'ended livestream'],
    ['https://www.youtube.com/live/' + ID + '?feature=share', ID, 'live URL with params'],
    ['https://www.youtube.com/shorts/' + ID, ID, 'short'],
    ['https://www.youtube.com/embed/' + ID, ID, 'embed'],
    ['https://youtu.be/' + ID, ID, 'short link'],
    ['https://www.youtube.com/', null, 'home page'],
    ['https://www.youtube.com/watch?v=tooshort', null, 'malformed id rejected'],
    ['https://www.youtube.com/results?search_query=x', null, 'search results'],
    ['not a url at all', null, 'garbage input']
  ];
  for (const [url, want, label] of cases) {
    check(label, core.videoIdFromUrl(url), want);
  }
}

console.log(`\n${failures ? failures + ' CHECK(S) FAILED' : 'ALL CLASSIFY CHECKS PASSED'}`);
process.exit(failures ? 1 : 0);
