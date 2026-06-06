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
    onAnalyze,
    onSelect,
    onContextMenu,
    onMessage
  }) {
    this.elements = elements;
    this.extensionColor = extensionColor;
    this.tooltip = tooltip;
    this.onAnalyze = onAnalyze;
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
    this.itemCache = new WeakMap();
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
    this.itemCache = new WeakMap();
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
    this.itemCache = new WeakMap();
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
    const items = this.collectItems(this.scope, limit);
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

    this.renderItems = [];
    const workerItems = items.map((item) => this.serializeItem(item));
    this.renderId++;
    const aggregatedFileCount = this.renderItems
      .filter((item) => item.synthetic)
      .reduce((sum, item) => sum + Number(item.fileCount || 0), 0);
    treemapCanvas.dataset.aggregatedFileCount = String(aggregatedFileCount);
    this.worker.postMessage({
      type: 'render',
      renderId: this.renderId,
      width,
      height,
      dpr,
      highlightedExtension: this.highlightedExtension,
      items: workerItems
    });
  }

  collectItems(scope, limit) {
    const candidates = this.sortedItems(scope);
    const minimumSize = Math.max(4096, Number(scope.value || 0) / Math.max(1, limit * 6));
    const hasExpandableDirectories = candidates.some((node) => (
      node.data.type === 'directory' && node.children?.length
    ));
    const topLevelLimit = hasExpandableDirectories
      ? Math.min(
          limit,
          Math.max(
            TREEMAP.minimumTopLevelItems,
            Math.floor(limit * TREEMAP.topLevelShare)
          )
        )
      : limit;
    const visibleNodes = [];
    for (const node of candidates) {
      if (visibleNodes.length >= topLevelLimit) {
        break;
      }
      if (visibleNodes.length >= 80 && node.value < minimumSize) {
        break;
      }
      visibleNodes.push(node);
    }

    const hiddenTopLevelCount = candidates.length - visibleNodes.length;
    const topLevelAggregateCost = hiddenTopLevelCount > 0 ? 1 : 0;
    let childBudget = Math.max(
      0,
      limit - visibleNodes.length - topLevelAggregateCost
    );
    const expandableNodes = visibleNodes.filter((node) => (
      node.data.type === 'directory' && node.children?.length
    ));
    const expandableSize = expandableNodes.reduce(
      (sum, node) => sum + Number(node.value || 0),
      0
    );
    let remainingExpandableSize = expandableSize;
    let remainingExpandableCount = expandableNodes.length;

    const visible = visibleNodes.map((node) => {
      let childLimit = 0;
      if (node.data.type === 'directory' && node.children?.length && childBudget > 0) {
        const proportionalShare = remainingExpandableSize > 0
          ? Math.floor(childBudget * Number(node.value || 0) / remainingExpandableSize)
          : Math.floor(childBudget / Math.max(1, remainingExpandableCount));
        childLimit = Math.min(
          childBudget,
          TREEMAP.maximumChildrenPerContainer,
          Math.max(2, proportionalShare)
        );
        childBudget -= childLimit;
        remainingExpandableSize -= Number(node.value || 0);
        remainingExpandableCount--;
      }
      return this.createItem(node, childLimit);
    });

    let remainder = 0;
    let remainderFiles = 0;
    for (let index = visibleNodes.length; index < candidates.length; index++) {
      remainder += candidates[index].value;
      remainderFiles += Number(candidates[index].data.itemCount || 1);
    }
    if (remainder > 0) {
      visible.push(this.createAggregateItem({
        name: `Other items (${formatCount(hiddenTopLevelCount)})`,
        path: `diskstatsx:aggregate:items:${scope.data.path}`,
        size: remainder,
        count: remainderFiles || hiddenTopLevelCount
      }));
    }
    return visible;
  }

  createItem(node, childLimit = 0) {
    const item = {
      name: node.data.name,
      path: node.data.path,
      size: node.value,
      type: node.data.type,
      synthetic: Boolean(node.data.synthetic),
      cloudOnly: Boolean(node.data.cloudOnly),
      extension: this.itemCategory(node),
      colorKey: node.data.type === 'directory'
        ? `folder:${node.data.path}`
        : this.itemCategory(node),
      sourceNode: node,
      fileCount: node.data.itemCount || 1
    };
    if (childLimit <= 0 || !node.children?.length) {
      return item;
    }

    const candidates = this.sortedItems(node);
    const hasRemainder = candidates.length > childLimit;
    const visibleCount = hasRemainder ? Math.max(0, childLimit - 1) : childLimit;
    const visibleNodes = candidates.slice(0, visibleCount);
    item.children = visibleNodes.map((child) => this.createItem(child));

    if (hasRemainder) {
      const hiddenNodes = candidates.slice(visibleCount);
      item.children.push(this.createAggregateItem({
        name: `Other items (${formatCount(hiddenNodes.length)})`,
        path: `diskstatsx:aggregate:items:${node.data.path}`,
        size: hiddenNodes.reduce((sum, child) => sum + Number(child.value || 0), 0),
        count: hiddenNodes.reduce(
          (sum, child) => sum + Number(child.data.itemCount || 1),
          0
        )
      }));
    }
    return item;
  }

  createAggregateItem({ name, path, size, count }) {
    return {
      name,
      path,
      size,
      type: 'aggregate',
      synthetic: true,
      cloudOnly: false,
      extension: '<other>',
      colorKey: '<other>',
      sourceNode: null,
      fileCount: count
    };
  }

  serializeItem(item) {
    const itemIndex = this.renderItems.length;
    this.renderItems.push(item);
    const serialized = {
      itemIndex,
      name: item.name,
      path: item.path,
      size: item.size,
      extension: item.extension,
      fileCount: item.fileCount || 1,
      color: this.extensionColor(item.colorKey)
    };
    if (item.children?.length) {
      serialized.children = item.children.map((child) => this.serializeItem(child));
    }
    return serialized;
  }

  sortedItems(scope) {
    if (!this.itemCache.has(scope)) {
      const items = (scope.children || [])
        .filter((node) => node.value > 0)
        .sort((left, right) => right.value - left.value);
      this.itemCache.set(scope, items);
    }
    return this.itemCache.get(scope);
  }

  itemCategory(node) {
    if (node.data.type === 'directory') {
      return '<folder>';
    }
    if (node.data.type === 'aggregate') {
      return '<other>';
    }
    return getExtension(node.data.name);
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
      if (tile?.item.type === 'directory') {
        this.onAnalyze(tile.item.sourceNode);
      } else if (tile && !tile.item.synthetic) {
        this.onSelect(tile.item.path);
      }
    });

    overlay.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const tile = this.findTile(event.clientX, event.clientY);
      if (!tile || tile.item.synthetic) {
        return;
      }
      this.onSelect(tile.item.path);
      this.onContextMenu(event, {
        name: tile.item.name,
        path: tile.item.path,
        type: tile.item.type,
        node: tile.item.sourceNode
      });
    });
  }
}
