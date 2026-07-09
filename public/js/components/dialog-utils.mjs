export function bindDialogDismissal(dialog, closeButton) {
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });
}

export function openDialog(dialog) {
  if (!dialog.open) {
    dialog.showModal();
  }
}

export function formatDateTime(epochSeconds) {
  const seconds = Number(epochSeconds || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 'Unknown';
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(seconds * 1000));
}

export function formatSignedSize(value, formatSize) {
  const bytes = Number(value || 0);
  if (bytes === 0) {
    return '0 B';
  }
  return `${bytes > 0 ? '+' : '-'}${formatSize(Math.abs(bytes))}`;
}

export function dateToEpochSeconds(value, { endOfDay = false } = {}) {
  if (!value) {
    return 0;
  }
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
  const milliseconds = date.getTime();
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : 0;
}

export function normalizeExtension(value) {
  const extension = String(value || '').trim().toLowerCase();
  if (!extension || extension === '*') {
    return '';
  }
  return extension.startsWith('.') ? extension : `.${extension}`;
}
