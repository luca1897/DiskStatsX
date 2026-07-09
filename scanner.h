#ifndef DISKSTATSX_SCANNER_H
#define DISKSTATSX_SCANNER_H

#include <stdint.h>
#include <stddef.h>

typedef struct ScanStats {
    uint64_t files_scanned;
    uint64_t directories_scanned;
    uint64_t bytes_discovered;
    uint64_t logical_bytes_discovered;
    uint64_t cloud_only_files;
    uint64_t symlinks_skipped;
    uint64_t unreadable_directories;
    uint64_t excluded_directories;
    uint64_t hardlink_duplicates;
    uint64_t hardlink_bytes_saved;
    uint64_t clone_duplicates;
    uint64_t clone_bytes_saved;
    uint64_t shared_block_files;
} ScanStats;

typedef struct ScanOptions {
    int skip_caches;
    int skip_external_volumes;
    int skip_system_folders;
    const char **excluded_paths;
    size_t excluded_path_count;
    const char *database_path;
} ScanOptions;

#endif
