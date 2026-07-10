import { formatCount, formatElapsed, formatSize } from '../core/format.mjs';

export class StatusView {
  constructor(elements) {
    this.elements = elements;
    this.detailsSignature = '';
    this.pendingDetails = null;
    this.bind();
  }

  render(status, treeSize = 0, scanSummary = null) {
    const {
      filesCount,
      dirsCount,
      elapsed,
      totalSize,
      logicalSize,
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
    const summary = scanSummary || status;
    logicalSize.textContent = formatSize(
      summary.logicalBytes ?? summary.logicalBytesDiscovered ?? treeSize
    );
    this.pendingDetails = {
      summary,
      fallbackAllocated: status.bytesDiscovered || treeSize
    };
    this.updateDetailsButton(summary);
    if (!this.elements.scanDetails.hidden) {
      this.renderDetails(summary, status.bytesDiscovered || treeSize);
    }

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
    const phaseLabels = {
      indexing: 'Indexing folders',
      'search-index': 'Building search index',
      optimizing: 'Optimizing database',
      ready: 'Finishing scan'
    };
    toolbarState.textContent = status.state === 'running'
      ? phaseLabels[status.phase] || status.currentPath || 'Scanning'
      : labels[status.state] || 'Idle';
    toolbarState.title = status.currentPath || toolbarState.textContent;
    pathInput.title = pathInput.value;
  }

  updateDetailsButton(summary) {
    const estimate = Boolean(
      summary.allocationIsEstimate || Number(summary.sharedBlockFiles || 0) > 0
    );
    this.elements.scanDetailsButton.classList.toggle('estimate', estimate);
    this.elements.scanDetailsButton.textContent = estimate
      ? 'Estimated allocation'
      : 'Scan details';
  }

  renderDetails(summary, fallbackAllocated) {
    const allocated = Number(summary.allocatedBytes ?? fallbackAllocated ?? 0);
    const logical = Number(
      summary.logicalBytes ?? summary.logicalBytesDiscovered ?? allocated
    );
    const signature = [
      allocated,
      logical,
      summary.hardlinkDuplicates,
      summary.hardlinkBytesSaved,
      summary.cloneDuplicates,
      summary.cloneBytesSaved,
      summary.sharedBlockFiles,
      summary.cloudOnlyFiles,
      summary.excludedDirectories,
      summary.unreadableDirectories,
      summary.symlinksSkipped
    ].map((value) => Number(value || 0)).join(':');
    if (signature === this.detailsSignature) {
      return;
    }
    this.detailsSignature = signature;
    const estimate = Boolean(
      summary.allocationIsEstimate || Number(summary.sharedBlockFiles || 0) > 0
    );
    const rows = [
      ['Local allocated', formatSize(allocated)],
      ['Logical size', formatSize(logical)],
      [
        'Hard links deduplicated',
        `${formatCount(summary.hardlinkDuplicates || 0)} · ${formatSize(summary.hardlinkBytesSaved || 0)} not recounted`
      ],
      [
        'Full APFS clones deduplicated',
        `${formatCount(summary.cloneDuplicates || 0)} · ${formatSize(summary.cloneBytesSaved || 0)} not recounted`
      ],
      [
        'Files sharing APFS blocks',
        `${formatCount(summary.sharedBlockFiles || 0)}${estimate ? ' · allocated total is an estimate' : ''}`
      ],
      [
        'iCloud-only placeholders',
        `${formatCount(summary.cloudOnlyFiles || 0)} · 0 B locally allocated`
      ],
      [
        'Excluded folders',
        `${formatCount(summary.excludedDirectories || 0)} · size not scanned`
      ],
      ['Unreadable paths', formatCount(summary.unreadableDirectories || 0)],
      ['Symbolic links ignored', formatCount(summary.symlinksSkipped || 0)]
    ];
    const fragment = document.createDocumentFragment();
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      const name = document.createElement('span');
      const detail = document.createElement('strong');
      name.textContent = label;
      detail.textContent = value;
      row.append(name, detail);
      fragment.appendChild(row);
    }
    this.elements.scanDetails.replaceChildren(fragment);
  }

  bind() {
    this.elements.scanDetailsButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = this.elements.scanDetails.hidden;
      this.elements.scanDetails.hidden = !open;
      this.elements.scanDetailsButton.setAttribute('aria-expanded', String(open));
      if (open && this.pendingDetails) {
        this.renderDetails(
          this.pendingDetails.summary,
          this.pendingDetails.fallbackAllocated
        );
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (
        !this.elements.scanDetails.contains(event.target) &&
        event.target !== this.elements.scanDetailsButton
      ) {
        this.elements.scanDetails.hidden = true;
        this.elements.scanDetailsButton.setAttribute('aria-expanded', 'false');
      }
    });
  }
}
