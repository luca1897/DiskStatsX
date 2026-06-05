import { TREEMAP } from '../core/config.mjs';
import {
  formatCount,
  getExtension
} from '../core/format.mjs';

export class TreemapView {
  constructor({
    elements,
    extensionColor,
    tooltip,
    onSelect,
    onContextMenu,
    onMessage
  }) {
    this.elements = elements;
    this.extensionColor = extensionColor;
    this.tooltip = tooltip;
    this.onSelect = onSelect;
    this.onContextMenu = onContextMenu;
    this.onMessage = onMessage;
    this.root = null;
    this.scope = null;
    this.selectedPath = null;
    this.highlightedExtension = null;
    this.tiles = [];
    this.renderItems = [];
    this.renderId = 0;
    this.hoveredTile = null;
    this.fileCache = new WeakMap();
    this.hoverFrame = 0;
    this.pendingPointer = null;
    this.worker = null;
    this.resizeObserver = new ResizeObserver(() => this.render());
    this.initializeWorker();
    this.bind();
  }

  setRoot(root) {
    this.root = root;
    this.scope = root;
    this.fileCache = new WeakMap();
    this.resizeObserver.observe(this.elements.treemapCanvas);
    this.render();
  }

  setScope(node) {
    this.scope = node;
    this.render();
  }

  setSelectedPath(path) {
    this.selectedPath = path;
    this.drawOverlay();
  }

  setHighlightedExtension(extension) {
    this.highlightedExtension = extension;
    this.worker?.postMessage({ type: 'highlight', extension });
  }

  clear() {
    this.renderId++;
    this.root = null;
    this.scope = null;
    this.tiles = [];
    this.renderItems = [];
    this.fileCache = new WeakMap();
    this.elements.treemapCanvas.dataset.tileCount = '0';
    this.elements.treemapCanvas.dataset.aggregatedFileCount = '0';
    this.worker?.postMessage({ type: 'clear' });
    this.drawOverlay();
  }

  render() {
    const { treemapCanvas, treemapBitmap, treemapOverlay, treemapEmpty } = this.elements;
    if (!this.worker || !this.scope || !this.root || !treemapCanvas.clientWidth || !treemapCanvas.clientHeight) {
      return;
    }
    treemapEmpty.classList.add('hidden');
    const width = treemapCanvas.clientWidth;
    const height = treemapCanvas.clientHeight;
    const limit = Math.max(
      TREEMAP.minTiles,
      Math.min(TREEMAP.maxTiles, Math.floor((width * height) / TREEMAP.pixelsPerTile))
    );
    const items = this.collectFiles(this.scope, limit);
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.floor(width * dpr));
    const pixelHeight = Math.max(1, Math.floor(height * dpr));
    if (treemapOverlay.width !== pixelWidth || treemapOverlay.height !== pixelHeight) {
      treemapOverlay.width = pixelWidth;
      treemapOverlay.height = pixelHeight;
    }
    for (const canvas of [treemapBitmap, treemapOverlay]) {
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    this.renderItems = items;
    this.renderId++;
    const aggregate = items.find((item) => item.path === '__other__');
    treemapCanvas.dataset.aggregatedFileCount = String(aggregate?.fileCount || 0);
    this.worker.postMessage({
      type: 'render',
      renderId: this.renderId,
      width,
      height,
      dpr,
      highlightedExtension: this.highlightedExtension,
      items: items.map((item) => ({
        name: item.name,
        path: item.path,
        size: item.size,
        extension: item.extension,
        fileCount: item.fileCount || 1,
        color: this.extensionColor(item.extension)
      }))
    });
  }

  collectFiles(scope, limit) {
    const files = this.sortedLeaves(scope);
    const minimumSize = Math.max(4096, Number(scope.value || 0) / Math.max(1, limit * 6));
    const visibleLeaves = [];
    for (const leaf of files) {
      if (visibleLeaves.length >= limit) {
        break;
      }
      if (visibleLeaves.length >= 80 && leaf.value < minimumSize) {
        break;
      }
      visibleLeaves.push(leaf);
    }

    const visible = visibleLeaves.map((leaf) => ({
      name: leaf.data.name,
      path: leaf.data.path,
      size: leaf.value,
      extension: getExtension(leaf.data.name),
      sourceNode: leaf
    }));
    let remainder = 0;
    for (let index = visibleLeaves.length; index < files.length; index++) {
      remainder += files[index].value;
    }
    if (remainder > 0) {
      const remainderCount = files.length - visibleLeaves.length;
      visible.push({
        name: `Other files (${formatCount(remainderCount)})`,
        path: '__other__',
        size: remainder,
        extension: '<other>',
        sourceNode: null,
        fileCount: remainderCount
      });
    }
    return visible;
  }

