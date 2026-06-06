import { STORAGE_KEYS, SUNBURST } from '../core/config.mjs';
import { formatCount, formatSize } from '../core/format.mjs';

const d3 = globalThis.d3;

export class SunburstView {
  constructor({
    elements,
    colorScale,
    tooltip,
    onAnalyze,
    onNavigatePath,
    onSelect,
    onContextMenu
  }) {
    this.elements = elements;
    this.colorScale = colorScale;
    this.tooltip = tooltip;
    this.onAnalyze = onAnalyze;
    this.onNavigatePath = onNavigatePath;
    this.onSelect = onSelect;
    this.onContextMenu = onContextMenu;
    this.root = null;
    this.focusNode = null;
    this.selectedPath = null;
    this.svg = null;
    this.arcLayer = null;
    this.labelLayer = null;
    this.centerLayer = null;
    this.radius = 0;
    this.centerRadius = 0;
    this.rings = this.restoreRings();
    this.showFiles = true;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.elements.sunburstRings.value = String(this.rings);
    this.bindControls();
  }

  setRoot(root) {
    this.root = root;
    this.focusNode = root;
    this.elements.sunburstRings.disabled = Boolean(root.data.lazy);
    this.elements.emptyState.classList.add('hidden');
    this.initializeSvg();
    this.resizeObserver.observe(this.elements.chart);
    this.render({ animate: false });
  }

  setFocus(node, { animate = true } = {}) {
    if (!node || node.data.type !== 'directory') {
      return;
    }
    this.focusNode = node;
    this.renderBreadcrumb();
    this.render({ animate });
  }

  setSelectedPath(path) {
    this.selectedPath = path;
    this.arcLayer?.selectAll('.sunburst-arc')
      .classed('highlighted', (node) => node.data.path === path);
  }

  clear() {
    this.root = null;
    this.focusNode = null;
    this.selectedPath = null;
    this.elements.chart.replaceChildren();
    this.elements.breadcrumb.replaceChildren();
    this.elements.sunburstSegmentCount.textContent = '0 segments';
    this.elements.sunburstRings.disabled = false;
    this.svg = null;
  }

  initializeSvg() {
    this.elements.chart.replaceChildren();
    this.svg = d3.select(this.elements.chart)
      .append('svg')
      .attr('role', 'img')
      .attr('aria-label', 'Interactive disk usage sunburst');

    const surface = this.svg.append('g').attr('class', 'sunburst-surface');
    this.guideLayer = surface.append('g').attr('class', 'sunburst-guides');
    this.arcLayer = surface.append('g').attr('class', 'sunburst-arcs');
    this.labelLayer = surface.append('g').attr('class', 'sunburst-labels');
    this.centerLayer = surface.append('g').attr('class', 'sunburst-center');

    this.centerLayer.append('circle')
      .attr('class', 'center-disc')
      .on('click', () => {
        if (this.focusNode?.parent) {
          this.onAnalyze(this.focusNode.parent);
        } else if (this.focusNode?.data.parentPath) {
          this.onNavigatePath(this.focusNode.data.parentPath);
        }
      });
    this.centerLayer.append('text').attr('class', 'center-back').text('↑');
    this.centerLayer.append('text').attr('class', 'center-label');
    this.centerLayer.append('text').attr('class', 'center-size');
    this.centerLayer.append('text').attr('class', 'center-meta');
    this.resize();
  }

  resize() {
    if (!this.svg || !this.root) {
      return;
    }
    const bounds = this.elements.chart.getBoundingClientRect();
    this.radius = Math.max(190, Math.min(bounds.width, bounds.height) / 2 - 34);
    this.centerRadius = Math.max(56, this.radius * 0.17);
    this.svg.attr('viewBox', `${-this.radius} ${-this.radius} ${this.radius * 2} ${this.radius * 2}`);
    this.render({ animate: false });
  }

  render({ animate = true } = {}) {
    if (!this.svg || !this.focusNode || this.radius <= 0) {
      return;
    }
    const { nodes, omitted } = this.displayNodes();
    this.renderGuides();
    this.renderArcs(nodes, animate);
    this.renderLabels(nodes, animate);
    this.renderCenter();
    this.renderBreadcrumb();
    this.elements.sunburstSegmentCount.textContent = omitted > 0
      ? `${formatCount(nodes.length)} shown · ${formatCount(omitted)} hidden`
      : `${formatCount(nodes.length)} segments`;
  }

