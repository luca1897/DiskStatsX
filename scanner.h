#ifndef DISKSTATSX_SCANNER_H
#define DISKSTATSX_SCANNER_H

#include <stdint.h>
#include <stddef.h>

typedef enum NodeType {
    NODE_FILE = 1,
    NODE_DIRECTORY = 2
} NodeType;

typedef struct Node {
    char *name;
    uint64_t size;
    uint64_t direct_file_size;
    uint64_t file_count;
    uint64_t directory_count;
    NodeType type;
    int cloud_only;
    struct Node **children;
    size_t child_count;
    size_t child_capacity;
} Node;

typedef struct ScanStats {
    uint64_t files_scanned;
    uint64_t directories_scanned;
    uint64_t bytes_discovered;
} ScanStats;

typedef struct ScanOptions {
    int skip_caches;
    int skip_external_volumes;
    int skip_system_folders;
    const char *database_path;
} ScanOptions;

#endif
