export class ToolsMenuController {
  constructor({ elements, onAction }) {
    this.elements = elements;
    this.onAction = onAction;
    this.bind();
  }

  bind() {
    this.elements.toolsButton.addEventListener('click', () => this.toggle());
    for (const button of this.elements.toolActionButtons) {
      button.addEventListener('click', () => {
        this.hide();
        this.onAction(button.dataset.toolAction);
      });
    }
    document.addEventListener('pointerdown', (event) => {
      if (!this.elements.toolsPopover.contains(event.target) &&
          !this.elements.toolsButton.contains(event.target)) {
        this.hide();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.hide();
      }
    });
  }

  toggle() {
    if (this.elements.toolsPopover.hidden) {
      this.show();
    } else {
      this.hide();
    }
  }

  show() {
    this.elements.toolsPopover.hidden = false;
    this.elements.toolsButton.setAttribute('aria-expanded', 'true');
    this.elements.toolsPopover.querySelector('button')?.focus();
  }

  hide() {
    this.elements.toolsPopover.hidden = true;
    this.elements.toolsButton.setAttribute('aria-expanded', 'false');
  }
}
