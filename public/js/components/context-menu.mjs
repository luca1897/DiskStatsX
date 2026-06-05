import { findNodeByPath, parentDirectoryPath } from '../core/hierarchy.mjs';

export class ContextMenu {
  constructor({ element, api, getRoot, onAnalyze, onRescan, onMessage }) {
    this.element = element;
    this.api = api;
    this.getRoot = getRoot;
    this.onAnalyze = onAnalyze;
    this.onRescan = onRescan;
    this.onMessage = onMessage;
    this.bindGlobalEvents();
  }

  show(event, target) {
    if (!target?.path || target.path === '__other__') {
      return;
    }
    const root = this.getRoot();
    const node = target.node || findNodeByPath(root, target.path);
    this.element.replaceChildren();

    if (target.type === 'directory') {
      this.element.appendChild(this.createItem('Analyze this folder', () => {
        const directory = node || findNodeByPath(this.getRoot(), target.path);
        if (directory) {
          this.onAnalyze(directory);
        }
      }, !node));
      this.element.appendChild(this.createItem('Rescan this folder', () => this.onRescan(target.path)));
    } else {
      const parentNode = node?.parent || findNodeByPath(root, parentDirectoryPath(target.path));
      this.element.appendChild(this.createItem('Analyze containing folder', () => {
        if (parentNode) {
          this.onAnalyze(parentNode);
        }
      }, !parentNode));
    }

    this.element.appendChild(this.createSeparator());
    this.element.appendChild(this.createItem('Show in Finder', () => this.api.runSystemAction('reveal', target.path)));
    this.element.appendChild(this.createItem('Open', () => this.api.runSystemAction('open', target.path)));
    this.element.appendChild(this.createItem('Copy path', () => this.copyText(target.path)));

    this.element.classList.add('visible');
    this.element.setAttribute('aria-hidden', 'false');
    const left = Math.min(window.innerWidth - this.element.offsetWidth - 8, event.clientX);
    const top = Math.min(window.innerHeight - this.element.offsetHeight - 8, event.clientY);
    this.element.style.left = `${Math.max(8, left)}px`;
    this.element.style.top = `${Math.max(8, top)}px`;
    this.element.querySelector('button:not(:disabled)')?.focus();
  }

  hide() {
    this.element.classList.remove('visible');
    this.element.setAttribute('aria-hidden', 'true');
  }

  createItem(label, action, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'context-menu-item';
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener('click', async () => {
      this.hide();
      try {
        await action();
      } catch (error) {
        this.onMessage(error.message || 'Action failed');
      }
    });
    return button;
  }

  createSeparator() {
    const separator = document.createElement('div');
    separator.className = 'context-menu-separator';
    return separator;
  }

  async copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    this.onMessage('Path copied');
  }

  bindGlobalEvents() {
    this.element.addEventListener('contextmenu', (event) => event.preventDefault());
    document.addEventListener('pointerdown', (event) => {
      if (!this.element.contains(event.target)) {
        this.hide();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.hide();
      }
    });
    window.addEventListener('blur', () => this.hide());
    window.addEventListener('resize', () => this.hide());
  }
}