  sortedLeaves(scope) {
    if (!this.fileCache.has(scope)) {
      const files = scope.leaves()
        .filter((leaf) => leaf.data.type === 'file' && leaf.value > 0)
        .sort((left, right) => right.value - left.value);
      this.fileCache.set(scope, files);
    }
    return this.fileCache.get(scope);
  }

  initializeWorker() {
    const { treemapBitmap } = this.elements;
    if (!treemapBitmap.transferControlToOffscreen) {
      throw new Error('OffscreenCanvas is required for the Treemap renderer');
    }
    const offscreen = treemapBitmap.transferControlToOffscreen();
    this.worker = new Worker('/treemap-worker.js');
    this.worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
    this.worker.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type !== 'layout' || message.renderId !== this.renderId) {
        return;
      }
      this.tiles = message.tiles.map((tile) => ({
        ...tile,
        item: this.renderItems[tile.itemIndex]
      }));
      this.elements.treemapCanvas.dataset.tileCount = String(this.tiles.length);
      this.hoveredTile = null;
      this.drawOverlay();
    });
    this.worker.addEventListener('error', () => this.onMessage('Treemap worker failed'));
  }

  drawOverlay() {
    const canvas = this.elements.treemapOverlay;
    const width = this.elements.treemapCanvas.clientWidth;
    const height = this.elements.treemapCanvas.clientHeight;
    if (!canvas || width <= 0 || height <= 0) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const context = canvas.getContext('2d');
    context.save();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    for (const tile of this.tiles) {
      const selected = tile.item.path === this.selectedPath;
      const hovered = tile === this.hoveredTile;
      if (!selected && !hovered) {
        continue;
      }
      context.strokeStyle = 'rgba(255,255,255,0.96)';
      context.lineWidth = hovered ? 2.5 : 2;
      context.strokeRect(
        tile.x0 + 1,
        tile.y0 + 1,
        Math.max(0, tile.width - 2),
        Math.max(0, tile.height - 2)
      );
    }
    context.restore();
  }

  findTile(clientX, clientY) {
    const rect = this.elements.treemapOverlay.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    for (let index = this.tiles.length - 1; index >= 0; index--) {
      const tile = this.tiles[index];
      if (x >= tile.x0 && x <= tile.x1 && y >= tile.y0 && y <= tile.y1) {
        return tile;
      }
    }
    return null;
  }

  bind() {
    const overlay = this.elements.treemapOverlay;
    overlay.addEventListener('mousemove', (event) => {
      this.pendingPointer = { clientX: event.clientX, clientY: event.clientY };
      if (this.hoverFrame) {
        return;
      }
      this.hoverFrame = requestAnimationFrame(() => {
        this.hoverFrame = 0;
        const pointer = this.pendingPointer;
        if (!pointer) {
          return;
        }
        const tile = this.findTile(pointer.clientX, pointer.clientY);
        if (!tile) {
          if (this.hoveredTile) {
            this.hoveredTile = null;
            this.drawOverlay();
          }
          this.tooltip.hide();
          overlay.style.cursor = 'default';
          return;
        }
        overlay.style.cursor = 'pointer';
        if (this.hoveredTile !== tile) {
          this.hoveredTile = tile;
          this.drawOverlay();
        }
        this.tooltip.showTreemapItem(pointer, tile.item, this.scope?.value || 1);
      });
    });

    overlay.addEventListener('mouseleave', () => {
      this.pendingPointer = null;
      this.hoveredTile = null;
      this.tooltip.hide();
      this.drawOverlay();
    });

    overlay.addEventListener('click', (event) => {
      const tile = this.findTile(event.clientX, event.clientY);
      if (tile) {
        this.onSelect(tile.item.path);
      }
    });

    overlay.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const tile = this.findTile(event.clientX, event.clientY);
      if (!tile || tile.item.path === '__other__') {
        return;
      }
      this.onSelect(tile.item.path);
      this.onContextMenu(event, {
        name: tile.item.name,
        path: tile.item.path,
        type: 'file',
        node: tile.item.sourceNode
      });
    });
  }
}
