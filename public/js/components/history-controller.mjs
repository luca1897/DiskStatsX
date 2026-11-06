import { formatCount, formatSize } from '../core/format.mjs';
import {
  bindDialogDismissal,
  formatSignedSize,
  openDialog
} from './dialog-utils.mjs';

const BYTES_PER_GB = 1024 ** 3;

export class HistoryController {
  constructor({ elements, api, onActivate, onMessage, onConfirm }) {
    this.elements = elements;
    this.api = api;
    this.onActivate = onActivate;
    this.onMessage = onMessage;
    this.onConfirm = onConfirm;
    this.records = [];
    this.storage = null;
    this.loading = false;
    this.policyDirty = false;
    this.bind();
  }

  async open() {
    this.policyDirty = false;
    openDialog(this.elements.historyDialog);
    await this.refresh();
  }

  bind() {
    bindDialogDismissal(this.elements.historyDialog, this.elements.historyClose);
    this.elements.historyRefresh.addEventListener('click', () => this.refresh());
    this.elements.historyCompare.addEventListener('click', () => this.compare());
    this.elements.historyClear.addEventListener('click', () => this.clearHistory());
    this.elements.historyPolicyForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.savePolicy();
    });
    for (const control of [
      this.elements.historyMaxSnapshots,
      this.elements.historyMaxGb,
      this.elements.historyPreserveRoots
    ]) {
      control.addEventListener('input', () => {
        this.policyDirty = true;
        this.elements.historyPolicyStatus.textContent = 'Unsaved limits';
      });
    }
  }

  async refresh() {
    this.setLoading(true);
    try {
      this.applyPayload(await this.api.getHistory());
      if (!this.policyDirty) {
        this.elements.historyPolicyStatus.textContent = this.storage?.policyConfigured
          ? 'Saved limits'
          : 'Default limits';
      }
    } catch (error) {
      this.records = [];
      this.storage = null;
      this.render();
      this.elements.historyEmpty.textContent = error.message || 'Could not load scan history.';
      this.onMessage(error.message || 'Could not load scan history', { error: true });
    } finally {
      this.setLoading(false);
      this.render();
    }
  }

  applyPayload(payload) {
    this.records = Array.isArray(payload?.snapshots) ? payload.snapshots : [];
    this.storage = payload?.storage || null;
    if (!this.policyDirty) {
      this.populatePolicy();
    }
  }

  render() {
    const hasRecords = this.records.length > 0;
    this.elements.historyEmpty.hidden = hasRecords;
    this.elements.historyTableWrap.hidden = !hasRecords;
    this.elements.historyCompare.disabled = this.records.length < 2 || this.loading;
    this.populateSelectors();
    this.renderStorage();

    const fragment = document.createDocumentFragment();
    for (const record of this.records) {
      const row = document.createElement('tr');
      row.classList.toggle('active-snapshot', Boolean(record.active));
      row.classList.toggle('protected-snapshot', Boolean(record.protected));
      row.title = record.protected ? 'Protected by the current retention policy' : '';
      row.appendChild(this.cell(formatSnapshotDate(record.createdAt), 'date-cell'));
      row.appendChild(this.cell(record.rootPath, 'file-path'));
      row.appendChild(this.cell(formatSize(record.allocatedBytes), 'number-cell'));
      row.appendChild(this.cell(formatSize(record.resultBytes), 'number-cell index-size-cell'));
      row.appendChild(this.cell(formatCount(record.filesScanned), 'number-cell'));
      row.appendChild(this.actionCell(record));
      fragment.appendChild(row);
    }
    this.elements.historyList.replaceChildren(fragment);
  }

  actionCell(record) {
    const cell = document.createElement('td');
    cell.className = 'action-cell';
    const actions = document.createElement('div');
    actions.className = 'history-row-actions';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'table-action';
    open.disabled = Boolean(record.active) || this.loading;
    open.textContent = record.active ? 'Current' : 'Load';
    open.addEventListener('click', () => this.activate(record.id));
    actions.appendChild(open);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'table-action table-danger';
    remove.disabled = Boolean(record.active) || this.loading;
    remove.textContent = 'Delete';
    remove.title = record.active
      ? 'The current snapshot cannot be deleted'
      : `Delete ${formatSize(record.resultBytes)} snapshot`;
    remove.addEventListener('click', () => this.deleteSnapshot(record));
    actions.appendChild(remove);

    cell.appendChild(actions);
    return cell;
  }

  renderStorage() {
    const storage = this.storage || {};
    const policy = storage.policy || {};
    const totalBytes = Number(storage.totalBytes || 0);
    const maxBytes = Number(policy.maxBytes || 2 * BYTES_PER_GB);
    const percentage = maxBytes > 0 ? Math.min(100, (totalBytes / maxBytes) * 100) : 0;
    this.elements.historyStorageUsed.textContent = formatSize(totalBytes);
    this.elements.historyStorageLimit.textContent = formatSize(maxBytes);
    this.elements.historyStorageCount.textContent = formatCount(storage.snapshotCount || 0);
    this.elements.historyStorageProtected.textContent = formatCount(storage.protectedCount || 0);
    this.elements.historyStorageReclaimable.textContent = formatSize(storage.clearableBytes || 0);
    this.elements.historyStorageMeterFill.style.width = `${percentage}%`;
    this.elements.historyStorageMeter.classList.toggle('over-limit', totalBytes > maxBytes);
    this.elements.historyStorageMeter.setAttribute('aria-valuenow', String(Math.round(percentage)));
    this.elements.historyStorageMeter.setAttribute(
      'aria-valuetext',
      `${formatSize(totalBytes)} of ${formatSize(maxBytes)}`
    );
  }

  populatePolicy() {
    const policy = this.storage?.policy;
    if (!policy) {
      return;
    }
    this.elements.historyMaxSnapshots.value = String(policy.maxSnapshots);
    this.elements.historyMaxGb.value = formatPolicyGb(policy.maxBytes);
    this.elements.historyPreserveRoots.checked = Boolean(policy.preserveLatestPerRoot);
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
      this.onMessage(error.message || 'Could not load scan snapshot', { error: true });
    } finally {
      this.setLoading(false);
      this.render();
    }
  }

  async deleteSnapshot(record) {
    const confirmed = await this.onConfirm({
      title: 'Delete scan snapshot?',
      message: `${formatSnapshotDate(record.createdAt)}\n${record.rootPath}\n\nThis will reclaim ${formatSize(record.resultBytes)}.`,
      confirmLabel: 'Delete snapshot',
      danger: true
    });
    if (!confirmed) {
      return;
    }
    this.setLoading(true);
    try {
      const payload = await this.api.deleteHistory(record.id);
      this.applyPayload(payload);
      this.elements.historyPolicyStatus.textContent = this.policyDirty
        ? 'Unsaved limits'
        : 'Snapshot deleted';
      this.onMessage(`Reclaimed ${formatSize(payload.reclaimedBytes || 0)}`);
    } catch (error) {
      this.onMessage(error.message || 'Could not delete scan snapshot', { error: true });
    } finally {
      this.setLoading(false);
      this.render();
    }
  }

  async clearHistory() {
    const clearableBytes = Number(this.storage?.clearableBytes || 0);
    const clearableCount = this.records.filter((record) => !record.active).length;
    if (clearableCount === 0) {
      this.onMessage('No inactive snapshots to clear');
      return;
    }
    const confirmed = await this.onConfirm({
      title: 'Clear scan history?',
      message: `${clearableCount} inactive snapshots will be deleted, reclaiming ${formatSize(clearableBytes)}.\n\nThe current snapshot will be kept.`,
      confirmLabel: 'Clear history',
      danger: true
    });
    if (!confirmed) {
      return;
    }
    this.setLoading(true);
    try {
      const payload = await this.api.clearHistory();
      this.applyPayload(payload);
      this.elements.historyPolicyStatus.textContent = this.policyDirty
        ? 'Unsaved limits'
        : 'History cleared';
      this.onMessage(`Reclaimed ${formatSize(payload.reclaimedBytes || 0)}`);
    } catch (error) {
      this.onMessage(error.message || 'Could not clear scan history', { error: true });
    } finally {
      this.setLoading(false);
      this.render();
    }
  }

  async savePolicy() {
    const policy = this.readPolicy();
    if (!policy) {
      return;
    }
    const mayPrune = this.records.length > policy.maxSnapshots ||
      Number(this.storage?.totalBytes || 0) > policy.maxBytes;
    if (mayPrune) {
      const confirmed = await this.onConfirm({
        title: 'Apply retention limits?',
        message: 'Older unprotected snapshots that exceed these limits will be deleted now. Protected snapshots and the current snapshot will be kept.',
        confirmLabel: 'Apply limits',
        danger: true
      });
      if (!confirmed) {
        return;
      }
    }
    this.setLoading(true);
    try {
      const payload = await this.api.updateHistoryPolicy(policy);
      this.applyPayload(payload);
      this.policyDirty = false;
      this.populatePolicy();
      this.elements.historyPolicyStatus.textContent = payload.removedCount > 0
        ? `${payload.removedCount} removed, ${formatSize(payload.reclaimedBytes)} reclaimed`
        : 'Limits saved';
      this.onMessage('History limits saved');
    } catch (error) {
      this.onMessage(error.message || 'Could not save history limits', { error: true });
    } finally {
      this.setLoading(false);
      this.render();
    }
  }

  readPolicy() {
    const maxSnapshots = Number(this.elements.historyMaxSnapshots.value);
    const maxGb = Number(this.elements.historyMaxGb.value);
    if (!Number.isInteger(maxSnapshots) || maxSnapshots < 1 || maxSnapshots > 100) {
      this.onMessage('Max snapshots must be between 1 and 100', { error: true });
      return null;
    }
    if (!Number.isFinite(maxGb) || maxGb < 0.25 || maxGb > 1024) {
      this.onMessage('Storage limit must be between 0.25 GB and 1024 GB', { error: true });
      return null;
    }
    return {
      maxSnapshots,
      maxBytes: Math.round(maxGb * BYTES_PER_GB),
      preserveLatestPerRoot: this.elements.historyPreserveRoots.checked
    };
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
      this.onMessage(error.message || 'Could not compare scan snapshots', { error: true });
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
    this.elements.historyPolicySave.disabled = loading;
    this.elements.historyClear.disabled = loading || this.records.length < 2;
    this.elements.historyRefresh.textContent = loading ? 'Loading...' : 'Refresh';
    for (const control of [
      this.elements.historyBefore,
      this.elements.historyAfter,
      this.elements.historyMaxSnapshots,
      this.elements.historyMaxGb,
      this.elements.historyPreserveRoots
    ]) {
      control.disabled = loading;
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

function formatPolicyGb(bytes) {
  return String(Math.round((Number(bytes || 0) / BYTES_PER_GB) * 100) / 100);
}
