import { ApiClient } from './core/api.mjs';
import { createColorScales } from './core/colors.mjs';
import { createDomReferences } from './core/dom.mjs';
import {
  buildHierarchy,
  collectLargestFilesSummary
} from './core/hierarchy.mjs';
import { AppStore } from './core/store.mjs';
import { createDemoTree } from './demo-data.mjs';
import { ContextMenu } from './components/context-menu.mjs';
import { CleanupController } from './components/cleanup-controller.mjs';
import { FilterController } from './components/filter-controller.mjs';
import { HistoryController } from './components/history-controller.mjs';
import { PanelsView } from './components/panels-view.mjs';
import { ReviewController } from './components/review-controller.mjs';
import { SearchController } from './components/search-controller.mjs';
import { StatusView } from './components/status-view.mjs';
import { SunburstView } from './components/sunburst-view.mjs';
import { Tooltip } from './components/tooltip.mjs';
import { TreeView } from './components/tree-view.mjs';
import { TreemapView } from './components/treemap-view.mjs';
import { ToolsMenuController } from './components/tools-menu-controller.mjs';

document.documentElement.classList.toggle(
  'electron-macos',
  window.diskStatsX?.platform === 'darwin'
);

class DiskStatsApp {
  constructor() {
    const urlParameters = new URLSearchParams(window.location.search);
    this.elements = createDomReferences();
    this.api = new ApiClient();
    this.store = new AppStore();
    this.colors = createColorScales();
    this.tooltip = new Tooltip(this.elements.tooltip);
    this.filters = new FilterController(this.elements);
    this.statusView = new StatusView(this.elements);
    this.eventSource = null;
    this.elapsedTimer = null;
    this.resultLoadPromise = null;
    this.resultLoadPath = null;
    this.resultRequestId = 0;
    this.resultAbortController = null;
    this.largestFilesSummary = null;
    this.demoMode = urlParameters.has('demo');
    this.initialView = urlParameters.get('view') === 'sunburst' ? 'sunburst' : 'treemap';
    this.reviewController = new ReviewController({
      elements: this.elements,
      onMessage: (message) => this.setToolbarMessage(message)
    });

    this.contextMenu = new ContextMenu({
      element: this.elements.contextMenu,
      api: this.api,
      getRoot: () => this.store.state.root,
      onAnalyze: (node) => this.navigateToDirectory(node),
      onAnalyzePath: (path) => this.fetchResult(path),
      onRescan: (path) => this.startScan(path),
      onExclude: (path) => {
        if (this.filters.addPath(path)) {
          this.setToolbarMessage('Folder added to permanent exclusions');
        } else {
          this.setToolbarMessage('Folder is already excluded');
        }
      },
      onToggleReview: (target) => this.reviewController.toggle(target),
      isReviewed: (path) => this.reviewController.has(path),
      onMessage: (message) => this.setToolbarMessage(message)
    });

    this.historyController = new HistoryController({
      elements: this.elements,
      api: this.api,
      onActivate: (status) => this.activateSnapshot(status),
      onMessage: (message) => this.setToolbarMessage(message)
    });
    this.searchController = new SearchController({
      elements: this.elements,
      api: this.api,
      onContextMenu: (event, target) => this.contextMenu.show(event, target),
      onSelect: (path) => this.setSelectedPath(path),
      onToggleReview: (target) => this.reviewController.toggle(target),
      isReviewed: (path) => this.reviewController.has(path),
      onMessage: (message) => this.setToolbarMessage(message)
    });
    this.cleanupController = new CleanupController({
      elements: this.elements,
      api: this.api,
      onContextMenu: (event, target) => this.contextMenu.show(event, target),
      onToggleReview: (target) => this.reviewController.toggle(target),
      onAddToReview: (targets) => this.reviewController.addMany(targets),
      isReviewed: (path) => this.reviewController.has(path),
      onMessage: (message) => this.setToolbarMessage(message)
    });
    this.toolsMenu = new ToolsMenuController({
      elements: this.elements,
      onAction: (action) => this.openTool(action)
    });

    const commonCallbacks = {
      onAnalyze: (node) => this.navigateToDirectory(node),
      onNavigatePath: (path) => this.fetchResult(path),
      onSelect: (path) => this.setSelectedPath(path),
      onHover: (path) => this.setHoveredPath(path),
      onContextMenu: (event, target) => this.contextMenu.show(event, target)
    };

    this.treeView = new TreeView({
      wrapper: this.elements.treeTableWrap,
      body: this.elements.treemapTable,
      ...commonCallbacks
    });
    this.treemapView = new TreemapView({
      elements: this.elements,
      extensionColor: this.colors.extension,
      tooltip: this.tooltip,
      ...commonCallbacks,
      onMessage: (message) => this.setToolbarMessage(message)
    });
    this.sunburstView = new SunburstView({
      elements: this.elements,
      colorScale: this.colors.sunburst,
      tooltip: this.tooltip,
      ...commonCallbacks
    });
    this.panelsView = new PanelsView({
      elements: this.elements,
      extensionColor: this.colors.extension,
      ...commonCallbacks,
      onHighlightExtension: (extension) => this.treemapView.setHighlightedExtension(extension),
      onToggleReview: (target) => this.reviewController.toggle(target),
      isReviewed: (path) => this.reviewController.has(path)
    });

    this.bind();
    if (this.initialView === 'sunburst') {
      this.setView(this.initialView);
    }
    this.renderStatus();
    if (this.demoMode) {
      this.loadDemo();
    } else {
      this.initializeLiveMode();
    }
  }

