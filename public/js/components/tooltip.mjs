import { escapeHtml, extensionDescription, formatSize } from '../core/format.mjs';

export class Tooltip {
  constructor(element) {
    this.element = element;
    this.contentKey = null;
  }

  showNode(event, node, rootValue) {
    const value = Number(node.value || 0);
    const percent = rootValue ? (value / rootValue) * 100 : 0;
    const storageNote = node.data.cloudOnly
      ? '<div class="muted">iCloud placeholder · no local data allocated</div>'
      : '';
    const allocationNotes = this.#allocationNotes(node.data);
    const pathNote = node.data.sunburstAggregate
      ? 'Aggregated smaller items'
      : node.data.path || '';
    this.#setContent(node.data.path, `
      <strong>${escapeHtml(node.data.name || node.data.path)}</strong>
      <div>${formatSize(value)} allocated · ${percent.toFixed(percent >= 1 ? 1 : 2)}%</div>
      ${node.data.logicalSize != null
        ? `<div class="muted">${formatSize(node.data.logicalSize)} logical</div>`
        : ''}
      ${storageNote}
      ${allocationNotes}
      <div class="muted">${escapeHtml(pathNote)}</div>
    `);
    this.#position(event);
  }

  showTreemapItem(event, item, total) {
    const percent = total ? (Number(item.size || 0) / total) * 100 : 0;
    const path = item.synthetic ? 'Aggregated remaining items' : item.path;
    const storageNote = item.cloudOnly
      ? '<div class="muted">iCloud placeholder · no local data allocated</div>'
      : '';
    this.#setContent(`${item.path}:${item.size}`, `
      <strong>${escapeHtml(item.name)}</strong>
      <div>${formatSize(item.size)} allocated · ${percent.toFixed(percent >= 1 ? 1 : 2)}%</div>
      ${item.logicalSize
        ? `<div class="muted">${formatSize(item.logicalSize)} logical</div>`
        : ''}
      ${storageNote}
      ${this.#allocationNotes(item.sourceNode?.data || item)}
      <div class="muted">${escapeHtml(path)}</div>
      <div class="muted">${escapeHtml(item.extension)} · ${escapeHtml(extensionDescription(item.extension))}</div>
    `);
    this.#position(event);
  }

  hide() {
    this.element.style.display = 'none';
    this.contentKey = null;
  }

  #allocationNotes(data) {
    if (data.hardlinkDuplicate) {
      return '<div class="muted">Hard link · allocation counted at another path</div>';
    }
    if (data.cloneDuplicate) {
      return '<div class="muted">Full APFS clone · shared allocation counted once</div>';
    }
    if (data.sharedBlocks) {
      return '<div class="muted">Shares APFS blocks · physical allocation is estimated</div>';
    }
    return '';
  }

  #setContent(key, html) {
    if (this.contentKey !== key) {
      this.contentKey = key;
      this.element.innerHTML = html;
    }
    this.element.style.display = 'block';
  }

  #position(event) {
    const offset = 16;
    const width = this.element.offsetWidth;
    const height = this.element.offsetHeight;
    const left = Math.min(window.innerWidth - width - 12, event.clientX + offset);
    const top = Math.min(window.innerHeight - height - 12, event.clientY + offset);
    this.element.style.left = `${Math.max(12, left)}px`;
    this.element.style.top = `${Math.max(12, top)}px`;
  }
}
