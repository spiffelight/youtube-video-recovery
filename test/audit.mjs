/*
 * Pre-submission audit.
 *
 * Mozilla's policies require add-ons to "avoid including redundant code or
 * files" and to request only necessary permissions, and reviewers read the
 * whole source. This flags exports nothing consumes, CSS classes nothing
 * builds, and permissions nothing uses.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

function walk(dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

let issues = 0;
function report(label, items) {
  if (!items.length) {
    console.log(`  ok    ${label}`);
    return;
  }
  issues += items.length;
  console.log(`  WARN  ${label}: ${items.join(', ')}`);
}

const srcFiles = walk('src');
const allSrc = srcFiles.map(read).join('\n');
const testSrc = walk('test').filter((f) => extname(f) === '.mjs').map(read).join('\n');

console.log('\n=== unused core exports ===');
{
  const core = read('src/lib/core.js');
  const tail = core.slice(core.lastIndexOf('  return {'));
  const exported = [...tail.matchAll(/^\s{4}([A-Za-z_]\w*):/gm)].map((m) => m[1]);
  const consumers = allSrc.replace(core, '') + '\n' + testSrc;
  const unused = exported.filter((n) => {
    const re = new RegExp(`\\.${n}\\b`);
    return !re.test(consumers);
  });
  report(`${exported.length} exported`, unused);
}

console.log('\n=== CSS classes never applied by JS ===');
{
  const css = read('src/panel.css');
  const declared = new Set(
    [...css.matchAll(/\.(ytrp[\w-]*)/g)].map((m) => m[1])
  );
  const js = srcFiles.filter((f) => extname(f) === '.js').map(read).join('\n');
  const html = srcFiles.filter((f) => extname(f) === '.html').map(read).join('\n');

  /*
   * Some classes are assembled by concatenation ("ytrp-step--" + state), so a
   * literal search can never find them. Derive the prefixes from the code
   * itself rather than hardcoding a list that would silently drift.
   */
  const dynamicPrefixes = [...js.matchAll(/'[^']*?([\w-]+--)'\s*\+/g)].map((m) => m[1]);
  const isDynamic = (c) =>
    dynamicPrefixes.some((prefix) => c !== prefix && c.startsWith(prefix));

  const unused = [...declared].filter(
    (c) => !isDynamic(c) && !js.includes(c) && !html.includes(c)
  );
  report(`${declared.size} declared`, unused);
}

console.log('\n=== JS classes with no CSS rule ===');
{
  const css = read('src/panel.css');
  const js = srcFiles.filter((f) => extname(f) === '.js').map(read).join('\n');
  const used = new Set(
    [...js.matchAll(/'(ytrp[\w-]*(?:\s+ytrp[\w-]*)*)'/g)]
      .flatMap((m) => m[1].split(/\s+/))
  );
  // PANEL_ID is an element id, not a class, so it has no class rule.
  const missing = [...used].filter((c) => c !== 'ytrp-panel' && !css.includes('.' + c));
  report(`${used.size} referenced`, missing);
}

console.log('\n=== manifest permissions vs usage ===');
{
  const manifest = JSON.parse(read('manifest.json'));
  const apiFor = { storage: 'storage.', history: 'history.', bookmarks: 'bookmarks.' };
  const declared = [
    ...(manifest.permissions || []),
    ...(manifest.optional_permissions || [])
  ];
  const unused = declared.filter((p) => !allSrc.includes(apiFor[p] || p));
  report(`${declared.length} declared`, unused);

  // Every content-script match should have a matching host permission,
  // otherwise Firefox MV3 silently declines to inject.
  const hosts = manifest.host_permissions || [];
  const matches = (manifest.content_scripts || []).flatMap((c) => c.matches);

  /*
   * Reduce a match pattern to its origin. An earlier version stripped only
   * the last path segment, so "…/live/*" did not reduce to "…/*" and was
   * reported as uncovered even though the host permission grants the whole
   * origin.
   */
  const originOf = (pattern) => pattern.replace(/^([a-z*]+:\/\/[^/]+)\/.*$/i, '$1/*');
  const orphaned = matches.filter((m) => !hosts.includes(originOf(m)));
  report('content_script matches covered by host_permissions', orphaned);
}

console.log('\n=== files that would ship ===');
{
  // Read the real packaging ignore list rather than a copy that would drift.
  const { ignoreFiles } = require('../web-ext-config.cjs');
  const ignored = ignoreFiles.concat(['.git']);
  const shipped = walk('.').filter(
    (f) => !ignored.some((i) => f.startsWith(`./${i}`) || f.includes(`/${i}/`))
  ).map((f) => f.replace('./', ''));
  shipped.forEach((f) => console.log(`        ${f}`));
  const strays = shipped.filter((f) => /\.(md|log|bak|tmp|orig)$/.test(f));
  report('no stray files', strays);
}

console.log(`\n${issues ? issues + ' ITEM(S) TO REVIEW' : 'AUDIT CLEAN'}`);
process.exit(0);
