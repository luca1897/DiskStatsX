import { findNodeByPath, parentDirectoryPath } from '../core/hierarchy.mjs';

export class ContextMenu {
  constructor({
    element,
    api,
    getRoot,
    onAnalyze,
    onAnalyzePath,
    onRescan,
    onExclude,
    onToggleReview,
    isReviewed,
    onMessage
  }) {
    this.element = element;
    this.api = api;
    this.getRoot = getRoot;
    this.onAnalyze = onAnalyze;
    this.onAnalyzePath = onAnalyzePath;
    this.onRescan = onRescan;
    this.onExclude = onExclude;
    this.onToggleReview = onToggleReview;
    this.isReviewed = isReviewed;
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
      this.element.appendChild(this.createItem('Explore this folder', () => {
        const directory = node || findNodeByPath(this.getRoot(), target.path);
        if (directory) {
          this.onAnalyze(directory);
        } else {
          this.onAnalyzePath(target.path);
        }
      }, false, 'Open this folder from the active scan without reading the disk again.'));
      this.element.appendChild(this.createItem(
        'Scan this folder',
        () => this.onRescan(target.path),
        false,
        'Start a new native scan with this folder as the root.'
      ));
      this.element.appendChild(this.createItem(
        'Always exclude this folder',
        () => this.onExclude(target.path)
      ));
    } else {
      const parentNode = node?.parent || findNodeByPath(root, parentDirectoryPath(target.path));
      this.element.appendChild(this.createItem('Explore containing folder', () => {
        if (parentNode) {
          this.onAnalyze(parentNode);
        } else {
          this.onAnalyzePath(parentDirectoryPath(target.path));
        }
      }));
    }

    this.element.appendChild(this.createSeparator());
    this.element.appendChild(this.createItem(
      this.isReviewed(target.path) ? 'Remove from Review' : 'Add to Review',
      () => this.onToggleReview({
        ...target,
        size: Number(target.size || node?.value || 0),
        logicalSize: Number(target.logicalSize || node?.data.logicalSize || 0)
      })
    ));
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

  createItem(label, action, disabled = false, title = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'context-menu-item';
    button.textContent = label;
    button.disabled = disabled;
    if (title) {
      button.title = title;
    }
    button.addEventListener('click', async () => {
      this.hide();
      try {
        await action();
      } catch (error) {
        this.onMessage(error.message || 'Action failed', { error: true });
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
