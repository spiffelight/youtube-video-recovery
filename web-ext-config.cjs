/*
 * web-ext configuration.
 *
 * The test harness is a development tool, not part of the extension: it uses
 * inline scripts (which extension CSP forbids) purely to stub the background
 * script while previewing the panel. Excluding it keeps both the lint and any
 * built package clean.
 */
module.exports = {
  ignoreFiles: [
    'test',
    '.claude',
    'web-ext-artifacts',
    'README.md',
    'REVIEWERS.md',
    'LISTING.md',
    'test/icon-preview.html',
    'web-ext-config.cjs'
  ]
};
