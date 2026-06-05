import { TREE_VIEW } from '../core/config.mjs';
import {
  escapeHtml,
  formatCount,
  formatPercent,
  formatSize
} from '../core/format.mjs';

export class TreeView {
  constructor({ wrapper, body, onAnalyze, onSelect, onContextMenu }) {
    this.wrapper = wrapper;
    this.body = body;
    this.onAnalyze = onAnalyze;
    this.onSelect = onSelect;
    this.onContextMenu = onContextMenu;
    this.root = null;
    this.analysisNode = null;
    this.selectedPath = null;
    this.expandedPaths = new Set();
    this.rows = [];
    this.frame = 0;
    this.sort = { key: 'size', direction: -1 };
    this.sortedChildrenCache = new WeakMap();
    this.bind();
  }

  setRoot(root) {
    this.root = root;
    this.analysisNode = root;
    this.selectedPath = null;
    this.expandedPaths = new Set(root ? [root.data.path] : []);
    this.sortedChildrenCache = new WeakMap();
    this.refresh();
  }

  setAnalysisNode(node) {
    this.analysisNode = node;
    if (node) {
      for (const ancestor of node.ancestors()) {
        this.expandedPaths.add(ancestor.data.path);
      }
    }
    this.refresh();
  }

  setSelectedPath(path) {
    this.selectedPath = path;
    for (const row of this.body.querySelectorAll('tr[data-path]')) {
      row.classList.toggle('selected', row.dataset.path === path);
    }
  }

  clear() {
    this.root = null;
    this.rows = [];
    this.body.replaceChildren();
  }

  refresh() {
    if (!this.root) {
      this.clear();
      return;
    }
    this.rows = this.createDirectoryRows(this.root);
    this.renderVisibleRows();
    this.renderSortHeaders();
  }

  createDirectoryRows(root) {
    const rows = [];
    const visit = (node) => {
      if (node.data.type !== 'directory') {
        return;
      }
      rows.push(node);
      if (this.expandedPaths.has(node.data.path)) {
        for (const child of this.sortedDirectoryChildren(node)) {
          visit(child);
        }
      }
    };
    visit(root);
    return rows;
  }

  sortedDirectoryChildren(node) {
    if (this.sortedChildrenCache.has(node)) {
      return this.sortedChildrenCache.get(node);
    }
    const children = (node.children || [])
      .filter((child) => child.data.type === 'directory')
      .sort((left, right) => this.compareNodes(left, right));
    this.sortedChildrenCache.set(node, children);
    return children;
  }

  compareNodes(left, right) {
    const leftValue = this.sortValue(left);
    const rightValue = this.sortValue(right);
    if (typeof leftValue === 'string' || typeof rightValue === 'string') {
      return String(leftValue).localeCompare(String(rightValue)) * this.sort.direction;
    }
    if (leftValue !== rightValue) {
      return (leftValue < rightValue ? -1 : 1) * this.sort.direction;
    }
    return String(left.data.name || '').localeCompare(String(right.data.name || ''));
  }

  sortValue(node) {
    const values = {
      name: String(node.data.name || node.data.path || '').toLowerCase(),
      percent: this.root?.value ? node.value / this.root.value : 0,
      parentPercent: node.parent?.value ? node.value / node.parent.value : 1,
      size: node.value || 0,
      items: node.itemCount || 0,
      files: node.fileCount || 0,
      subdirs: node.subdirCount || 0,
      type: node.data.type || ''
    };
    return values[this.sort.key];
  }

  renderVisibleRows() {
    if (!this.root) {
      return;
    }
    const viewportHeight = Math.max(
      TREE_VIEW.rowHeight,
      this.wrapper.clientHeight - TREE_VIEW.headerHeight
    );
    const scrollOffset = Math.max(0, this.wrapper.scrollTop - TREE_VIEW.headerHeight);
    const start = Math.max(
      0,
      Math.floor(scrollOffset / TREE_VIEW.rowHeight) - TREE_VIEW.rowBuffer
    );
    const count = Math.ceil(viewportHeight / TREE_VIEW.rowHeight) + TREE_VIEW.rowBuffer * 2;
    const end = Math.min(this.rows.length, start + count);
    const fragment = document.createDocumentFragment();

    if (start > 0) {
      fragment.appendChild(this.createSpacer(start * TREE_VIEW.rowHeight));
    }
    for (let index = start; index < end; index++) {
      fragment.appendChild(this.createRow(this.rows[index], index));
    }
    if (end < this.rows.length) {
      fragment.appendChild(this.createSpacer((this.rows.length - end) * TREE_VIEW.rowHeight));
    }
    this.body.replaceChildren(fragment);
  }

