import { formatCount, formatSize } from '../core/format.mjs';
import {
  bindDialogDismissal,
  formatSignedSize,
  openDialog
} from './dialog-utils.mjs';

export class HistoryController {
  constructor({ elements, api, onActivate, onMessage }) {
    this.elements = elements;
    this.api = api;
    this.onActivate = onActivate;
    this.onMessage = onMessage;
    this.records = [];
    this.loading = false;
    this.bind();
  }

  async open() {
    openDialog(this.elements.historyDialog);
    await this.refresh();
  }

  bind() {
    bindDialogDismissal(this.elements.historyDialog, this.elements.historyClose);
    this.elements.historyRefresh.addEventListener('click', () => this.refresh());
    this.elements.historyCompare.addEventListener('click', () => this.compare());
  }

  async refresh() {
    this.setLoading(true);
    try {
      const payload = await this.api.getHistory();
      this.records = Array.isArray(payload.snapshots) ? payload.snapshots : [];
      this.render();
    } catch (error) {
      this.records = [];
      this.render();
      this.elements.historyEmpty.textContent = error.message || 'Could not load scan history.';
      this.onMessage(error.message || 'Could not load scan history');
    } finally {
      this.setLoading(false);
      this.render();
    }
  }

  render() {
    const hasRecords = this.records.length > 0;
    this.elements.historyEmpty.hidden = hasRecords;
    this.elements.historyTableWrap.hidden = !hasRecords;
    this.elements.historyCompare.disabled = this.records.length < 2 || this.loading;
    this.populateSelectors();

    const fragment = document.createDocumentFragment();
    for (const record of this.records) {
      const row = document.createElement('tr');
      row.classList.toggle('active-snapshot', Boolean(record.active));
      row.appendChild(this.cell(formatSnapshotDate(record.createdAt), 'date-cell'));
      row.appendChild(this.cell(record.rootPath, 'file-path'));
      row.appendChild(this.cell(formatSize(record.allocatedBytes), 'number-cell'));
      row.appendChild(this.cell(formatCount(record.filesScanned), 'number-cell'));
      const action = document.createElement('td');
      action.className = 'action-cell';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'table-action';
      open.disabled = Boolean(record.active) || this.loading;
      open.textContent = record.active ? 'Current' : 'Load';
      open.addEventListener('click', () => this.activate(record.id));
      action.appendChild(open);
      row.appendChild(action);
      fragment.appendChild(row);
    }
    this.elements.historyList.replaceChildren(fragment);
  }

  populateSelectors() {
    const currentBefore = this.elements.historyBefore.value;
    const currentAfter = this.elements.historyAfter.value;
    const active = this.records.find((record) => record.active) || this.records[0];
    const compatible = active
      ? this.records.filter((record) => record.rootPath === active.rootPath)
      : this.records;
    const defaultAfter = active?.id || compatible[0]?.id || '';
    const defaultBefore = compatible.find((record) => record.id !== defaultAfter)?.id || defaultAfter;
    this.replaceOptions(
      this.elements.historyBefore,
      this.records.some((record) => record.id === currentBefore) ? currentBefore : defaultBefore
    );
    this.replaceOptions(
      this.elements.historyAfter,
      this.records.some((record) => record.id === currentAfter) ? currentAfter : defaultAfter
    );
  }

  replaceOptions(select, selectedId) {
    const resolvedId = this.records.some((record) => record.id === selectedId)
      ? selectedId
      : '';
    const fragment = document.createDocumentFragment();
    for (const record of this.records) {
      const option = document.createElement('option');
      option.value = record.id;
      option.textContent = `${formatSnapshotDate(record.createdAt)} - ${record.rootPath}`;
      option.selected = record.id === resolvedId;
      fragment.appendChild(option);
    }
    select.replaceChildren(fragment);
    select.disabled = this.records.length < 2 || this.loading;
  }

  async activate(id) {
    this.setLoading(true);
    try {
      const payload = await this.api.activateHistory(id);
      await this.onActivate(payload.status);
      await this.refresh();
      this.onMessage('Loaded scan snapshot');
    } catch (error) {
      this.onMessage(error.message || 'Could not load scan snapshot');
    } finally {
      this.setLoading(false);
      this.render();
    }
  }

  async compare() {
    const beforeId = this.elements.historyBefore.value;
    const afterId = this.elements.historyAfter.value;
    const before = this.records.find((record) => record.id === beforeId);
    const after = this.records.find((record) => record.id === afterId);
    if (!before || !after || before.id === after.id) {
      this.onMessage('Choose two different scan snapshots');
      return;
    }
    if (before.rootPath !== after.rootPath) {
      this.onMessage('Choose snapshots of the same root folder');
      return;
    }
    this.setLoading(true);
    try {
      const comparison = await this.api.compareHistory(beforeId, afterId);
      this.renderComparison(comparison, after.rootPath);
      this.onMessage('Snapshot comparison ready');
    } catch (error) {
      this.onMessage(error.message || 'Could not compare scan snapshots');
    } finally {
      this.setLoading(false);
    }
  }

  renderComparison(comparison, rootPath) {
    const delta = Number(comparison?.delta?.allocatedBytes || 0);
    this.elements.historyComparison.hidden = false;
    this.elements.comparisonBefore.textContent = `Before ${formatSize(comparison?.before?.allocatedBytes || 0)}`;
    this.elements.comparisonAfter.textContent = `After ${formatSize(comparison?.after?.allocatedBytes || 0)}`;
    this.elements.comparisonDelta.textContent = formatSignedSize(delta, formatSize);
    this.elements.comparisonDelta.dataset.direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    const changes = Array.isArray(comparison?.changes)
      ? comparison.changes.filter((change) => change.path !== rootPath)
      : [];
    this.elements.comparisonEmpty.hidden = changes.length > 0;
    this.elements.comparisonTableWrap.hidden = changes.length === 0;
    const fragment = document.createDocumentFragment();
    for (const change of changes) {
      const row = document.createElement('tr');
      row.dataset.kind = change.kind || 'changed';
      row.appendChild(this.cell(change.name, 'comparison-name'));
      row.appendChild(this.cell(formatSize(change.beforeSize), 'number-cell'));
      row.appendChild(this.cell(formatSize(change.afterSize), 'number-cell'));
      row.appendChild(this.cell(formatSignedSize(change.delta, formatSize), 'number-cell delta-cell'));
      row.appendChild(this.cell(change.kind || 'changed', 'comparison-kind'));
      fragment.appendChild(row);
    }
    this.elements.comparisonList.replaceChildren(fragment);
  }

  cell(value, className = '') {
    const cell = document.createElement('td');
    cell.className = className;
    cell.title = value;
    cell.textContent = value;
    return cell;
  }

  setLoading(loading) {
    this.loading = loading;
    this.elements.historyRefresh.disabled = loading;
    this.elements.historyCompare.disabled = loading || this.records.length < 2;
    this.elements.historyRefresh.textContent = loading ? 'Loading...' : 'Refresh';
    for (const select of [this.elements.historyBefore, this.elements.historyAfter]) {
      select.disabled = loading || this.records.length < 2;
    }
  }
}

function formatSnapshotDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}
