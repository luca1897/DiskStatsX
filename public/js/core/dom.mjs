function requiredElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Required UI element is missing: #${id}`);
  }
  return element;
}

export function createDomReferences() {
  return {
    form: requiredElement('scan-form'),
    pathInput: requiredElement('path-input'),
    chooseDirectoryButton: requiredElement('choose-directory-button'),
    scanButton: requiredElement('scan-button'),
    cancelButton: requiredElement('cancel-button'),
    filterButton: requiredElement('filter-button'),
    filterPopover: requiredElement('filter-popover'),
    filterCaches: requiredElement('filter-caches'),
    filterVolumes: requiredElement('filter-volumes'),
    filterSystem: requiredElement('filter-system'),
    treemapViewButton: requiredElement('treemap-view-button'),
    sunburstViewButton: requiredElement('sunburst-view-button'),
    layoutVerticalButton: requiredElement('layout-vertical-button'),
    layoutHorizontalButton: requiredElement('layout-horizontal-button'),
    toolbarState: requiredElement('toolbar-state'),
    workspace: requiredElement('workspace'),
    treemapView: requiredElement('treemap-view'),
    sunburstView: requiredElement('sunburst-view'),
    treeTableWrap: requiredElement('tree-table-wrap'),
    treemapTable: requiredElement('treemap-table'),
    extensionTable: requiredElement('extension-table'),
    treemapCanvas: requiredElement('treemap-canvas'),
    treemapBitmap: requiredElement('treemap-bitmap'),
    treemapOverlay: requiredElement('treemap-overlay'),
    treemapEmpty: requiredElement('treemap-empty'),
    chart: requiredElement('chart'),
    emptyState: requiredElement('empty-state'),
    breadcrumb: requiredElement('breadcrumb'),
    sunburstRings: requiredElement('sunburst-rings'),
    sunburstFiles: requiredElement('sunburst-files'),
    sunburstSegmentCount: requiredElement('sunburst-segment-count'),
    foldersTab: requiredElement('folders-tab'),
    filesTab: requiredElement('files-tab'),
    foldersPanel: requiredElement('folders-panel'),
    filesPanel: requiredElement('files-panel'),
    largestFolders: requiredElement('largest-folders'),
    largestFiles: requiredElement('largest-files'),
    filesCount: requiredElement('files-count'),
    dirsCount: requiredElement('dirs-count'),
    elapsed: requiredElement('elapsed'),
    totalSize: requiredElement('total-size'),
    tooltip: requiredElement('tooltip'),
    contextMenu: requiredElement('context-menu')
  };
}
