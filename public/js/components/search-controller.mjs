import { formatSize } from '../core/format.mjs';
import {
  bindDialogDismissal,
  dateToEpochSeconds,
  formatDateTime,
  normalizeExtension,
  openDialog
} from './dialog-utils.mjs';

const MEBIBYTE = 1024 * 1024;

export class SearchController {
  constructor({ elements, api, onContextMenu, onSelect, onToggleReview, isReviewed, onMessage }) {
    this.elements = elements;
    this.api = api;
    this.onContextMenu = onContextMenu;
    this.onSelect = onSelect;
    this.onToggleReview = onToggleReview;
    this.isReviewed = isReviewed;
    this.onMessage = onMessage;
    this.results = [];
    this.sort = { key: 'size', direction: -1 };
    this.requestId = 0;
    this.abortController = null;
    this.bind();
  }

  open() {
    openDialog(this.elements.searchDialog);
    this.elements.searchTerm.focus();
  }

  bind() {
    bindDialogDismissal(this.elements.searchDialog, this.elements.searchClose);
    this.elements.searchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.search();
    });
    this.elements.searchReset.addEventListener('click', () => this.reset());
    for (const header of document.querySelectorAll('.search-table th[data-search-sort]')) {
      header.addEventListener('click', () => this.setSort(header.dataset.searchSort));
    }
    document.addEventListener('diskstatsx:review-changed', () => this.renderResults());
  }

  reset() {
    this.abortController?.abort();
    this.abortController = null;
    this.requestId++;
    this.setLoading(false);
    this.elements.searchForm.reset();
    this.results = [];
    this.elements.searchResultCount.textContent = 'No search yet';
    this.elements.searchEmpty.textContent = 'Search results appear here.';
    this.elements.searchEmpty.hidden = false;
    this.elements.searchTableWrap.hidden = true;
    this.elements.searchResults.replaceChildren();
    this.elements.searchTerm.focus();
  }

  invalidate() {
    this.abortController?.abort();
    this.abortController = null;
    this.requestId++;
    this.setLoading(false);
    this.results = [];
    this.elements.searchResultCount.textContent = 'Snapshot changed';
    this.elements.searchEmpty.textContent = 'Search results appear here.';
    this.elements.searchEmpty.hidden = false;
    this.elements.searchTableWrap.hidden = true;
    this.elements.searchResults.replaceChildren();
  }

  async search() {
    this.abortController?.abort();
    const controller = new globalThis.AbortController();
    this.abortController = controller;
    const requestId = ++this.requestId;
    this.setLoading(true);
    try {
      const payload = await this.api.searchFiles(this.searchOptions(), {
        signal: controller.signal
      });
      if (requestId !== this.requestId) {
        return;
      }
      this.results = Array.isArray(payload.results) ? payload.results : [];
      this.renderResults();
      const suffix = this.results.length === 1 ? 'result' : 'results';
      this.elements.searchResultCount.textContent = `${this.results.length} ${suffix}`;
      this.elements.searchEmpty.textContent = 'No files match these filters.';
      this.onMessage(`Indexed search returned ${this.results.length} ${suffix}`);
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }
      if (requestId !== this.requestId) {
        return;
      }
      this.results = [];
      this.elements.searchResults.replaceChildren();
      this.elements.searchTableWrap.hidden = true;
      this.elements.searchEmpty.hidden = false;
      this.elements.searchEmpty.textContent = error.message || 'Could not search this snapshot.';
      this.elements.searchResultCount.textContent = 'Search unavailable';
      this.onMessage(error.message || 'Could not search this snapshot');
    } finally {
      if (requestId === this.requestId) {
        this.setLoading(false);
        this.abortController = null;
      }
    }
  }

  searchOptions() {
    const minSize = Math.max(0, Number(this.elements.searchMinSize.value || 0)) * MEBIBYTE;
    const maxSize = Math.max(0, Number(this.elements.searchMaxSize.value || 0)) * MEBIBYTE;
    return {
      term: this.elements.searchTerm.value.trim(),
      extension: normalizeExtension(this.elements.searchExtension.value),
      minSize: Math.floor(minSize),
      maxSize: Math.floor(maxSize),
      modifiedAfter: dateToEpochSeconds(this.elements.searchAfter.value),
      modifiedBefore: dateToEpochSeconds(this.elements.searchBefore.value, { endOfDay: true }),
      cloudOnly: this.elements.searchCloudOnly.checked,
      sharedBlocks: this.elements.searchSharedBlocks.checked,
      limit: 500
    };
  }

  setSort(key) {
    if (this.sort.key === key) {
      this.sort.direction *= -1;
    } else {
      this.sort = { key, direction: key === 'size' || key === 'modifiedAt' ? -1 : 1 };
    }
    this.renderResults();
  }

  sortedResults() {
    const { key, direction } = this.sort;
    return [...this.results].sort((left, right) => {
      if (key === 'size' || key === 'modifiedAt') {
        return (Number(left[key] || 0) - Number(right[key] || 0)) * direction;
      }
      return String(left[key] || '').localeCompare(String(right[key] || '')) * direction;
    });
  }

  renderResults() {
    const results = this.sortedResults();
    const hasResults = results.length > 0;
    this.elements.searchEmpty.hidden = hasResults;
    this.elements.searchTableWrap.hidden = !hasResults;
    const fragment = document.createDocumentFragment();
    for (const file of results) {
      fragment.appendChild(this.createRow(file));
    }
    this.elements.searchResults.replaceChildren(fragment);
    this.updateSortHeaders();
  }

  createRow(file) {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    nameCell.className = 'result-name-cell';
    const label = document.createElement('label');
    label.className = 'review-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this.isReviewed(file.path);
    checkbox.setAttribute('aria-label', `Add ${file.name} to review`);
    checkbox.addEventListener('click', (event) => event.stopPropagation());
    checkbox.addEventListener('change', () => this.onToggleReview(file));
    const name = document.createElement('span');
    name.title = file.name;
    name.textContent = file.name;
    label.append(checkbox, name);
    nameCell.appendChild(label);
    const indicators = this.fileIndicators(file);
    if (indicators.length) {
      const meta = document.createElement('div');
      meta.className = 'result-meta';
      for (const indicator of indicators) {
        const badge = document.createElement('span');
        badge.textContent = indicator;
        meta.appendChild(badge);
      }
      nameCell.appendChild(meta);
    }
    row.appendChild(nameCell);
    row.appendChild(this.textCell(formatSize(file.size), 'number-cell'));
    row.appendChild(this.textCell(formatDateTime(file.modifiedAt), 'date-cell'));
    row.appendChild(this.textCell(file.path, 'file-path'));
    row.addEventListener('click', () => this.onSelect(file.path));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.onContextMenu(event, file);
    });
    return row;
  }

  textCell(text, className = '') {
    const cell = document.createElement('td');
    cell.className = className;
    cell.title = text;
    cell.textContent = text;
    return cell;
  }

  fileIndicators(file) {
    const indicators = [];
    if (file.cloudOnly) {
      indicators.push('Cloud-only');
    }
    if (file.sharedBlocks) {
      indicators.push('Shared blocks');
    }
    if (file.hardlinkDuplicate) {
      indicators.push('Hard link');
    }
    if (file.cloneDuplicate) {
      indicators.push('APFS clone');
    }
    return indicators;
  }

  updateSortHeaders() {
    for (const header of document.querySelectorAll('.search-table th[data-search-sort]')) {
      const active = header.dataset.searchSort === this.sort.key;
      header.classList.toggle('sorted-asc', active && this.sort.direction > 0);
      header.classList.toggle('sorted-desc', active && this.sort.direction < 0);
    }
  }

  setLoading(loading) {
    this.elements.searchSubmit.disabled = loading;
    this.elements.searchReset.disabled = loading;
    this.elements.searchSubmit.textContent = loading ? 'Searching...' : 'Search';
  }
}