  createRow(node, index) {
    const percent = this.root.value ? (node.value / this.root.value) * 100 : 0;
    const parentPercent = node.parent?.value ? (node.value / node.parent.value) * 100 : 100;
    const hasChildren = this.sortedDirectoryChildren(node).length > 0;
    const expanded = this.expandedPaths.has(node.data.path);
    const row = document.createElement('tr');
    row.dataset.path = node.data.path;
    row.dataset.rowIndex = String(index);
    row.classList.toggle('active-scope', this.analysisNode?.data.path === node.data.path);
    row.classList.toggle('selected', this.selectedPath === node.data.path);
    row.innerHTML = `
      <td>
        <span class="tree-name" style="padding-left:${Math.min(node.depth, 12) * 14}px">
          <button class="tree-toggle" type="button" ${hasChildren ? '' : 'disabled'}
            aria-label="${expanded ? 'Collapse' : 'Expand'} ${escapeHtml(node.data.name || node.data.path)}">
            ${hasChildren ? (expanded ? '▾' : '▸') : ''}
          </button>
          <span class="tree-icon">▣</span>
          <span class="tree-label" title="${escapeHtml(node.data.path)}">${escapeHtml(node.data.name || node.data.path)}</span>
        </span>
      </td>
      <td>
        <span class="percent-cell">
          <span class="percent-bar"><span class="percent-fill ${percent > 30 ? 'hot' : ''}" style="width:${Math.min(100, percent)}%"></span></span>
          <span>${formatPercent(percent)}</span>
        </span>
      </td>
      <td>${formatPercent(parentPercent)}</td>
      <td>${formatSize(node.value)}</td>
      <td>${formatCount(node.itemCount)}</td>
      <td>${formatCount(node.fileCount)}</td>
      <td>${formatCount(node.subdirCount)}</td>
      <td>Folder</td>
    `;
    return row;
  }

  createSpacer(height) {
    const row = document.createElement('tr');
    row.className = 'tree-spacer';
    const cell = document.createElement('td');
    cell.colSpan = 8;
    cell.style.height = `${Math.max(0, height)}px`;
    row.appendChild(cell);
    return row;
  }

  renderSortHeaders() {
    for (const header of document.querySelectorAll('.tree-table th[data-tree-sort]')) {
      const sorted = header.dataset.treeSort === this.sort.key;
      header.classList.toggle('sorted-asc', sorted && this.sort.direction === 1);
      header.classList.toggle('sorted-desc', sorted && this.sort.direction === -1);
    }
  }

  nodeFromEvent(event) {
    const row = event.target.closest('tr[data-row-index]');
    return row ? this.rows[Number(row.dataset.rowIndex)] : null;
  }

  bind() {
    this.wrapper.addEventListener('scroll', () => {
      if (this.frame) {
        return;
      }
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.renderVisibleRows();
      });
    });

    this.body.addEventListener('click', (event) => {
      const node = this.nodeFromEvent(event);
      if (!node) {
        return;
      }
      if (event.target.closest('.tree-toggle')) {
        event.stopPropagation();
        if (!this.sortedDirectoryChildren(node).length) {
          return;
        }
        if (this.expandedPaths.has(node.data.path)) {
          this.expandedPaths.delete(node.data.path);
        } else {
          this.expandedPaths.add(node.data.path);
        }
        this.refresh();
        this.setSelectedPath(this.selectedPath);
        return;
      }
      this.onAnalyze(node);
    });

    this.body.addEventListener('contextmenu', (event) => {
      const node = this.nodeFromEvent(event);
      if (!node) {
        return;
      }
      event.preventDefault();
      this.onContextMenu(event, {
        name: node.data.name,
        path: node.data.path,
        type: 'directory',
        node
      });
    });

    this.body.addEventListener('mouseover', (event) => {
      const node = this.nodeFromEvent(event);
      if (node && node.data.path !== this.selectedPath) {
        this.onSelect(node.data.path);
      }
    });

    for (const header of document.querySelectorAll('.tree-table th[data-tree-sort]')) {
      header.addEventListener('click', () => {
        const key = header.dataset.treeSort;
        if (this.sort.key === key) {
          this.sort.direction *= -1;
        } else {
          this.sort = {
            key,
            direction: key === 'name' || key === 'type' ? 1 : -1
          };
        }
        this.sortedChildrenCache = new WeakMap();
        this.refresh();
      });
    }
  }
}
