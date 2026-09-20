/*
 * options.js — grants and revokes the optional local-lookup permissions.
 *
 * permissions.request() only works from a real user gesture in an extension
 * page, which is why this lives here rather than in the injected panel.
 */
(function () {
  'use strict';

  var ext = browser;
  var status = document.getElementById('status');
  var BOXES = ['history', 'bookmarks'];

  var ARCHIVE_HOSTS = [
    'https://web.archive.org/*',
    'https://archive.org/*'
  ];

  function say(text) {
    status.textContent = text || '';
    if (text) setTimeout(function () { status.textContent = ''; }, 2600);
  }

  function refresh() {
    BOXES.forEach(function (name) {
      ext.permissions.contains({ permissions: [name] })
        .then(function (has) { document.getElementById(name).checked = !!has; })
        .catch(function () {});
    });
    ext.permissions.contains({ origins: ARCHIVE_HOSTS })
      .then(function (has) { document.getElementById('hosts').checked = !!has; })
      .catch(function () {});
  }

  // Host permissions are requested as origins rather than named permissions.
  var hostsBox = document.getElementById('hosts');
  hostsBox.addEventListener('change', function () {
    var wanted = hostsBox.checked;
    var call = wanted
      ? ext.permissions.request({ origins: ARCHIVE_HOSTS })
      : ext.permissions.remove({ origins: ARCHIVE_HOSTS });

    call.then(function (ok) {
      if (wanted && !ok) {
        hostsBox.checked = false;
        say('Access declined — lookups will keep coming back empty.');
        return;
      }
      say(wanted ? 'Archive access granted.' : 'Archive access removed.');
    }).catch(function (e) {
      hostsBox.checked = !wanted;
      say('Could not change access: ' + ((e && e.message) || e));
    });
  });

  BOXES.forEach(function (name) {
    var box = document.getElementById(name);
    box.addEventListener('change', function () {
      var wanted = box.checked;
      var call = wanted
        ? ext.permissions.request({ permissions: [name] })
        : ext.permissions.remove({ permissions: [name] });

      call.then(function (ok) {
        // A declined prompt must not leave the checkbox looking granted.
        if (wanted && !ok) {
          box.checked = false;
          say('Permission declined.');
          return;
        }
        say(wanted ? 'Enabled.' : 'Disabled.');
      }).catch(function (e) {
        box.checked = !wanted;
        say('Could not change permission: ' + ((e && e.message) || e));
      });
    });
  });

  /* ---------------- cached results ---------------- */

  var PREFIX = 'rec:';

  function refreshCache() {
    ext.storage.local.get(null).then(function (all) {
      var keys = Object.keys(all || {}).filter(function (k) {
        return k.indexOf(PREFIX) === 0;
      });
      var label = document.getElementById('cache-count');
      label.textContent = keys.length === 0
        ? 'No cached results'
        : keys.length + ' cached result' + (keys.length === 1 ? '' : 's');
      document.getElementById('clear-cache').disabled = keys.length === 0;
    }).catch(function () {});
  }

  document.getElementById('clear-cache').addEventListener('click', function () {
    ext.storage.local.get(null).then(function (all) {
      var keys = Object.keys(all || {}).filter(function (k) {
        return k.indexOf(PREFIX) === 0;
      });
      if (!keys.length) return;
      return ext.storage.local.remove(keys).then(function () {
        say('Cleared ' + keys.length + ' cached result' + (keys.length === 1 ? '' : 's') + '.');
        refreshCache();
      });
    }).catch(function (e) { say('Could not clear: ' + ((e && e.message) || e)); });
  });

  refresh();
  refreshCache();
})();
