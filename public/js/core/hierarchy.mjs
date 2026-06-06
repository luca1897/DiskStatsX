import { getExtension } from './format.mjs';

const d3 = globalThis.d3;

export function buildHierarchy(data) {
  const hierarchy = d3.hierarchy(data)
    .sum((node) => {
      const isLoadedContainer = node.type === 'directory' && node.children?.length;
      return isLoadedContainer ? 0 : Number(node.size || 0);
    })
    .sort((left, right) => right.value - left.value);

  hierarchy.eachAfter((node) => {
    const children = node.children || [];
    const calculatedFiles = node.data.type === 'file'
      ? 1
      : d3.sum(children, (child) => child.fileCount || 0);
    const calculatedDirectories = node.data.type === 'directory'
      ? d3.sum(children, (child) => (
        child.data.type === 'directory' ? 1 : 0
      ) + (child.subdirCount || 0))
      : 0;
    node.fileCount = Number(node.data.fileCount ?? calculatedFiles);
    node.subdirCount = Number(node.data.subdirCount ?? calculatedDirectories);
    node.itemCount = Number(node.data.itemCount ?? children.length);
  });

  d3.partition().size([2 * Math.PI, hierarchy.height + 1])(hierarchy);
  return hierarchy;
}

export function collectLargestFiles(data, limit = 100) {
  const files = [];
  const stack = [data];
  while (stack.length) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.type === 'file') {
      files.push(node);
      continue;
    }
    for (const child of node.children || []) {
      stack.push(child);
    }
  }
  files.sort((left, right) => Number(right.size || 0) - Number(left.size || 0));
  return files.slice(0, limit);
}

export function collectLargestFilesSummary(data) {
  const global = collectLargestFiles(data, 10);
  const firstLevel = (data.children || [])
    .filter((child) => child.type === 'directory')
    .map((directory) => {
      const allFiles = collectLargestFiles(directory, Number.MAX_SAFE_INTEGER);
      const files = allFiles.slice(0, 3);
      const remaining = allFiles.slice(3);
      const otherSize = d3.sum(remaining, (file) => Number(file.size || 0));
      return {
        name: directory.name,
        path: directory.path,
        files,
        other: remaining.length
          ? {
              name: `Other files (${remaining.length})`,
              path: `diskstatsx:aggregate:files:${directory.path}`,
              size: otherSize,
              type: 'aggregate',
              itemCount: remaining.length,
              synthetic: true
            }
          : null
      };
    })
    .filter((group) => group.files.length || group.other);

  return { global, firstLevel };
}

export function collectExtensionStats(hierarchy) {
  const stats = new Map();
  for (const leaf of hierarchy.leaves()) {
    if (leaf.data.type !== 'file') {
      continue;
    }
    const extension = getExtension(leaf.data.name);
    const current = stats.get(extension) || { extension, size: 0, files: 0 };
    current.size += Number(leaf.value || leaf.data.size || 0);
    current.files++;
    stats.set(extension, current);
  }
  return [...stats.values()].sort((left, right) => right.size - left.size);
}

export function findNodeByPath(root, targetPath) {
  if (!root || !targetPath) {
    return null;
  }
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node.data.path === targetPath) {
      return node;
    }
    for (const child of node.children || []) {
      stack.push(child);
    }
  }
  return null;
}

export function parentDirectoryPath(targetPath) {
  if (!targetPath || targetPath === '/') {
    return '/';
  }
  const trimmed = targetPath.endsWith('/') ? targetPath.slice(0, -1) : targetPath;
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
}

export function topAncestor(node) {
  let current = node;
  while (current.depth > 1) {
    current = current.parent;
  }
  return current;
}