  async initializeLiveMode() {
    await this.loadConfig();
    this.connectEvents();
  }

  loadDemo() {
    const data = createDemoTree();
    this.elements.pathInput.value = data.path;
    this.loadTree(data);
    const root = this.store.state.root;
    this.updateStatus({
      state: 'done',
      filesScanned: root.fileCount,
      directoriesScanned: root.subdirCount + 1,
      bytesDiscovered: root.value,
      elapsedMs: 1840
    });
    this.setToolbarMessage('Demo dataset · anonymized');
  }

  async loadConfig() {
    try {
      const config = await this.api.getConfig();
      if (config.defaultScanPath && this.elements.pathInput.value === '/') {
        this.elements.pathInput.value = config.defaultScanPath;
      }
    } catch {
      // The root path remains a valid default if configuration is unavailable.
    }
  }

  bind() {
    this.elements.form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const path = this.elements.pathInput.value.trim();
      if (!path) {
        return;
      }
      try {
        await this.startScan(path);
      } catch (error) {
        this.handleScanError({ state: 'error', error: error.message });
      }
    });

    this.elements.cancelButton.addEventListener('click', async () => {
      try {
        await this.cancelScan();
      } catch (error) {
        this.handleScanError({ state: 'error', error: error.message });
      }
    });

    this.elements.chooseDirectoryButton.addEventListener('click', async () => {
      if (!window.diskStatsX?.selectDirectory) {
        this.setToolbarMessage('Folder picker is available in the desktop app');
        return;
      }
      try {
        const selectedPath = await window.diskStatsX.selectDirectory();
        if (selectedPath) {
          this.elements.pathInput.value = selectedPath;
          this.elements.pathInput.focus();
          this.setToolbarMessage('Folder selected');
        }
      } catch (error) {
        this.setToolbarMessage(error.message || 'Could not open folder picker');
      }
    });

    this.elements.treemapViewButton.addEventListener('click', () => this.setView('treemap'));
    this.elements.sunburstViewButton.addEventListener('click', () => this.setView('sunburst'));
    this.elements.layoutVerticalButton.addEventListener('click', () => this.setLayout('vertical'));
    this.elements.layoutHorizontalButton.addEventListener('click', () => this.setLayout('horizontal'));

    this.elapsedTimer = window.setInterval(() => {
      const status = this.store.state.status;
      if (status.state === 'running' || status.state === 'canceling') {
        this.store.updateStatus({ elapsedMs: Number(status.elapsedMs || 0) + 1000 });
        this.renderStatus();
      }
    }, 1000);
  }

  connectEvents() {
    this.eventSource = this.api.connectEvents({
      snapshot: (payload) => {
        this.updateStatus(payload);
        if (payload.resultReady) {
          this.elements.pathInput.value = payload.rootPath;
          this.fetchResult(payload.rootPath);
        }
      },
      started: (payload) => this.updateStatus(payload),
      progress: (payload) => this.updateStatus(payload),
      canceling: (payload) => this.updateStatus(payload),
      canceled: (payload) => {
        this.updateStatus(payload);
        this.showEmptyState(
          'Scan canceled',
          'Choose a folder when you are ready to scan again.'
        );
      },
      done: (payload) => {
        this.updateStatus(payload);
        this.elements.pathInput.value = payload.rootPath;
        this.fetchResult(payload.rootPath);
        if (this.elements.historyDialog.open) {
          this.historyController.refresh();
        }
      },
      'scan-error': (payload) => this.handleScanError(payload),
      'connection-error': () => {
        if (this.store.state.status.state === 'running') {
          this.setToolbarMessage('Waiting for progress connection');
        }
      }
    });
  }

  async startScan(path) {
    if (this.demoMode) {
      this.demoMode = false;
      await this.loadConfig();
    }
    this.cancelResultLoad();
    this.resultRequestId++;
    this.largestFilesSummary = null;
    this.reviewController.clear();
    this.searchController.invalidate();
    this.cleanupController.invalidate();
    this.store.resetForScan(path);
    this.clearViews();
    this.showEmptyState(
      'Scanning...',
      'Progress updates will appear while the native scanner walks the tree.'
    );
    this.renderStatus();
    await this.api.startScan(path, this.filters.value);
    if (!this.eventSource) {
      this.connectEvents();
    }
  }

  async cancelScan() {
    if (this.store.state.status.state !== 'running') {
      return;
    }
    this.updateStatus({ state: 'canceling' });
    await this.api.cancelScan();
  }

  async fetchResult(path = this.store.state.status.rootPath) {
    if (!path) {
      return;
    }
    if (this.resultLoadPromise && this.resultLoadPath === path) {
      return this.resultLoadPromise;
    }
    this.resultAbortController?.abort();
    const controller = new globalThis.AbortController();
    this.resultAbortController = controller;
    const requestId = ++this.resultRequestId;
    this.resultLoadPath = path;
    this.setToolbarMessage(`Loading ${path}`);
    this.resultLoadPromise = this.loadResult(path, requestId, controller.signal)
      .finally(() => {
        if (requestId === this.resultRequestId) {
          this.resultLoadPromise = null;
          this.resultLoadPath = null;
          this.resultAbortController = null;
        }
      });
    return this.resultLoadPromise;
  }

  async activateSnapshot(status) {
    if (!status?.rootPath) {
      return;
    }
    this.cancelResultLoad();
    this.resultRequestId++;
    this.largestFilesSummary = null;
    this.reviewController.clear();
    this.searchController.invalidate();
    this.cleanupController.invalidate();
    this.updateStatus(status);
    this.elements.pathInput.value = status.rootPath;
    this.clearViews();
    await this.fetchResult(status.rootPath);
  }

  async openTool(action) {
    if (this.demoMode) {
      this.setToolbarMessage('Tools are available after a native scan');
      return;
    }
    if (action === 'history') {
      await this.historyController.open();
      return;
    }
    if (action === 'search') {
      this.searchController.open();
      return;
    }
    if (action === 'cleanup') {
      await this.cleanupController.open();
    }
  }

  async loadResult(path, requestId, signal) {
    try {
      const data = await this.api.getResult(path, { signal });
      if (data && requestId === this.resultRequestId) {
        this.loadTree(data);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }
      if (requestId !== this.resultRequestId) {
        return;
      }
      this.setToolbarMessage(error.message || 'Could not load the directory');
    }
  }

  cancelResultLoad() {
    this.resultAbortController?.abort();
    this.resultAbortController = null;
    this.resultLoadPromise = null;
    this.resultLoadPath = null;
  }

  loadTree(data) {
    const root = buildHierarchy(data);
    if (data.largestFiles) {
      this.largestFilesSummary = data.largestFiles;
    } else if (!data.lazy) {
      this.largestFilesSummary = collectLargestFilesSummary(data);
    }
    this.store.update({
      treeData: data,
      root,
      analysisNode: root,
      selectedPath: root.data.path,
      largestFilesSummary: this.largestFilesSummary
    });
    this.renderStatus();

    this.elements.emptyState.classList.add('hidden');
    this.elements.treemapEmpty.classList.add('hidden');
    this.treeView.setRoot(root);
    this.treemapView.setRoot(root);
    this.sunburstView.setRoot(root);
    this.panelsView.setLargestFiles(this.largestFilesSummary);
    this.applyAnalysisNode(root, { animateSunburst: false });
    this.setView(this.store.state.view);
    this.setToolbarMessage(data.path);
  }

  navigateToDirectory(node) {
    if (!node || node.data.type !== 'directory') {
      return;
    }
    if (
      !this.demoMode &&
      this.store.state.root?.data.lazy &&
      node.data.path !== this.store.state.root.data.path
    ) {
      this.fetchResult(node.data.path);
      return;
    }
    this.applyAnalysisNode(node);
  }

  applyAnalysisNode(node, { animateSunburst = true } = {}) {
    this.store.update({ analysisNode: node });
    this.treeView.setAnalysisNode(node);
    this.treemapView.setScope(node);
    this.sunburstView.setFocus(node, { animate: animateSunburst });
    this.panelsView.renderScope(node);
    this.setSelectedPath(node.data.path);
  }

  setSelectedPath(path) {
    this.store.update({ selectedPath: path });
    this.treeView.setSelectedPath(path);
    this.treemapView.setSelectedPath(path);
    this.sunburstView.setSelectedPath(path);
    this.panelsView.setSelectedPath(path);
  }

  setHoveredPath(path) {
    this.treeView.setHoveredPath(path);
    this.treemapView.setHoveredPath(path);
    this.sunburstView.setHoveredPath(path);
  }

  setView(view) {
    this.store.update({ view });
    const treemap = view === 'treemap';
    this.elements.treemapViewButton.classList.toggle('active', treemap);
    this.elements.sunburstViewButton.classList.toggle('active', !treemap);
    this.elements.treemapView.classList.toggle('active', treemap);
    this.elements.sunburstView.classList.toggle('active', !treemap);
    requestAnimationFrame(() => {
      if (treemap) {
        this.treemapView.render();
      } else {
        this.sunburstView.resize();
      }
    });
  }

  setLayout(layout) {
    this.store.update({ layout });
    const vertical = layout === 'vertical';
    this.elements.workspace.classList.toggle('layout-vertical', vertical);
    this.elements.workspace.classList.toggle('layout-horizontal', !vertical);
    this.elements.layoutVerticalButton.classList.toggle('active', vertical);
    this.elements.layoutHorizontalButton.classList.toggle('active', !vertical);
    requestAnimationFrame(() => {
      this.treeView.renderVisibleRows();
      this.treemapView.render();
      this.sunburstView.resize();
    });
  }

  updateStatus(payload) {
    this.store.updateStatus(payload);
    this.renderStatus();
  }

  renderStatus() {
    this.statusView.render(
      this.store.state.status,
      this.store.state.treeData?.size || this.store.state.root?.value || 0,
      this.store.state.treeData?.scanSummary || null
    );
  }

  handleScanError(payload) {
    this.updateStatus(payload);
    this.showEmptyState(
      'Scan failed',
      payload.error || 'The scanner reported an error.'
    );
  }

  setToolbarMessage(message) {
    this.elements.toolbarState.textContent = message;
  }

  showEmptyState(title, description) {
    for (const emptyState of [this.elements.emptyState, this.elements.treemapEmpty]) {
      emptyState.classList.remove('hidden');
      emptyState.querySelector('h1').textContent = title;
      emptyState.querySelector('p').textContent = description;
    }
  }

  clearViews() {
    this.treeView.clear();
    this.treemapView.clear();
    this.sunburstView.clear();
    this.panelsView.clear();
  }
}

new DiskStatsApp();
