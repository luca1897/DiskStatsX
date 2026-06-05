import assert from 'node:assert/strict';
import test from 'node:test';
import {
  escapeHtml,
  formatElapsed,
  formatSize,
  getExtension
} from '../public/js/core/format.mjs';

test('formatSize selects a readable binary unit', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(1024), '1.00 KB');
  assert.equal(formatSize(5 * 1024 ** 3), '5.00 GB');
});

test('formatElapsed produces compact durations', () => {
  assert.equal(formatElapsed(900), '0s');
  assert.equal(formatElapsed(65_000), '1m 5s');
  assert.equal(formatElapsed(3_665_000), '1h 1m 5s');
});

test('file helpers handle hidden and unsafe names', () => {
  assert.equal(getExtension('.gitignore'), '<none>');
  assert.equal(getExtension('archive.TAR'), '.tar');
  assert.equal(escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});
