import { escapeHtml, extensionDescription, formatSize } from '../core/format.mjs';

export class Tooltip {
  constructor(element) {
    this.element = element;
    this.contentKey = null;
  }

  showNode(event, node, rootValue) {
    const value = Number(node.value || 0);
    const percent = rootValue ? (value / rootValue) * 100 : 0;
    this.#setContent(node.data.path, `
      <strong>${escapeHtml(node.data.name || node.data.path)}</strong>
      <div>${formatSize(value)} · ${percent.toFixed(percent >= 1 ? 1 : 2)}%</div>
      <div class="muted">${escapeHtml(node.data.path || '')}</div>
    `);
    this.#position(event);
  }

  showTreemapItem(event, item, total) {
    const percent = total ? (Number(item.size || 0) / total) * 100 : 0;
    const path = item.path === '__other__' ? 'Aggregated remaining files' : item.path;
    this.#setContent(`${item.path}:${item.size}`, `
      <strong>${escapeHtml(item.name)}</strong>
      <div>${formatSize(item.size)} · ${percent.toFixed(percent >= 1 ? 1 : 2)}%</div>
      <div class="muted">${escapeHtml(path)}</div>
      <div class="muted">${escapeHtml(item.extension)} · ${escapeHtml(extensionDescription(item.extension))}</div>
    `);
    this.#position(event);
  }

  hide() {
    this.element.style.display = 'none';
    this.contentKey = null;
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
