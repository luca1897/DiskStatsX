export const COLORS = {
  sunburst: [
    '#2bb6a8',
    '#f0b64a',
    '#e76678',
    '#4c8df2',
    '#83ce68',
    '#c982e8',
    '#ee8752',
    '#45b8e8',
    '#c4ce4b',
    '#eb6794'
  ],
  extensions: [
    '#f05252',
    '#4f63ff',
    '#22d85d',
    '#00cfc8',
    '#ff00c8',
    '#fff021',
    '#a8a8a8',
    '#ff7a45',
    '#8d6bff',
    '#5ad5ff',
    '#9be55d',
    '#d66fff'
  ]
};

export const TREEMAP = {
  minTiles: 240,
  maxTiles: 1000,
  pixelsPerTile: 700,
  topLevelShare: 0.35,
  minimumTopLevelItems: 48,
  maximumChildrenPerContainer: 96
};

export const TREE_VIEW = {
  rowHeight: 25,
  rowBuffer: 14,
  headerHeight: 27
};

export const SUNBURST = {
  defaultRings: 6,
  maxSegments: 1800,
  maxLabels: 24,
  minimumAngle: 0.0018,
  labelMinimumAngle: 0.075,
  transitionMs: 620
};

export const STORAGE_KEYS = {
  scanFilters: 'diskstatsx.scanFilters',
  sunburstRings: 'diskstatsx.sunburstRings'
};
