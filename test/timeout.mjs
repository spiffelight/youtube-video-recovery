/*
 * Verifies that a lookup cannot hang forever.
 *
 * A local server accepts connections and never responds, standing in for
 * archive.org doing the same. Before per-request timeouts and an abort
 * signal existed, these probes would wait indefinitely and the panel's
 * spinner had no way to stop.
 */
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const core = require('../src/lib/core.js');

let failures = 0;
function check(name, ok, extra = '') {
  if (!ok) failures++;
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

// Accepts the request, then holds it open forever.
const sockets = [];
const server = http.createServer((req, res) => { sockets.push(res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`black-hole server on ${base}`);

const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => realFetch(base + '/hang', opts);

console.log('\n=== per-request timeout bounds a hung connection ===');
{
  const t0 = Date.now();
  let settled = false;
  // 1s window, one retry allowed for a timeout: must settle in ~3s, not hang.
  const p = core.probeIaItem('X1gxkuNzMf4', { timeout: 1000, onRetry: () => {} });
  const guard = new Promise((r) => setTimeout(() => r('TIMED_OUT_IN_TEST'), 15000));
  const winner = await Promise.race([p.then((v) => { settled = true; return v; }), guard]);
  const ms = Date.now() - t0;
  check('request did not hang', winner !== 'TIMED_OUT_IN_TEST', `${ms} ms`);
  check('resolved rather than throwing', settled === true);
  check('timeout retried once, not twice', ms < 6000, `${ms} ms`);
}

console.log('\n=== stop() aborts an in-flight archive phase promptly ===');
{
  const lookup = core.createLookup('X1gxkuNzMf4', { deadlineMs: 60000 });
  const t0 = Date.now();
  const run = lookup.runArchives();
  setTimeout(() => lookup.stop(), 500);

  const guard = new Promise((r) => setTimeout(() => r('HUNG'), 20000));
  const winner = await Promise.race([run, guard]);
  const ms = Date.now() - t0;
  check('archives stopped', winner !== 'HUNG', `${ms} ms`);
  check('reported as stopped', winner && winner.stoppedAs === 'stopped',
        `stoppedAs=${winner && winner.stoppedAs}`);
  check('stopped quickly', ms < 12000, `${ms} ms`);
}

console.log('\n=== deadline halts a phase that never finishes ===');
{
  const lookup = core.createLookup('X1gxkuNzMf4', { deadlineMs: 1500 });
  const t0 = Date.now();
  const guard = new Promise((r) => setTimeout(() => r('HUNG'), 25000));
  const winner = await Promise.race([lookup.runArchives(), guard]);
  const ms = Date.now() - t0;
  check('deadline fired', winner !== 'HUNG', `${ms} ms`);
  check('reported as timeout', winner && winner.stoppedAs === 'timeout',
        `stoppedAs=${winner && winner.stoppedAs}`);
}

globalThis.fetch = realFetch;
sockets.forEach((res) => { try { res.destroy(); } catch (e) {} });
server.close();

console.log(`\n${failures ? failures + ' CHECK(S) FAILED' : 'ALL TIMEOUT CHECKS PASSED'}`);
process.exit(failures ? 1 : 0);
