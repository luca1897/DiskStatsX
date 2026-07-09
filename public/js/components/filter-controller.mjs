import { STORAGE_KEYS } from '../core/config.mjs';

export class FilterController {
  constructor(elements) {
    this.elements = elements;
    this.exclusions = [];
    this.restore();
    this.bind();
  }

  get value() {
    return {
      caches: this.elements.filterCaches.checked,
      externalVolumes: this.elements.filterVolumes.checked,
      systemFolders: this.elements.filterSystem.checked,
      exclusions: [...this.exclusions]
    };
  }

  bind() {
    const { filterButton, filterPopover } = this.elements;
    filterButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.setOpen(filterPopover.hidden);
    });
    filterPopover.addEventListener('click', (event) => event.stopPropagation());
    for (const input of [
      this.elements.filterCaches,
      this.elements.filterVolumes,
      this.elements.filterSystem
    ]) {
      input.addEventListener('change', () => this.save());
    }
    this.elements.filterExclusionAdd.addEventListener('click', () => this.addExclusion());
    this.elements.filterExclusionInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.addExclusion();
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (!filterPopover.contains(event.target) && event.target !== filterButton) {
        this.setOpen(false);
      }
    });
  }

  setOpen(open) {
    this.elements.filterPopover.hidden = !open;
    this.elements.filterButton.setAttribute('aria-expanded', String(open));
  }

  save() {
    localStorage.setItem(STORAGE_KEYS.scanFilters, JSON.stringify(this.value));
    localStorage.setItem(STORAGE_KEYS.scanExclusions, JSON.stringify(this.exclusions));
  }

  restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.scanFilters) || '{}');
      this.elements.filterCaches.checked = saved.caches === true;
      this.elements.filterVolumes.checked = saved.externalVolumes === true;
      this.elements.filterSystem.checked = saved.systemFolders === true;
      const exclusions = JSON.parse(
        localStorage.getItem(STORAGE_KEYS.scanExclusions) || '[]'
      );
      this.exclusions = Array.isArray(exclusions)
        ? exclusions.filter((path) => typeof path === 'string').slice(0, 100)
        : [];
      this.renderExclusions();
    } catch {
      localStorage.removeItem(STORAGE_KEYS.scanFilters);
      localStorage.removeItem(STORAGE_KEYS.scanExclusions);
      this.exclusions = [];
      this.renderExclusions();
    }
  }

  addExclusion() {
    const path = this.elements.filterExclusionInput.value.trim();
    this.elements.filterExclusionInput.setCustomValidity('');
    if (path && !path.startsWith('/')) {
      this.elements.filterExclusionInput.setCustomValidity('Enter an absolute macOS path');
      this.elements.filterExclusionInput.reportValidity();
      return;
    }
    if (!path || this.exclusions.includes(path)) {
      return;
    }
    this.addPath(path);
    this.elements.filterExclusionInput.value = '';
  }

  addPath(path) {
    if (!path || !path.startsWith('/') || this.exclusions.includes(path)) {
      return false;
    }
    this.exclusions.push(path);
    this.renderExclusions();
    this.save();
    return true;
  }

  removeExclusion(path) {
    this.exclusions = this.exclusions.filter((entry) => entry !== path);
    this.renderExclusions();
    this.save();
  }

  renderExclusions() {
    const fragment = document.createDocumentFragment();
    for (const path of this.exclusions) {
      const item = document.createElement('div');
      item.className = 'exclusion-item';
      const label = document.createElement('span');
      label.textContent = path;
      label.title = path;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = `Remove ${path}`;
      remove.addEventListener('click', () => this.removeExclusion(path));
      item.append(label, remove);
      fragment.appendChild(item);
    }
    this.elements.filterExclusionList.replaceChildren(fragment);
  }
}
