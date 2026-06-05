import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoTree } from '../public/js/demo-data.mjs';

test('demo data is internally consistent and contains no user paths', () => {
  const root = createDemoTree();
  let files = 0;
  let fileBytes = 0;
  const stack = [root];

  while (stack.length) {
    const node = stack.pop();
    assert.equal(node.path.includes('/Users/'), false);
    assert.equal(node.path.startsWith('/Demo Disk'), true);
    if (node.type === 'file') {
      files++;
      fileBytes += node.size;
    } else {
      stack.push(...node.children);
    }
  }

  assert.ok(files > 1000);
  assert.equal(root.size, fileBytes);
});
