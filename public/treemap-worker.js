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
  const area = tileWidth * tileHeight;
  const dim = !tile.container && highlightedExtension &&
    item.extension !== highlightedExtension;
  const bright = base.brighter(dim ? 0.15 : 1.25);
  const dark = base.darker(dim ? 2.2 : 1.35);

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

  if (area < 220) {
    context.fillStyle = dim ? dark.formatRgb() : base.formatRgb();
  } else {
    const linear = context.createLinearGradient(x0, y0, x0 + tileWidth, y0 + tileHeight);
    linear.addColorStop(0, bright.formatRgb());
    linear.addColorStop(0.52, base.formatRgb());
    linear.addColorStop(1, dark.formatRgb());
    context.fillStyle = linear;
  }
  context.fillRect(x0, y0, tileWidth, tileHeight);

  if (area >= 900) {
    const glow = context.createRadialGradient(
      x0 + tileWidth * 0.56,
      y0 + tileHeight * 0.44,
      0,
      x0 + tileWidth * 0.56,
      y0 + tileHeight * 0.44,
      Math.max(tileWidth, tileHeight) * 0.58
    );
    glow.addColorStop(0, dim ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.58)');
    glow.addColorStop(0.42, dim ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.13)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = glow;
    context.fillRect(x0, y0, tileWidth, tileHeight);
  }

  context.strokeStyle = dim ? 'rgba(0,0,0,0.42)' : 'rgba(255,255,255,0.23)';
  context.lineWidth = 1;
  context.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(0, tileWidth - 1), Math.max(0, tileHeight - 1));

  if (tileWidth > 78 && tileHeight > 30) {
    context.save();
    context.beginPath();
    context.rect(x0, y0, tileWidth, tileHeight);
    context.clip();
    context.fillStyle = dim ? 'rgba(255,255,255,0.48)' : 'rgba(255,255,255,0.9)';
    context.shadowColor = 'rgba(0,0,0,0.7)';
    context.shadowBlur = 2;
    context.font = '600 10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
    context.fillText(item.name, x0 + 5, y0 + 14, tileWidth - 10);
    context.restore();
  }
}
