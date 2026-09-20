/*
 * The add-on must decide once and then stay quiet.
 *
 * A playing video mutates the DOM continuously, which drives the add-on's
 * MutationObserver. Two bugs made that catastrophic: on an SPA navigation the
 * searching card was mounted *before* anything was known, and `tick` treated
 * "no panel present" as "never ran" — so it re-entered on every mutation.
 * The result was a card flashing several times a second on ordinary videos,
 * each flash firing a fresh network lookup.
 *
 * Runs the real content.js in a headless browser engine against a churning
 * page. The engine is only needed to produce the DOM dump; the add-on itself
 * targets Firefox.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const engine = [
  process.env.BROWSER_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean).find((p) => existsSync(p));

if (!engine) {
  console.log('SKIP  no headless browser found (set BROWSER_PATH to run this check)');
  process.exit(0);
}

const page = join(here, 'flicker.html').replace(/\\/g, '/');

function render(scene) {
  const dom = execFileSync(engine, [
    '--headless', '--disable-gpu', '--virtual-time-budget=20000', '--dump-dom',
    `file:///${page}?v=X1gxkuNzMf4&scene=${scene}`
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

  const m = dom.match(/<pre id="result">([^<]*)<\/pre>/);
  if (!m || m[1] === 'pending') throw new Error(`no result for scene=${scene}`);
  return JSON.parse(m[1]);
}

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

console.log('\n=== a playing video, under continuous DOM churn ===');
{
  const r = render('playing');
  check('the page really did churn', r.mutations > 50, `${r.mutations} mutations`);
  check('no panel shown', r.panelPresent === false);
  check('no lookup started', r.connects === 0, `${r.connects} connects`);
  /*
   * Prevention, not catching. Reaching "anchor found" means the add-on
   * entered the lookup and then backed out — which is cheap, but it still
   * parses the page on every ordinary video. On a working page the error box
   * is hidden, so there should be nothing to anchor to and no entry at all.
   */
  check('never entered the lookup', r.enteredLookup === false);
}

console.log('\n=== a playing video whose error box is (wrongly) visible ===');
{
  // The anchor gate cannot help here, so the DOM check has to.
  const r = render('playing-visible-error');
  check('no panel shown', r.panelPresent === false);
  check('no lookup started', r.connects === 0, `${r.connects} connects`);
}

console.log('\n=== a /live/ page whose error box is display:flex but 0x0 ===');
{
  /*
   * The exact shape measured on a real /live/ page for a private video.
   * Making the anchor test size-based broke precisely this: the box is
   * switched on, so the add-on must act, even though it measures nothing.
   */
  const r = render('live-zero-size');
  check('panel shown', r.panelPresent === true);
  check('entered the lookup', r.enteredLookup === true);
  check('exactly one lookup started', r.connects === 1, `${r.connects} connects`);
}

console.log('\n=== an unavailable video, under the same churn ===');
{
  const r = render('unavailable');
  check('the page really did churn', r.mutations > 50, `${r.mutations} mutations`);
  check('panel shown', r.panelPresent === true);
  // The point of the guard: decided once, not once per mutation.
  check('exactly one lookup started', r.connects === 1, `${r.connects} connects`);
}

console.log(`\n${failures ? failures + ' CHECK(S) FAILED' : 'NO FLICKER'}`);
process.exit(failures ? 1 : 0);
