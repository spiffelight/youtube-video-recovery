/*
 * End-to-end check in the target browser: the real add-on loaded into a real
 * Firefox, against real youtube.com.
 *
 * Every other test in test/ stubs something. This stubs nothing, and it is
 * the only one that exercises the Firefox-specific parts — background.scripts
 * rather than a service worker, the sandbox global, and MV3 host permissions.
 *
 * `devtools.console.stdout.content` makes content-script console output go to
 * Firefox's stdout, so the add-on's own log becomes the assertion surface.
 * `extensions.originControls.grantByDefault` grants host permissions, which
 * Firefox MV3 otherwise withholds until the user allows them by hand.
 *
 * Slow, needs network, and depends on live third-party videos keeping their
 * state, so it is not part of the routine suite.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const firefox = [
  process.env.FIREFOX_PATH,
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
  '/usr/bin/firefox',
  '/Applications/Firefox.app/Contents/MacOS/firefox'
].filter(Boolean).find((p) => existsSync(p));

if (!firefox) {
  console.log('SKIP  no Firefox found (set FIREFOX_PATH)');
  process.exit(0);
}

const SECONDS = Number(process.env.WATCH_SECONDS || 45);

function run(url) {
  return new Promise((resolve) => {
    // shell: true — Node refuses to spawn a .cmd shim directly on Windows.
    const child = spawn('npx', [
      '--yes', 'web-ext@latest', 'run',
      '--source-dir', JSON.stringify(root),
      '--firefox', JSON.stringify(firefox),
      '--no-reload',
      // web-ext discards the browser's stdout unless verbose, and that is
      // where the content script's console output arrives.
      '--verbose',
      '--url', JSON.stringify(url),
      '--pref', 'devtools.console.stdout.content=true',
      '--pref', 'extensions.originControls.grantByDefault=true'
    ], {
      cwd: root,
      shell: true,
      // `web-ext run` has no --headless flag for firefox-desktop; the browser
      // reads this environment variable instead.
      env: Object.assign({}, process.env, { MOZ_HEADLESS: '1' })
    });

    let out = '';
    const grab = (b) => { out += b.toString(); };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);

    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* already gone */ }
      setTimeout(() => resolve(out), 1500);
    }, SECONDS * 1000);

    child.on('exit', () => { clearTimeout(timer); resolve(out); });
  });
}

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const CASES = [
  {
    label: 'private video',
    url: 'https://www.youtube.com/watch?v=jrjTiWbtny0',
    expect: { loaded: true, anchor: true, quiet: false }
  },
  {
    label: 'working video',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    expect: { loaded: true, anchor: false, quiet: true }
  }
];

for (const c of CASES) {
  console.log(`\n=== ${c.label} ===`);
  const out = await run(c.url);
  const lines = out.split('\n')
    .filter((l) => l.includes('[yt-recover]'))
    // web-ext prefixes each line with its own debug header and Firefox quotes
    // every console argument separately.
    .map((l) => l.slice(l.indexOf('[yt-recover]')).replace(/"/g, '').trim());

  console.log(lines.length ? lines.map((l) => '        ' + l).join('\n')
                           : '        (no add-on output)');

  check('content script ran', lines.some((l) => l.includes('loaded on')));
  check(c.expect.anchor ? 'found the error box' : 'found no error box',
        lines.some((l) => l.includes('error box matched')) === c.expect.anchor);

  // The point of the anchor gate: a healthy video is never even looked at.
  const entered = lines.some((l) => l.includes('anchor found'));
  check(c.expect.quiet ? 'never entered the lookup' : 'entered the lookup',
        entered === !c.expect.quiet);
}

console.log(`\n${failures ? failures + ' CHECK(S) FAILED' : 'LIVE FIREFOX OK'}`);
process.exit(failures ? 1 : 0);