  displayNodes() {
    const focus = this.focusNode;
    const focusSpan = Math.max(Number.EPSILON, focus.x1 - focus.x0);
    const eligible = [];
    let candidateCount = 0;

    for (const node of focus.descendants()) {
      if (node === focus) {
        continue;
      }
      const depth = node.depth - focus.depth;
      if (depth > this.rings || (!this.showFiles && node.data.type === 'file')) {
        continue;
      }
      candidateCount++;
      const target = {
        x0: Math.max(0, Math.min(1, (node.x0 - focus.x0) / focusSpan)) * Math.PI * 2,
        x1: Math.max(0, Math.min(1, (node.x1 - focus.x0) / focusSpan)) * Math.PI * 2,
        depth
      };
      const angle = target.x1 - target.x0;
      if (depth === 1 || angle >= SUNBURST.minimumAngle) {
        eligible.push({ node, target, angle });
      }
    }

    const selected = eligible
      .sort((left, right) => right.angle - left.angle)
      .slice(0, SUNBURST.maxSegments);
    const nodes = selected
      .sort((left, right) => left.target.x0 - right.target.x0 || left.target.depth - right.target.depth)
      .map(({ node, target }) => {
        node.sunburstTarget = target;
        return node;
      });
    return {
      nodes,
      omitted: Math.max(0, candidateCount - nodes.length)
    };
  }

  renderGuides() {
    const ringCount = this.visibleRingCount();
    const ringWidth = (this.radius - this.centerRadius) / ringCount;
    this.guideLayer.selectAll('circle')
      .data(d3.range(1, ringCount + 1))
      .join('circle')
      .attr('r', (ring) => this.centerRadius + ring * ringWidth)
      .attr('class', 'sunburst-guide');
  }

  renderArcs(nodes, animate) {
    const selection = this.arcLayer.selectAll('.sunburst-arc')
      .data(nodes, (node) => node.data.path);
    const enter = selection.enter()
      .append('path')
      .attr('class', 'sunburst-arc')
      .attr('fill', (node) => this.colorForNode(node))
      .attr('fill-opacity', (node) => node.data.type === 'directory' ? 0.9 : 0.76)
      .attr('d', (node) => {
        node.sunburstCurrent = this.collapsedPosition(node.sunburstTarget);
        return this.arcPath(node.sunburstCurrent);
      })
      .on('click', (event, node) => {
        event.stopPropagation();
        if (node.data.type === 'directory') {
          this.onAnalyze(node);
        } else if (!node.data.synthetic) {
          this.onSelect(node.data.path);
        }
      })
      .on('contextmenu', (event, node) => {
        event.preventDefault();
        event.stopPropagation();
        if (node.data.synthetic) {
          return;
        }
        this.onContextMenu(event, {
          name: node.data.name,
          path: node.data.path,
          type: node.data.type,
          node
        });
      })
      .on('mouseenter', (event, node) => {
        this.onSelect(node.data.path);
        this.tooltip.showNode(event, node, this.focusNode.value || 1);
      })
      .on('mousemove', (event, node) => {
        this.tooltip.showNode(event, node, this.focusNode.value || 1);
      })
      .on('mouseleave', () => this.tooltip.hide());

    const merged = enter.merge(selection)
      .attr('fill', (node) => this.colorForNode(node))
      .classed('highlighted', (node) => node.data.path === this.selectedPath);

    const applyPosition = (targetSelection) => targetSelection.attrTween('d', (node) => {
      const start = node.sunburstCurrent || this.collapsedPosition(node.sunburstTarget);
      const interpolator = d3.interpolate(start, node.sunburstTarget);
      return (time) => {
        node.sunburstCurrent = interpolator(time);
        return this.arcPath(node.sunburstCurrent);
      };
    });

    if (animate) {
      applyPosition(merged.transition()
        .duration(SUNBURST.transitionMs)
        .ease(d3.easeCubicInOut));
      selection.exit()
        .transition()
        .duration(SUNBURST.transitionMs * 0.65)
        .attr('fill-opacity', 0)
        .remove();
    } else {
      merged.attr('d', (node) => {
        node.sunburstCurrent = node.sunburstTarget;
        return this.arcPath(node.sunburstTarget);
      });
      selection.exit().remove();
    }
  }

  renderLabels(nodes, animate) {
    const labeled = nodes
      .filter((node) => {
        const target = node.sunburstTarget;
        return target.x1 - target.x0 >= SUNBURST.labelMinimumAngle &&
          node.data.name &&
          target.depth <= this.rings;
      })
      .sort((left, right) => {
        const leftAngle = left.sunburstTarget.x1 - left.sunburstTarget.x0;
        const rightAngle = right.sunburstTarget.x1 - right.sunburstTarget.x0;
        return rightAngle - leftAngle;
      })
      .slice(0, SUNBURST.maxLabels);
    const labels = this.labelLayer.selectAll('.sunburst-label')
      .data(labeled, (node) => node.data.path)
      .join(
        (enter) => enter.append('text')
          .attr('class', 'sunburst-label')
          .attr('opacity', 0)
          .text((node) => this.labelText(node)),
        (update) => update.text((node) => this.labelText(node)),
        (exit) => exit.transition().duration(180).attr('opacity', 0).remove()
      );
    const positioned = labels
      .attr('transform', (node) => this.labelTransform(node.sunburstTarget));
    if (animate) {
      positioned.transition().delay(180).duration(260).attr('opacity', 0.86);
    } else {
      positioned.attr('opacity', 0.86);
    }
  }

