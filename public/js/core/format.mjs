const EXTENSION_DESCRIPTIONS = {
  '.app': 'macOS Application',
  '.dmg': 'Apple Disk Image',
  '.pkg': 'Installer Package',
  '.zip': 'Compressed Archive',
  '.tar': 'Archive',
  '.gz': 'Compressed File',
  '.mov': 'QuickTime Movie',
  '.mp4': 'MPEG-4 Video',
  '.mkv': 'Matroska Video',
  '.mp3': 'Audio File',
  '.wav': 'Wave Audio',
  '.jpg': 'JPEG Image',
  '.jpeg': 'JPEG Image',
  '.png': 'PNG Image',
  '.heic': 'HEIC Image',
  '.pdf': 'PDF Document',
  '.js': 'JavaScript File',
  '.json': 'JSON File',
  '.css': 'CSS File',
  '.html': 'HTML File',
  '.c': 'C Source',
  '.h': 'C Header',
  '<none>': 'No Extension',
  '<other>': 'Aggregated Files'
};

export function formatSize(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}

export function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function formatPercent(value) {
  const percent = Number(value || 0);
  return `${percent.toFixed(percent >= 10 ? 1 : 2)}%`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function getExtension(name) {
  const base = String(name || '');
  const index = base.lastIndexOf('.');
  if (index <= 0 || index === base.length - 1) {
    return '<none>';
  }
  return base.slice(index).toLowerCase();
}

export function extensionDescription(extension) {
  return EXTENSION_DESCRIPTIONS[extension] || `${extension.slice(1).toUpperCase()} File`;
}
