import { STORAGE_KEYS } from '../core/config.mjs';

export class FilterController {
  constructor(elements) {
    this.elements = elements;
    this.restore();
    this.bind();
  }

  get value() {
    return {
      caches: this.elements.filterCaches.checked,
      externalVolumes: this.elements.filterVolumes.checked,
      systemFolders: this.elements.filterSystem.checked
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
  }

  restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.scanFilters) || '{}');
      this.elements.filterCaches.checked = saved.caches === true;
      this.elements.filterVolumes.checked = saved.externalVolumes === true;
      this.elements.filterSystem.checked = saved.systemFolders === true;
    } catch {
      localStorage.removeItem(STORAGE_KEYS.scanFilters);
    }
  }
}
