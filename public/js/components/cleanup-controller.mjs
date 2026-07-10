import { formatSize } from '../core/format.mjs';
import {
  bindDialogDismissal,
  formatDateTime,
  openDialog
} from './dialog-utils.mjs';

export class CleanupController {
  constructor({ elements, api, onContextMenu, onToggleReview, onAddToReview, isReviewed, onMessage }) {
    this.elements = elements;
    this.api = api;
    this.onContextMenu = onContextMenu;
    this.onToggleReview = onToggleReview;
    this.onAddToReview = onAddToReview;
    this.isReviewed = isReviewed;
    this.onMessage = onMessage;
    this.results = [];
    this.requestId = 0;
    this.abortController = null;
    this.bind();
  }

  async open() {
    openDialog(this.elements.cleanupDialog);
    if (!this.results.length) {
      await this.refresh();
    }
  }

  bind() {
    bindDialogDismissal(this.elements.cleanupDialog, this.elements.cleanupClose);
    this.elements.cleanupForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.refresh();
    });
    this.elements.cleanupAddAll.addEventListener('click', () => this.addAll());
    document.addEventListener('diskstatsx:review-changed', () => this.renderResults());
  }

  invalidate() {
    this.abortController?.abort();
    this.abortController = null;
    this.requestId++;
    this.setLoading(false);
    this.results = [];
    this.elements.cleanupEmpty.textContent = 'Cleanup candidates appear here.';
    this.renderResults();
  }

  async refresh() {
    this.abortController?.abort();
    const controller = new globalThis.AbortController();
    this.abortController = controller;
    const requestId = ++this.requestId;
    this.setLoading(true);
    try {
      const payload = await this.api.getCleanup(
        {
          olderThanDays: Math.max(0, Math.floor(Number(this.elements.cleanupDays.value || 0))),
          limit: 150
        },
        { signal: controller.signal }
      );
      if (requestId !== this.requestId) {
        return;
      }
      this.results = Array.isArray(payload.results) ? payload.results : [];
      this.renderResults();
      this.onMessage(`${this.results.length} cleanup candidates ready`);
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }
      if (requestId !== this.requestId) {
        return;
      }
      this.results = [];
      this.renderResults();
      this.elements.cleanupEmpty.textContent = error.message || 'Could not load cleanup candidates.';
      this.onMessage(error.message || 'Could not load cleanup candidates');
    } finally {
      if (requestId === this.requestId) {
        this.setLoading(false);
        this.abortController = null;
      }
    }
  }

  addAll() {
    const candidates = this.results.filter((file) => !this.isReviewed(file.path));
    const added = this.onAddToReview(candidates);
    this.renderResults();
    this.onMessage(added ? `${added} candidates added to Review` : 'All candidates are already in Review');
  }

  renderResults() {
    const hasResults = this.results.length > 0;
    this.elements.cleanupEmpty.hidden = hasResults;
    this.elements.cleanupTableWrap.hidden = !hasResults;
    this.elements.cleanupAddAll.disabled = !hasResults;
    this.elements.cleanupResultCount.textContent = hasResults
      ? `${this.results.length} candidates`
      : 'No candidates loaded';
    this.renderCategories();
    const fragment = document.createDocumentFragment();
    for (const file of this.results) {
      fragment.appendChild(this.createRow(file));
    }
    this.elements.cleanupResults.replaceChildren(fragment);
  }

  renderCategories() {
    const totals = new Map();
    for (const file of this.results) {
      const category = file.cleanupCategory || 'Other';
      totals.set(category, (totals.get(category) || 0) + Number(file.size || 0));
    }
    const fragment = document.createDocumentFragment();
    for (const [category, size] of [...totals.entries()].sort((left, right) => right[1] - left[1])) {
      const chip = document.createElement('span');
      chip.className = 'cleanup-category';
      chip.textContent = `${category} ${formatSize(size)}`;
      fragment.appendChild(chip);
    }
    this.elements.cleanupCategories.replaceChildren(fragment);
  }

  createRow(file) {
    const row = document.createElement('tr');
    row.appendChild(this.textCell(file.cleanupCategory || 'Other', 'category-cell'));
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
    name.textContent = file.name;
    name.title = file.name;
    label.append(checkbox, name);
    nameCell.appendChild(label);
    row.appendChild(nameCell);
    row.appendChild(this.textCell(formatSize(file.size), 'number-cell'));
    row.appendChild(this.textCell(formatDateTime(file.modifiedAt), 'date-cell'));
    row.appendChild(this.textCell(file.path, 'file-path'));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.onContextMenu(event, file);
    });
    return row;
  }

  textCell(value, className = '') {
    const cell = document.createElement('td');
    cell.className = className;
    cell.title = value;
    cell.textContent = value;
    return cell;
  }

  setLoading(loading) {
    this.elements.cleanupRefresh.disabled = loading;
    this.elements.cleanupDays.disabled = loading;
    this.elements.cleanupAddAll.disabled = loading || this.results.length === 0;
    this.elements.cleanupRefresh.textContent = loading ? 'Loading...' : 'Refresh';
  }
}
