const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const ROOT_PATH = '/Demo Disk';

export function createDemoTree() {
  const root = directory('Demo Disk', '/', [
    section('Media', [
      group('Video Masters', 'feature', 34, 3.8 * GIB, ['.mov', '.mp4', '.mkv']),
      group('Motion Graphics', 'sequence', 52, 620 * MIB, ['.mov', '.mp4']),
      group('Audio Library', 'track', 96, 145 * MIB, ['.wav', '.aiff', '.mp3'])
    ]),
    section('Projects', [
      group('Product Alpha', 'build', 58, 420 * MIB, ['.zip', '.dmg', '.map']),
      group('Design System', 'asset', 72, 86 * MIB, ['.psd', '.fig', '.png']),
      group('Source Repositories', 'module', 110, 18 * MIB, ['.js', '.ts', '.json']),
      group('Build Artifacts', 'artifact', 42, 310 * MIB, ['.bin', '.pak', '.zip'])
    ]),
    section('Applications', [
      group('Creative Tools', 'creative-tool', 14, 2.1 * GIB, ['.app']),
      group('Developer Tools', 'developer-tool', 18, 1.35 * GIB, ['.app']),
      group('Productivity', 'productivity-app', 22, 740 * MIB, ['.app'])
    ]),
    section('Photos', [
      group('RAW Library', 'capture', 124, 92 * MIB, ['.raw', '.dng']),
      group('Exports', 'export', 86, 28 * MIB, ['.jpg', '.png', '.heic']),
      group('Catalogs', 'catalog', 24, 190 * MIB, ['.lrcat', '.db'])
    ]),
    section('Archives', [
      group('Quarterly Backups', 'backup', 20, 1.4 * GIB, ['.zip', '.tar']),
      group('Release Images', 'release', 18, 980 * MIB, ['.dmg', '.iso']),
      group('Legacy Projects', 'legacy', 36, 520 * MIB, ['.zip', '.7z'])
    ]),
    section('Documents', [
      group('Presentations', 'presentation', 44, 48 * MIB, ['.pptx', '.key', '.pdf']),
      group('Research', 'research', 68, 24 * MIB, ['.pdf', '.docx', '.pages']),
      group('Spreadsheets', 'workbook', 56, 12 * MIB, ['.xlsx', '.csv'])
    ]),
    section('Downloads', [
      group('Installers', 'installer', 24, 380 * MIB, ['.dmg', '.pkg']),
      group('Incoming Media', 'download', 38, 210 * MIB, ['.mp4', '.zip', '.pdf'])
    ]),
    section('System Data', [
      group('Application Support', 'support', 64, 72 * MIB, ['.db', '.json', '.dat']),
      group('Logs', 'log', 90, 9 * MIB, ['.log', '.txt']),
      group('Temporary Data', 'temporary', 76, 14 * MIB, ['.tmp', '.cache'])
    ])
  ]);

  finalize(root);
  return root;
}

function section(name, groups) {
  return directory(name, ROOT_PATH, groups);
}

function group(name, prefix, count, baseSize, extensions) {
  const parentPath = `${ROOT_PATH}/${sectionNameForGroup(name)}`;
  const children = [];
  for (let index = 0; index < count; index++) {
    const extension = extensions[index % extensions.length];
    const variation = 0.48 + ((index * 37) % 89) / 100;
    const size = Math.max(4096, Math.floor(baseSize * variation / 4096) * 4096);
    const filename = `${prefix}-${String(index + 1).padStart(3, '0')}${extension}`;
    children.push(file(filename, `${parentPath}/${name}`, size));
  }
  return {
    name,
    size: 0,
    type: 'directory',
    children,
    demoGroup: true
  };
}

function directory(name, parentPath, children) {
  const path = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
  for (const child of children) {
    if (child.demoGroup) {
      child.path = `${path}/${child.name}`;
      for (const nested of child.children) {
        nested.path = `${child.path}/${nested.name}`;
      }
      delete child.demoGroup;
    }
  }
  return { name, path, size: 0, type: 'directory', children };
}

function file(name, parentPath, size) {
  return {
    name,
    path: `${parentPath}/${name}`,
    size,
    type: 'file'
  };
}

function sectionNameForGroup(groupName) {
  const sections = {
    'Video Masters': 'Media',
    'Motion Graphics': 'Media',
    'Audio Library': 'Media',
    'Product Alpha': 'Projects',
    'Design System': 'Projects',
    'Source Repositories': 'Projects',
    'Build Artifacts': 'Projects',
    'Creative Tools': 'Applications',
    'Developer Tools': 'Applications',
    Productivity: 'Applications',
    'RAW Library': 'Photos',
    Exports: 'Photos',
    Catalogs: 'Photos',
    'Quarterly Backups': 'Archives',
    'Release Images': 'Archives',
    'Legacy Projects': 'Archives',
    Presentations: 'Documents',
    Research: 'Documents',
    Spreadsheets: 'Documents',
    Installers: 'Downloads',
    'Incoming Media': 'Downloads',
    'Application Support': 'System Data',
    Logs: 'System Data',
    'Temporary Data': 'System Data'
  };
  return sections[groupName];
}

function finalize(node) {
  if (node.type === 'file') {
    return node.size;
  }
  node.size = node.children.reduce((total, child) => total + finalize(child), 0);
  node.children.sort((left, right) => right.size - left.size);
  return node.size;
}
