import { formatCount, formatElapsed, formatSize } from '../core/format.mjs';

export class StatusView {
  constructor(elements) {
    this.elements = elements;
  }

  render(status, treeSize = 0) {
    const {
      filesCount,
      dirsCount,
      elapsed,
      totalSize,
      toolbarState,
      scanButton,
      chooseDirectoryButton,
      cancelButton,
      pathInput,
      filterButton
    } = this.elements;

    filesCount.textContent = formatCount(status.filesScanned);
    dirsCount.textContent = formatCount(status.directoriesScanned);
    elapsed.textContent = formatElapsed(status.elapsedMs);
    totalSize.textContent = formatSize(status.bytesDiscovered || treeSize);

    const scanActive = status.state === 'running' || status.state === 'canceling';
    scanButton.disabled = scanActive;
    chooseDirectoryButton.disabled = scanActive;
    pathInput.disabled = scanActive;
    filterButton.disabled = scanActive;
    cancelButton.classList.toggle('hidden', !scanActive);
    cancelButton.disabled = status.state === 'canceling';
    cancelButton.textContent = status.state === 'canceling' ? 'Canceling...' : 'Cancel';

    const labels = {
      idle: 'Idle',
      done: 'Scan complete',
      canceled: 'Scan canceled',
      canceling: 'Canceling scan...',
      error: status.error || 'Scan failed'
    };
    toolbarState.textContent = status.state === 'running'
      ? status.currentPath || 'Scanning'
      : labels[status.state] || 'Idle';
  }
}
