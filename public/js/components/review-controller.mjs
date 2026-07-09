import { escapeHtml, formatSize } from '../core/format.mjs';

export class ReviewController {
  constructor({ elements, onMessage }) {
    this.elements = elements;
    this.onMessage = onMessage;
    this.items = new Map();
    this.bind();
    this.render();
  }

  has(path) {
    return this.items.has(path);
  }

  toggle(item) {
    if (!item?.path || item.synthetic) {
      return;
    }
    if (this.items.has(item.path)) {
      this.items.delete(item.path);
    } else {
      this.items.set(item.path, this.normalizedItem(item));
    }
    this.render();
    document.dispatchEvent(new globalThis.CustomEvent('diskstatsx:review-changed'));
  }

  addMany(items) {
    let added = 0;
    for (const item of items || []) {
      if (!item?.path || item.synthetic || this.items.has(item.path)) {
        continue;
      }
      this.items.set(item.path, this.normalizedItem(item));
      added++;
    }
    if (added) {
      this.render();
      document.dispatchEvent(new globalThis.CustomEvent('diskstatsx:review-changed'));
    }
    return added;
  }

  normalizedItem(item) {
    return {
      name: item.name || item.path.split('/').pop() || item.path,
      path: item.path,
      type: item.type || 'file',
      size: Number(item.size || item.node?.value || 0),
      logicalSize: Number(item.logicalSize || item.node?.data.logicalSize || 0)
    };
  }

  clear() {
    this.items.clear();
    this.render();
    document.dispatchEvent(new globalThis.CustomEvent('diskstatsx:review-changed'));
  }

  render() {
    const items = [...this.items.values()]
      .sort((left, right) => right.size - left.size || left.name.localeCompare(right.name));
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><input type="checkbox" checked aria-label="Include ${escapeHtml(item.name)}"></td>
        <td class="file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</td>
        <td>${formatSize(item.size)}</td>
        <td class="file-path" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</td>
      `;
      row.querySelector('input').addEventListener('change', () => this.toggle(item));
      fragment.appendChild(row);
    }
    this.elements.reviewItems.replaceChildren(fragment);
    const total = items.reduce((sum, item) => sum + item.size, 0);
    this.elements.reviewCount.textContent = String(items.length);
    this.elements.reviewTotalCount.textContent = String(items.length);
    this.elements.reviewTotalSize.textContent = `${formatSize(total)} allocated`;
    this.elements.reviewEmpty.classList.toggle('hidden', items.length > 0);
    this.elements.reviewExport.disabled = items.length === 0;
    this.elements.reviewClear.disabled = items.length === 0;
    this.elements.reviewTrash.disabled = items.length === 0;
  }

  bind() {
    this.elements.reviewClear.addEventListener('click', () => this.clear());
    this.elements.reviewExport.addEventListener('click', () => this.exportCsv());
    this.elements.reviewTrash.addEventListener('click', () => this.moveToTrash());
  }

  async exportCsv() {
    const csv = this.toCsv();
    try {
      if (window.diskStatsX?.exportReview) {
        const result = await window.diskStatsX.exportReview(csv);
        if (!result.canceled) {
          this.onMessage('Review list exported');
        }
        return;
      }
      const blob = new globalThis.Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = globalThis.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'DiskStatsX-review.csv';
      link.click();
      globalThis.URL.revokeObjectURL(url);
      this.onMessage('Review list exported');
    } catch (error) {
      this.onMessage(error.message || 'Could not export review list');
    }
  }

  async moveToTrash() {
    if (!window.diskStatsX?.trashItems) {
      this.onMessage('Move to Trash is available in the desktop app');
      return;
    }
    try {
      const result = await window.diskStatsX.trashItems([...this.items.values()]);
      if (result.canceled) {
        return;
      }
      const failedPaths = new Set((result.failed || []).map((entry) => entry.path));
      for (const path of this.items.keys()) {
        if (!failedPaths.has(path)) {
          this.items.delete(path);
        }
      }
      this.render();
      document.dispatchEvent(new globalThis.CustomEvent('diskstatsx:review-changed'));
      this.onMessage(
        result.failed?.length
          ? `${result.moved} moved to Trash, ${result.failed.length} failed`
          : `${result.moved} moved to Trash · rescan to refresh totals`
      );
    } catch (error) {
      this.onMessage(error.message || 'Could not move items to Trash');
    }
  }

  toCsv() {
    const rows = [['Name', 'Type', 'Allocated bytes', 'Logical bytes', 'Path']];
    for (const item of this.items.values()) {
      rows.push([
        item.name,
        item.type,
        String(item.size),
        String(item.logicalSize),
        item.path
      ]);
    }
    return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
  }
}

function csvCell(value) {
  const raw = String(value ?? '');
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}
