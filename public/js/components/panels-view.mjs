import { collectExtensionStats } from '../core/hierarchy.mjs';
import {
  escapeHtml,
  extensionDescription,
  formatSize
} from '../core/format.mjs';

export class PanelsView {
  constructor({
    elements,
    extensionColor,
    onAnalyze,
    onSelect,
    onContextMenu,
    onHighlightExtension
  }) {
    this.elements = elements;
    this.onAnalyze = onAnalyze;
    this.onSelect = onSelect;
    this.onContextMenu = onContextMenu;
    this.onHighlightExtension = onHighlightExtension;
    this.largestFilesSummary = null;
    this.selectedPath = null;
    this.fileSort = { key: 'size', direction: -1 };
    this.extensionColor = extensionColor;
    this.bind();
  }

  setLargestFiles(summary) {
    this.largestFilesSummary = summary;
    this.renderLargestFiles();
  }

  setSelectedPath(path) {
    this.selectedPath = path;
    for (const item of this.elements.largestFolders.querySelectorAll('.folder-item')) {
      item.classList.toggle('selected', item.dataset.path === path);
    }
  }

  renderScope(node) {
    this.renderLargestFolders(node);
    this.renderExtensions(node);
  }

  clear() {
    this.largestFilesSummary = null;
    this.elements.largestFolders.replaceChildren();
    this.elements.largestFiles.replaceChildren();
    this.elements.extensionTable.replaceChildren();
  }

  renderLargestFolders(node) {
    const directories = (node.children || [])
      .filter((child) => child.data.type === 'directory')
      .sort((left, right) => right.value - left.value)
      .slice(0, 100);
    const fragment = document.createDocumentFragment();

    if (!directories.length) {
      const empty = document.createElement('div');
      empty.className = 'folder-item';
      empty.innerHTML = '<span class="folder-name">No folders</span><span class="folder-size">0 B</span>';
      fragment.appendChild(empty);
    }

    for (const folder of directories) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'folder-item';
      item.dataset.path = folder.data.path;
      item.innerHTML = `
        <span>
          <span class="folder-name">${escapeHtml(folder.data.name)}</span>
          <span class="folder-path">${escapeHtml(folder.data.path)}</span>
        </span>
        <span class="folder-size">${formatSize(folder.value)}</span>
      `;
      item.addEventListener('click', () => this.onAnalyze(folder));
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.onContextMenu(event, this.targetForNode(folder));
      });
      fragment.appendChild(item);
    }

    this.elements.largestFolders.replaceChildren(fragment);
    this.setSelectedPath(this.selectedPath);
  }

  renderLargestFiles() {
    const fragment = document.createDocumentFragment();
    const summary = this.largestFilesSummary;

    if (!summary?.global?.length && !summary?.firstLevel?.length) {
      fragment.appendChild(this.createFileGroupRow('No files', 'No allocated files found'));
      this.elements.largestFiles.replaceChildren(fragment);
      return;
    }

    if (summary.global?.length) {
      fragment.appendChild(this.createFileGroupRow(
        'Top 10 overall',
        'Largest allocated files in the complete scan'
      ));
      for (const file of this.sortedFiles(summary.global)) {
        fragment.appendChild(this.createFileRow(file));
      }
    }

    for (const group of summary.firstLevel || []) {
      fragment.appendChild(this.createFileGroupRow(group.name, group.path));
      for (const file of this.sortedFiles(group.files || [])) {
        fragment.appendChild(this.createFileRow(file));
      }
      if (group.other) {
        fragment.appendChild(this.createFileRow(group.other, {
          displayPath: `${group.other.itemCount} remaining ${
            group.other.itemCount === 1 ? 'file' : 'files'
          }`
        }));
      }
    }
    this.elements.largestFiles.replaceChildren(fragment);
  }

  sortedFiles(files) {
    return [...files].sort((left, right) => {
      const { key, direction } = this.fileSort;
      if (key === 'size') {
        return (Number(left.size || 0) - Number(right.size || 0)) * direction;
      }
      return String(left[key] || '').localeCompare(String(right[key] || '')) * direction;
    });
  }

  createFileGroupRow(name, path) {
    const row = document.createElement('tr');
    row.className = 'file-group-row';
    row.innerHTML = `
      <td colspan="3">
        <span class="file-group-name">${escapeHtml(name)}</span>
        <span class="file-group-path" title="${escapeHtml(path)}">${escapeHtml(path)}</span>
      </td>
    `;
    return row;
  }

  createFileRow(file, { displayPath = file.path } = {}) {
    const row = document.createElement('tr');
    row.classList.toggle('aggregate-row', Boolean(file.synthetic));
    row.innerHTML = `
      <td class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</td>
      <td>${formatSize(file.size)}</td>
      <td class="file-path" title="${escapeHtml(displayPath)}">${escapeHtml(displayPath)}</td>
    `;
    if (file.synthetic) {
      return row;
    }
    row.addEventListener('click', () => this.onSelect(file.path));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.onContextMenu(event, {
        name: file.name,
        path: file.path,
        type: 'file',
        node: null
      });
    });
    return row;
  }

  renderExtensions(node) {
    const rows = collectExtensionStats(node).slice(0, 80);
    const total = node.value || 1;
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      const color = this.extensionColor(row.extension);
      const tableRow = document.createElement('tr');
      tableRow.dataset.extension = row.extension;
      tableRow.innerHTML = `
        <td title="${escapeHtml(row.extension)}">${escapeHtml(row.extension)}</td>
        <td><span class="color-swatch" style="background:${color}"></span></td>
        <td title="${escapeHtml(extensionDescription(row.extension))}">${escapeHtml(extensionDescription(row.extension))}</td>
        <td>${formatSize(row.size)}</td>
        <td>${((row.size / total) * 100).toFixed(1)}</td>
      `;
      tableRow.addEventListener('mouseenter', () => this.onHighlightExtension(row.extension));
      tableRow.addEventListener('mouseleave', () => this.onHighlightExtension(null));
      fragment.appendChild(tableRow);
    }
    this.elements.extensionTable.replaceChildren(fragment);
  }

  setTab(tabName) {
    const files = tabName === 'files';
    this.elements.filesTab.classList.toggle('active', files);
    this.elements.foldersTab.classList.toggle('active', !files);
    this.elements.filesPanel.classList.toggle('active', files);
    this.elements.foldersPanel.classList.toggle('active', !files);
  }

  bind() {
    this.elements.foldersTab.addEventListener('click', () => this.setTab('folders'));
    this.elements.filesTab.addEventListener('click', () => this.setTab('files'));
    for (const header of document.querySelectorAll('.files-table th[data-sort]')) {
      header.addEventListener('click', () => {
        const key = header.dataset.sort;
        if (this.fileSort.key === key) {
          this.fileSort.direction *= -1;
        } else {
          this.fileSort = { key, direction: key === 'size' ? -1 : 1 };
        }
        this.renderLargestFiles();
      });
    }
  }

  targetForNode(node) {
    return {
      name: node.data.name,
      path: node.data.path,
      type: node.data.type,
      node
    };
  }
}
