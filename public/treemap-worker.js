importScripts('/vendor/d3.min.js');

let canvas = null;
let context = null;
let width = 0;
let height = 0;
let dpr = 1;
let tiles = [];
let items = [];
let highlightedExtension = null;

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'init') {
    canvas = message.canvas;
    context = canvas.getContext('2d');
    return;
  }
  if (message.type === 'clear') {
    clearCanvas();
    tiles = [];
    items = [];
    return;
  }
  if (message.type === 'highlight') {
    highlightedExtension = message.extension || null;
    draw();
    return;
  }
  if (message.type === 'render') {
    render(message);
  }
};

function render(message) {
  if (!canvas || !context) {
    return;
  }

  width = message.width;
  height = message.height;
  dpr = message.dpr || 1;
  items = flattenItems(message.items);
  highlightedExtension = message.highlightedExtension || null;
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));

  const hierarchy = d3.hierarchy({ children: message.items })
    .sum((item) => item.children?.length ? 0 : Number(item.size || 0))
    .sort((a, b) => b.value - a.value);

  d3.treemap()
    .tile(d3.treemapSquarify.ratio(1.15))
    .size([width, height])
    .paddingOuter(1)
    .paddingInner(1)
    .paddingTop((node) => node.depth === 1 && node.children ? 19 : 0)
    .round(true)(hierarchy);

  tiles = hierarchy.descendants()
    .filter((node) => node.depth > 0)
    .map((node) => ({
      x0: node.x0,
      y0: node.y0,
      x1: node.x1,
      y1: node.y1,
      width: Math.max(0, node.x1 - node.x0),
      height: Math.max(0, node.y1 - node.y0),
      itemIndex: node.data.itemIndex,
      depth: node.depth,
      container: Boolean(node.children?.length)
    }))
    .filter((tile) => tile.width >= 2 && tile.height >= 2)
    .sort((left, right) => left.depth - right.depth);

  draw();
  self.postMessage({
    type: 'layout',
    renderId: message.renderId,
    tiles
  });
}

function flattenItems(nestedItems) {
  const flattened = [];
  const stack = [...nestedItems];
  while (stack.length) {
    const item = stack.pop();
    flattened[item.itemIndex] = item;
    for (const child of item.children || []) {
      stack.push(child);
    }
  }
  return flattened;
}

function clearCanvas() {
  if (!canvas || !context) {
    return;
  }
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.restore();
}

function draw() {
  if (!context) {
    return;
  }

  context.save();
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#090d10';
  context.fillRect(0, 0, width, height);
  for (const tile of tiles) {
    drawTile(tile, items[tile.itemIndex]);
  }
  context.restore();
}

function drawTile(tile, item) {
  const { x0, y0, width: tileWidth, height: tileHeight } = tile;
  const base = d3.color(item.color);
  const dim = !tile.container && highlightedExtension &&
    item.extension !== highlightedExtension;
  const dark = base.darker(dim ? 2.1 : 1.15);

  if (tile.container) {
    context.fillStyle = dark.darker(1.4).formatRgb();
    context.fillRect(x0, y0, tileWidth, tileHeight);
    context.strokeStyle = 'rgba(255,255,255,0.38)';
    context.lineWidth = 1;
    context.strokeRect(
      x0 + 0.5,
      y0 + 0.5,
      Math.max(0, tileWidth - 1),
      Math.max(0, tileHeight - 1)
    );
    if (tileWidth > 54 && tileHeight > 20) {
      context.save();
      context.beginPath();
      context.rect(x0 + 1, y0 + 1, tileWidth - 2, 17);
      context.clip();
      context.fillStyle = 'rgba(248,251,253,0.9)';
      context.font = '600 10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
      context.fillText(item.name, x0 + 6, y0 + 13, tileWidth - 12);
      context.restore();
    }
    return;
  }

  context.fillStyle = dim ? dark.formatRgb() : base.darker(0.18).formatRgb();
  context.fillRect(x0, y0, tileWidth, tileHeight);
  context.fillStyle = dim ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.1)';
  context.fillRect(x0 + 1, y0 + 1, Math.max(0, tileWidth - 2), 1);
  context.strokeStyle = dim ? 'rgba(0,0,0,0.5)' : 'rgba(8,12,15,0.62)';
  context.lineWidth = 1;
  context.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(0, tileWidth - 1), Math.max(0, tileHeight - 1));

  if (tileWidth > 78 && tileHeight > 30) {
    const showSize = tileWidth > 96 && tileHeight > 48;
    const labelHeight = showSize ? 34 : 21;
    context.save();
    context.beginPath();
    context.rect(x0, y0, tileWidth, tileHeight);
    context.clip();
    context.fillStyle = dim ? 'rgba(8,12,15,0.62)' : 'rgba(8,12,15,0.78)';
    context.fillRect(x0 + 1, y0 + 1, tileWidth - 2, labelHeight);
    context.fillStyle = dim ? 'rgba(248,251,253,0.58)' : 'rgba(248,251,253,0.96)';
    context.font = '600 10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
    context.fillText(item.name, x0 + 5, y0 + 14, tileWidth - 10);
    if (showSize) {
      context.fillStyle = dim ? 'rgba(220,228,234,0.42)' : 'rgba(220,228,234,0.78)';
      context.font = '500 9px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
      context.fillText(formatSize(item.size), x0 + 5, y0 + 27, tileWidth - 10);
    }
    context.restore();
  }
}

function formatSize(bytes) {
  const value = Number(bytes || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  let scaled = value;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  const precision = scaled >= 100 || unit === 0 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(precision)} ${units[unit]}`;
}
