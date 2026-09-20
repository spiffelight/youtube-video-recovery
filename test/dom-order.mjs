/*
 * Asserts the panel anchors to the VISIBLE error box, not a hidden one.
 *
 * Absolute placement is deliberately not asserted: where the card lands
 * relative to the error graphic depends on YouTube's watch-page layout, and
 * above is accepted. What must hold is that the add-on attaches to the error
 * box that is actually on screen.
 *
 * Both lookups got this wrong once by using document.querySelector, which
 * returns the first match in document order — a hidden placeholder, not the
 * real one. The harness reproduces that trap with a decoy container and a
 * display:none error element ahead of the real pair.
 *
 * Runs the real content.js in headless Chrome and checks the serialized DOM.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.log('SKIP  no Chrome found (set CHROME_PATH to run this check)');
  process.exit(0);
}

const page = join(here, 'preview.html');
const url = `file:///${page.replace(/\\/g, '/')}?v=X1gxkuNzMf4`;

const dom = execFileSync(chrome, [
  '--headless', '--disable-gpu', '--virtual-time-budget=6000', '--dump-dom', url
], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const panelAt = dom.indexOf('id="ytrp-panel"');
// The LAST error-screen is the real, visible one; the first is the hidden
// placeholder that made querySelector pick wrong.
const errorAt = dom.lastIndexOf('id="error-screen"');
const decoyAt = dom.indexOf('data-decoy');
const placeholders = (dom.match(/id="error-screen"/g) || []).length;

console.log('\n=== anchor selection ===');
check('panel was rendered', panelAt !== -1);
check('error box present', errorAt !== -1);
check('attached past the visible error box, not the placeholder',
      errorAt !== -1 && panelAt > errorAt, `visible error@${errorAt} panel@${panelAt}`);
/*
 * Without the decoy the ordering check is vacuous — it would pass against the
 * buggy version too. This asserts the trap is actually present and sits
 * before the error box, which is what made querySelector pick the wrong one.
 */
check('decoy trap present and ahead of the error box',
      decoyAt !== -1 && decoyAt < errorAt, `decoy@${decoyAt}`);
check('harness has a hidden placeholder to trip on', placeholders >= 2,
      `${placeholders} error-screen elements`);

console.log(`\n${failures ? failures + ' CHECK(S) FAILED' : 'DOM ORDER OK'}`);
process.exit(failures ? 1 : 0);
