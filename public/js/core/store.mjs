const INITIAL_STATUS = {
  state: 'idle',
  currentPath: '',
  filesScanned: 0,
  directoriesScanned: 0,
  bytesDiscovered: 0,
  elapsedMs: 0,
  error: null
};

export class AppStore {
  #listeners = new Set();

  constructor() {
    this.state = {
      treeData: null,
      root: null,
      analysisNode: null,
      selectedPath: null,
      largestFilesSummary: null,
      view: 'treemap',
      layout: 'vertical',
      status: { ...INITIAL_STATUS }
    };
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.#listeners) {
      listener(this.state, patch);
    }
  }

  updateStatus(patch) {
    this.update({
      status: {
        ...this.state.status,
        ...patch
      }
    });
  }

  resetForScan(path) {
    this.update({
      treeData: null,
      root: null,
      analysisNode: null,
      selectedPath: null,
      largestFilesSummary: null,
      status: {
        ...INITIAL_STATUS,
        state: 'running',
        currentPath: path
      }
    });
  }
}