  renderCenter() {
    const node = this.focusNode;
    const name = node.data.name || node.data.path || '/';
    const shortName = name.length > 23 ? `${name.slice(0, 20)}...` : name;
    this.centerLayer.select('.center-disc').attr('r', this.centerRadius - 5);
    this.centerLayer.select('.center-back')
      .attr('y', -36)
      .classed('visible', Boolean(node.parent || node.data.parentPath));
    this.centerLayer.select('.center-label')
      .attr('y', -9)
      .text(shortName);
    this.centerLayer.select('.center-size')
      .attr('y', 13)
      .text(formatSize(node.value));
    this.centerLayer.select('.center-meta')
      .attr('y', 33)
      .text(`${formatCount(node.fileCount)} files · ${formatCount(node.subdirCount)} folders`);
  }

  renderBreadcrumb() {
    if (!this.focusNode) {
      return;
    }
    if (this.focusNode === this.root && this.root.data.breadcrumbs?.length) {
      const fragment = document.createDocumentFragment();
      for (const part of this.root.data.breadcrumbs) {
        fragment.appendChild(this.createBreadcrumbButton(part, null));
      }
      this.elements.breadcrumb.replaceChildren(fragment);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const part of this.focusNode.ancestors().reverse()) {
      fragment.appendChild(this.createBreadcrumbButton(part.data, part));
    }
    this.elements.breadcrumb.replaceChildren(fragment);
  }

  createBreadcrumbButton(data, node) {
    const button = document.createElement('button');
    button.className = 'crumb';
    button.type = 'button';
    button.textContent = data.name || data.path || '/';
    button.title = data.path || '';
    button.addEventListener('click', () => {
      if (node) {
        this.onAnalyze(node);
      } else {
        this.onNavigatePath(data.path);
      }
    });
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.onContextMenu(event, {
        name: data.name,
        path: data.path,
        type: 'directory',
        node
      });
    });
    return button;
  }

  arcPath(position) {
    const ringWidth = (this.radius - this.centerRadius) / this.visibleRingCount();
    return d3.arc()
      .startAngle(position.x0)
      .endAngle(position.x1)
      .padAngle(Math.min((position.x1 - position.x0) / 2, 0.0045))
      .padRadius(this.radius)
      .innerRadius(this.centerRadius + (position.depth - 1) * ringWidth + 2)
      .outerRadius(this.centerRadius + position.depth * ringWidth - 1)
      .cornerRadius(1.8)();
  }

  collapsedPosition(target) {
    const midpoint = (target.x0 + target.x1) / 2;
    return { ...target, x0: midpoint, x1: midpoint };
  }

  colorForNode(node) {
    let anchor = node;
    while (anchor.parent && anchor.parent !== this.focusNode) {
      anchor = anchor.parent;
    }
    const base = d3.color(this.colorScale(anchor.data.path || anchor.data.name));
    const depth = node.depth - this.focusNode.depth;
    if (node.data.type === 'file') {
      return base.brighter(0.5).formatHex();
    }
    return base.brighter(Math.min(0.65, Math.max(0, depth - 1) * 0.12)).formatHex();
  }

  labelText(node) {
    const target = node.sunburstTarget;
    const ringWidth = (this.radius - this.centerRadius) / this.visibleRingCount();
    const labelRadius = this.centerRadius + (target.depth - 0.5) * ringWidth;
    const available = Math.max(5, Math.floor((target.x1 - target.x0) * labelRadius / 6.2));
    const name = node.data.name || '';
    return name.length > available ? `${name.slice(0, Math.max(2, available - 2))}…` : name;
  }

  labelTransform(position) {
    const angle = (position.x0 + position.x1) / 2;
    const ringWidth = (this.radius - this.centerRadius) / this.visibleRingCount();
    const labelRadius = this.centerRadius + (position.depth - 0.5) * ringWidth;
    const rotation = angle * 180 / Math.PI - 90;
    const flip = angle >= Math.PI ? 180 : 0;
    return `rotate(${rotation}) translate(${labelRadius},0) rotate(${flip})`;
  }

  restoreRings() {
    const saved = Number(localStorage.getItem(STORAGE_KEYS.sunburstRings));
    return [4, 6, 8].includes(saved) ? saved : SUNBURST.defaultRings;
  }

  visibleRingCount() {
    return Math.max(1, Math.min(this.rings, this.focusNode?.height || 1));
  }

  bindControls() {
    this.elements.sunburstRings.addEventListener('change', () => {
      this.rings = Number(this.elements.sunburstRings.value);
      localStorage.setItem(STORAGE_KEYS.sunburstRings, String(this.rings));
      this.render();
    });
    this.elements.sunburstFiles.addEventListener('change', () => {
      this.showFiles = this.elements.sunburstFiles.checked;
      this.render();
    });
  }
}
