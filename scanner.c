#define _DARWIN_C_SOURCE

#include "scanner.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/attr.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/vnode.h>
#include <time.h>
#include <unistd.h>

#ifndef O_DIRECTORY
#define O_DIRECTORY 0
#endif

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#define ATTR_BUFFER_SIZE (1024 * 1024)
#define PROGRESS_INTERVAL_MS 250
#define QUERY_DIRECTORY_LIMIT 10000
#define QUERY_FILE_LIMIT 500
#define QUERY_EXPANDED_DIRECTORY_LIMIT 24
#define QUERY_SECOND_LEVEL_DIRECTORY_LIMIT 32
#define QUERY_SECOND_LEVEL_FILE_LIMIT 48

typedef struct EntryAttrs {
    const char *name;
    fsobj_type_t type;
    uint32_t error;
    uint32_t flags;
    int64_t modified_at;
    dev_t device_id;
    uint64_t file_id;
    uint32_t link_count;
    uint64_t total_size;
    uint64_t alloc_size;
    uint64_t data_length;
    uint64_t data_alloc_size;
    uint64_t clone_id;
    uint64_t extended_flags;
    uint32_t clone_refcount;
} EntryAttrs;

typedef struct IdentityEntry {
    uint64_t first;
    uint64_t second;
    bool occupied;
} IdentityEntry;

typedef struct IdentitySet {
    IdentityEntry *entries;
    size_t count;
    size_t capacity;
} IdentitySet;

typedef struct PendingDir {
    sqlite3_int64 id;
    sqlite3_int64 root_branch_id;
    char *path;
} PendingDir;

typedef struct PendingDirList {
    PendingDir *items;
    size_t count;
    size_t capacity;
} PendingDirList;

typedef struct DirectoryAggregate {
    uint64_t size;
    uint64_t logical_size;
    uint64_t direct_file_size;
    uint64_t file_count;
    uint64_t directory_count;
    uint64_t direct_file_count;
    uint64_t direct_directory_count;
} DirectoryAggregate;

typedef struct ScanDatabase {
    sqlite3 *handle;
    sqlite3_stmt *insert_directory;
    sqlite3_stmt *update_directory;
    sqlite3_stmt *insert_file;
    sqlite3_stmt *insert_metadata;
} ScanDatabase;

typedef struct SearchOptions {
    const char *term;
    const char *extension;
    uint64_t min_size;
    uint64_t max_size;
    int64_t modified_after;
    int64_t modified_before;
    bool cloud_only;
    bool shared_blocks;
    int limit;
} SearchOptions;

typedef struct SnapshotTotals {
    uint64_t allocated_bytes;
    uint64_t logical_bytes;
    uint64_t file_count;
    uint64_t directory_count;
} SnapshotTotals;

typedef struct DirectoryRow {
    sqlite3_int64 id;
    sqlite3_int64 parent_id;
    char *name;
    char *path;
    uint64_t size;
    uint64_t logical_size;
    uint64_t direct_file_size;
    uint64_t file_count;
    uint64_t directory_count;
    uint64_t direct_file_count;
    uint64_t direct_directory_count;
    bool has_parent;
} DirectoryRow;

typedef struct DirectoryRowList {
    DirectoryRow *items;
    size_t count;
    size_t capacity;
} DirectoryRowList;

static ScanStats g_stats = {0};
static uint64_t g_last_progress_ms = 0;
static IdentitySet g_hardlinks = {0};
static IdentitySet g_clones = {0};

static void *xcalloc(size_t count, size_t size);

static uint64_t mix_u64(uint64_t value) {
    value ^= value >> 30;
    value *= UINT64_C(0xbf58476d1ce4e5b9);
    value ^= value >> 27;
    value *= UINT64_C(0x94d049bb133111eb);
    return value ^ (value >> 31);
}

static size_t identity_index(uint64_t first, uint64_t second, size_t capacity) {
    return (size_t)(mix_u64(first) ^ mix_u64(second + UINT64_C(0x9e3779b97f4a7c15))) &
        (capacity - 1);
}

static void identity_set_resize(IdentitySet *set, size_t capacity) {
    IdentityEntry *old_entries = set->entries;
    size_t old_capacity = set->capacity;
    set->entries = xcalloc(capacity, sizeof(IdentityEntry));
    set->capacity = capacity;
    set->count = 0;
    for (size_t i = 0; i < old_capacity; i++) {
        if (!old_entries[i].occupied) {
            continue;
        }
        size_t index = identity_index(old_entries[i].first,
                                      old_entries[i].second,
                                      capacity);
        while (set->entries[index].occupied) {
            index = (index + 1) & (capacity - 1);
        }
        set->entries[index] = old_entries[i];
        set->count++;
    }
    free(old_entries);
}

static bool identity_set_seen(IdentitySet *set, uint64_t first, uint64_t second) {
    if (set->capacity == 0) {
        identity_set_resize(set, 1024);
    } else if ((set->count + 1) * 10 >= set->capacity * 7) {
        identity_set_resize(set, set->capacity * 2);
    }
    size_t index = identity_index(first, second, set->capacity);
    while (set->entries[index].occupied) {
        if (set->entries[index].first == first &&
            set->entries[index].second == second) {
            return true;
        }
        index = (index + 1) & (set->capacity - 1);
    }
    set->entries[index] = (IdentityEntry){
        .first = first,
        .second = second,
        .occupied = true
    };
    set->count++;
    return false;
}

static void identity_set_free(IdentitySet *set) {
    free(set->entries);
    memset(set, 0, sizeof(*set));
}

static uint64_t now_ms(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return ((uint64_t)tv.tv_sec * 1000ULL) + ((uint64_t)tv.tv_usec / 1000ULL);
}

static void die(const char *message) {
    fprintf(stderr, "{\"error\":\"");
    for (const char *p = message; *p; p++) {
        if (*p == '"' || *p == '\\') {
            fputc('\\', stderr);
        }
        fputc(*p, stderr);
    }
    fprintf(stderr, "\"}\n");
    exit(1);
}

static void *xcalloc(size_t count, size_t size) {
    void *ptr = calloc(count, size);
    if (!ptr) {
        die("out of memory");
    }
    return ptr;
}

static void *xrealloc(void *ptr, size_t size) {
    void *next = realloc(ptr, size);
    if (!next) {
        die("out of memory");
    }
    return next;
}

static char *xstrdup(const char *s) {
    char *copy = strdup(s);
    if (!copy) {
        die("out of memory");
    }
    return copy;
}

static uint32_t read_u32(const char *p) {
    uint32_t value;
    memcpy(&value, p, sizeof(value));
    return value;
}

static uint64_t read_u64(const char *p) {
    uint64_t value;
    memcpy(&value, p, sizeof(value));
    return value;
}

static fsobj_type_t read_obj_type(const char *p) {
    fsobj_type_t value;
    memcpy(&value, p, sizeof(value));
    return value;
}

static attribute_set_t read_attr_set(const char *p) {
    attribute_set_t value;
    memcpy(&value, p, sizeof(value));
    return value;
}

static attrreference_t read_attr_ref(const char *p) {
    attrreference_t value;
    memcpy(&value, p, sizeof(value));
    return value;
}

static void pending_dir_add(PendingDirList *list,
                            sqlite3_int64 id,
                            sqlite3_int64 root_branch_id,
                            char *path) {
    if (list->count == list->capacity) {
        size_t next_capacity = list->capacity == 0 ? 16 : list->capacity * 2;
        list->items = xrealloc(list->items, next_capacity * sizeof(PendingDir));
        list->capacity = next_capacity;
    }
    list->items[list->count].id = id;
    list->items[list->count].root_branch_id = root_branch_id;
    list->items[list->count].path = path;
    list->count++;
}

static char *normalize_root_path(const char *path) {
    if (!path || !*path) {
        die("path is required");
    }

    size_t len = strlen(path);
    while (len > 1 && path[len - 1] == '/') {
        len--;
    }

    char *normalized = xcalloc(len + 1, 1);
    memcpy(normalized, path, len);
    normalized[len] = '\0';
    return normalized;
}

static const char *root_display_name(const char *path) {
    if (strcmp(path, "/") == 0) {
        return "/";
    }
    const char *slash = strrchr(path, '/');
    if (!slash || !slash[1]) {
        return path;
    }
    return slash + 1;
}

static char *join_path(const char *parent, const char *name) {
    if (strcmp(parent, "/") == 0) {
        size_t len = strlen(name) + 2;
        char *path = xcalloc(len, 1);
        snprintf(path, len, "/%s", name);
        return path;
    }

    size_t parent_len = strlen(parent);
    size_t name_len = strlen(name);
    char *path = xcalloc(parent_len + name_len + 2, 1);
    memcpy(path, parent, parent_len);
    path[parent_len] = '/';
    memcpy(path + parent_len + 1, name, name_len);
    path[parent_len + name_len + 1] = '\0';
    return path;
}

static bool is_system_root_path(const char *path) {
    static const char *system_paths[] = {
        "/System",
        "/private",
        "/usr",
        "/bin",
        "/sbin",
        "/dev",
        "/cores"
    };
    for (size_t i = 0; i < sizeof(system_paths) / sizeof(system_paths[0]); i++) {
        if (strcmp(path, system_paths[i]) == 0) {
            return true;
        }
    }
    return false;
}

static bool should_skip_directory(const char *root_path, const char *child_path, const char *name, const ScanOptions *options) {
    if (options->skip_caches &&
        (strcmp(name, "Caches") == 0 || strcmp(name, "Cache") == 0 || strcmp(name, ".cache") == 0)) {
        return true;
    }
    if (options->skip_external_volumes && strcmp(root_path, "/") == 0 && strcmp(child_path, "/Volumes") == 0) {
        return true;
    }
    if (options->skip_system_folders && strcmp(root_path, "/") == 0 && is_system_root_path(child_path)) {
        return true;
    }
    for (size_t i = 0; i < options->excluded_path_count; i++) {
        const char *excluded = options->excluded_paths[i];
        size_t length = strlen(excluded);
        if (strcmp(child_path, excluded) == 0 ||
            (strncmp(child_path, excluded, length) == 0 && child_path[length] == '/')) {
            return true;
        }
    }
    return false;
}

static void json_write_escaped(FILE *out, const char *s) {
    fputc('"', out);
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        switch (*p) {
            case '"':
                fputs("\\\"", out);
                break;
            case '\\':
                fputs("\\\\", out);
                break;
            case '\b':
                fputs("\\b", out);
                break;
            case '\f':
                fputs("\\f", out);
                break;
            case '\n':
                fputs("\\n", out);
                break;
            case '\r':
                fputs("\\r", out);
                break;
            case '\t':
                fputs("\\t", out);
                break;
            default:
                if (*p < 0x20) {
                    fprintf(out, "\\u%04x", *p);
                } else {
                    fputc(*p, out);
                }
                break;
        }
    }
    fputc('"', out);
}

static void emit_progress(const char *current_path, bool force) {
    uint64_t current_ms = now_ms();
    if (!force && current_ms - g_last_progress_ms < PROGRESS_INTERVAL_MS) {
        return;
    }
    g_last_progress_ms = current_ms;

    fputs("{\"currentPath\":", stderr);
    json_write_escaped(stderr, current_path);
    fprintf(stderr,
            ",\"filesScanned\":%llu,\"directoriesScanned\":%llu,"
            "\"bytesDiscovered\":%llu,\"logicalBytesDiscovered\":%llu,"
            "\"cloudOnlyFiles\":%llu,\"symlinksSkipped\":%llu,"
            "\"unreadableDirectories\":%llu,\"excludedDirectories\":%llu,"
            "\"hardlinkDuplicates\":%llu,\"hardlinkBytesSaved\":%llu,"
            "\"cloneDuplicates\":%llu,\"cloneBytesSaved\":%llu,"
            "\"sharedBlockFiles\":%llu}\n",
            (unsigned long long)g_stats.files_scanned,
            (unsigned long long)g_stats.directories_scanned,
            (unsigned long long)g_stats.bytes_discovered,
            (unsigned long long)g_stats.logical_bytes_discovered,
            (unsigned long long)g_stats.cloud_only_files,
            (unsigned long long)g_stats.symlinks_skipped,
            (unsigned long long)g_stats.unreadable_directories,
            (unsigned long long)g_stats.excluded_directories,
            (unsigned long long)g_stats.hardlink_duplicates,
            (unsigned long long)g_stats.hardlink_bytes_saved,
            (unsigned long long)g_stats.clone_duplicates,
            (unsigned long long)g_stats.clone_bytes_saved,
            (unsigned long long)g_stats.shared_block_files);
    fflush(stderr);
}

static uint64_t entry_size_bytes(const EntryAttrs *attrs) {
    if ((attrs->flags & SF_DATALESS) != 0) {
        return 0;
    }
    if (attrs->alloc_size > 0) {
        return attrs->alloc_size;
    }
    if (attrs->data_alloc_size > 0) {
        return attrs->data_alloc_size;
    }
    return 0;
}

static EntryAttrs parse_entry_attrs(char *entry) {
    EntryAttrs attrs;
    memset(&attrs, 0, sizeof(attrs));

    char *field = entry + sizeof(uint32_t);

    attribute_set_t returned = read_attr_set(field);
    field += sizeof(attribute_set_t);

    if (returned.commonattr & ATTR_CMN_ERROR) {
        attrs.error = read_u32(field);
        field += sizeof(uint32_t);
    }

    if (returned.commonattr & ATTR_CMN_NAME) {
        attrreference_t name_ref = read_attr_ref(field);
        attrs.name = field + name_ref.attr_dataoffset;
        field += sizeof(attrreference_t);
    }

    if (returned.commonattr & ATTR_CMN_DEVID) {
        memcpy(&attrs.device_id, field, sizeof(dev_t));
        field += sizeof(dev_t);
    }

    if (returned.commonattr & ATTR_CMN_OBJTYPE) {
        attrs.type = read_obj_type(field);
        field += sizeof(fsobj_type_t);
    }

    if (returned.commonattr & ATTR_CMN_MODTIME) {
        struct timespec modified_at;
        memcpy(&modified_at, field, sizeof(modified_at));
        attrs.modified_at = (int64_t)modified_at.tv_sec;
        field += sizeof(modified_at);
    }

    if (returned.commonattr & ATTR_CMN_FLAGS) {
        attrs.flags = read_u32(field);
        field += sizeof(uint32_t);
    }

    if (returned.commonattr & ATTR_CMN_FILEID) {
        attrs.file_id = read_u64(field);
        field += sizeof(uint64_t);
    }

    if (returned.fileattr & ATTR_FILE_LINKCOUNT) {
        attrs.link_count = read_u32(field);
        field += sizeof(uint32_t);
    }

    if (returned.fileattr & ATTR_FILE_TOTALSIZE) {
        attrs.total_size = read_u64(field);
        field += sizeof(uint64_t);
    }

    if (returned.fileattr & ATTR_FILE_ALLOCSIZE) {
        attrs.alloc_size = read_u64(field);
        field += sizeof(uint64_t);
    }

    if (returned.fileattr & ATTR_FILE_DATALENGTH) {
        attrs.data_length = read_u64(field);
        field += sizeof(uint64_t);
    }

    if (returned.fileattr & ATTR_FILE_DATAALLOCSIZE) {
        attrs.data_alloc_size = read_u64(field);
        field += sizeof(uint64_t);
    }

    if (returned.forkattr & ATTR_CMNEXT_CLONEID) {
        attrs.clone_id = read_u64(field);
        field += sizeof(uint64_t);
    }

    if (returned.forkattr & ATTR_CMNEXT_EXT_FLAGS) {
        attrs.extended_flags = read_u64(field);
        field += sizeof(uint64_t);
    }

    if (returned.forkattr & ATTR_CMNEXT_CLONE_REFCNT) {
        attrs.clone_refcount = read_u32(field);
    }

    return attrs;
}

static sqlite3_int64 database_insert_directory(ScanDatabase *database,
                                               sqlite3_int64 parent_id,
                                               bool has_parent,
                                               const char *name,
                                               const char *path,
                                               int64_t modified_at);
static void database_update_directory(ScanDatabase *database,
                                      sqlite3_int64 id,
                                      const DirectoryAggregate *aggregate);
static void database_insert_file(ScanDatabase *database,
                                 sqlite3_int64 parent_id,
                                 sqlite3_int64 root_branch_id,
                                 const char *name,
                                 const char *path,
                                 uint64_t size,
                                 uint64_t logical_size,
                                 uint64_t allocated_size,
                                 bool cloud_only,
                                 bool hardlink_duplicate,
                                 bool clone_duplicate,
                                 bool shared_blocks,
                                 uint32_t clone_refcount,
                                 int64_t modified_at);

static DirectoryAggregate scan_directory_fd(ScanDatabase *database,
                                            sqlite3_int64 directory_id,
                                            sqlite3_int64 root_directory_id,
                                            sqlite3_int64 root_branch_id,
                                            const char *root_path,
                                            const char *dir_path,
                                            int dir_fd,
                                            char *attr_buffer,
                                            size_t attr_buffer_size,
                                            const ScanOptions *options) {
    struct attrlist attr_list;
    memset(&attr_list, 0, sizeof(attr_list));
    attr_list.bitmapcount = ATTR_BIT_MAP_COUNT;
    attr_list.commonattr = ATTR_CMN_RETURNED_ATTRS |
                           ATTR_CMN_ERROR |
                           ATTR_CMN_NAME |
                           ATTR_CMN_DEVID |
                           ATTR_CMN_OBJTYPE |
                           ATTR_CMN_MODTIME |
                           ATTR_CMN_FLAGS |
                           ATTR_CMN_FILEID;
    attr_list.fileattr = ATTR_FILE_LINKCOUNT |
                         ATTR_FILE_TOTALSIZE |
                         ATTR_FILE_ALLOCSIZE |
                         ATTR_FILE_DATALENGTH |
                         ATTR_FILE_DATAALLOCSIZE;
    attr_list.forkattr = ATTR_CMNEXT_CLONEID |
                         ATTR_CMNEXT_EXT_FLAGS |
                         ATTR_CMNEXT_CLONE_REFCNT;

    g_stats.directories_scanned++;
    emit_progress(dir_path, false);

    DirectoryAggregate aggregate = {0};

    for (;;) {
        int count = getattrlistbulk(dir_fd,
                                    &attr_list,
                                    attr_buffer,
                                    attr_buffer_size,
                                    FSOPT_ATTR_CMN_EXTENDED);
        if (count == 0) {
            break;
        }
        if (count < 0) {
            if (errno == EACCES || errno == EPERM || errno == ENOENT || errno == ESTALE) {
                if (errno == EACCES || errno == EPERM) {
                    g_stats.unreadable_directories++;
                }
                break;
            }
            break;
        }

        PendingDirList pending_dirs = {0};
        char *entry = attr_buffer;
        for (int i = 0; i < count; i++) {
            uint32_t entry_length = read_u32(entry);
            if (entry_length == 0) {
                break;
            }

            EntryAttrs attrs = parse_entry_attrs(entry);
            entry += entry_length;

            if (attrs.error != 0) {
                if (attrs.error == EACCES || attrs.error == EPERM) {
                    g_stats.unreadable_directories++;
                }
                continue;
            }
            if (!attrs.name || attrs.name[0] == '\0') {
                continue;
            }
            if (strcmp(attrs.name, ".") == 0 || strcmp(attrs.name, "..") == 0) {
                continue;
            }
            if (attrs.type == VLNK) {
                g_stats.symlinks_skipped++;
                continue;
            }

            if (attrs.type == VREG) {
                uint64_t allocated_size = entry_size_bytes(&attrs);
                uint64_t logical_size = attrs.total_size > 0
                    ? attrs.total_size
                    : attrs.data_length;
                bool hardlink_duplicate = attrs.link_count > 1 &&
                    attrs.file_id > 0 &&
                    identity_set_seen(&g_hardlinks,
                                      (uint64_t)attrs.device_id,
                                      attrs.file_id);
                bool full_clone = attrs.clone_id > 0 &&
                    (attrs.extended_flags & EF_SHARES_ALL_BLOCKS) != 0;
                bool clone_duplicate = !hardlink_duplicate &&
                    full_clone &&
                    identity_set_seen(&g_clones,
                                      (uint64_t)attrs.device_id,
                                      attrs.clone_id);
                uint64_t attributed_size = hardlink_duplicate || clone_duplicate
                    ? 0
                    : allocated_size;
                bool cloud_only = (attrs.flags & SF_DATALESS) != 0;
                bool shared_blocks =
                    (attrs.extended_flags & EF_MAY_SHARE_BLOCKS) != 0;
                char *file_path = join_path(dir_path, attrs.name);
                database_insert_file(database,
                                     directory_id,
                                     root_branch_id,
                                     attrs.name,
                                     file_path,
                                     attributed_size,
                                     logical_size,
                                     allocated_size,
                                     cloud_only,
                                     hardlink_duplicate,
                                     clone_duplicate,
                                     shared_blocks,
                                     attrs.clone_refcount,
                                     attrs.modified_at);
                free(file_path);
                aggregate.size += attributed_size;
                aggregate.logical_size += logical_size;
                aggregate.direct_file_size += attributed_size;
                aggregate.file_count++;
                aggregate.direct_file_count++;
                g_stats.files_scanned++;
                g_stats.bytes_discovered += attributed_size;
                g_stats.logical_bytes_discovered += logical_size;
                g_stats.cloud_only_files += cloud_only ? 1 : 0;
                g_stats.shared_block_files += shared_blocks ? 1 : 0;
                if (hardlink_duplicate) {
                    g_stats.hardlink_duplicates++;
                    g_stats.hardlink_bytes_saved += allocated_size;
                }
                if (clone_duplicate) {
                    g_stats.clone_duplicates++;
                    g_stats.clone_bytes_saved += allocated_size;
                }
                emit_progress(dir_path, false);
            } else if (attrs.type == VDIR) {
                char *child_path = join_path(dir_path, attrs.name);
                if (should_skip_directory(root_path, child_path, attrs.name, options)) {
                    g_stats.excluded_directories++;
                    free(child_path);
                    continue;
                }
                sqlite3_int64 child_id = database_insert_directory(database,
                                                                    directory_id,
                                                                    true,
                                                                    attrs.name,
                                                                    child_path,
                                                                    attrs.modified_at);
                sqlite3_int64 child_root_branch_id = directory_id == root_directory_id
                    ? child_id
                    : root_branch_id;
                aggregate.direct_directory_count++;
                pending_dir_add(&pending_dirs,
                                child_id,
                                child_root_branch_id,
                                child_path);
                emit_progress(dir_path, false);
            }
        }

        for (size_t i = 0; i < pending_dirs.count; i++) {
            DirectoryAggregate child_aggregate = {0};
            int child_fd = open(pending_dirs.items[i].path,
                                O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
                                0);
            if (child_fd >= 0) {
                child_aggregate = scan_directory_fd(database,
                                                    pending_dirs.items[i].id,
                                                    root_directory_id,
                                                    pending_dirs.items[i].root_branch_id,
                                                    root_path,
                                                    pending_dirs.items[i].path,
                                                    child_fd,
                                                    attr_buffer,
                                                    attr_buffer_size,
                                                    options);
                close(child_fd);
            } else if (errno == EACCES || errno == EPERM) {
                g_stats.unreadable_directories++;
            }
            database_update_directory(database,
                                      pending_dirs.items[i].id,
                                      &child_aggregate);
            aggregate.size += child_aggregate.size;
            aggregate.logical_size += child_aggregate.logical_size;
            aggregate.file_count += child_aggregate.file_count;
            aggregate.directory_count += child_aggregate.directory_count + 1;
            free(pending_dirs.items[i].path);
        }
        free(pending_dirs.items);
    }
    return aggregate;
}

static void sqlite_fail(sqlite3 *database, const char *context) {
    char message[1024];
    snprintf(message,
             sizeof(message),
             "%s: %s",
             context,
             database ? sqlite3_errmsg(database) : "SQLite error");
    if (database) {
        sqlite3_close(database);
    }
    die(message);
}

static void sqlite_exec_checked(sqlite3 *database, const char *sql, const char *context) {
    char *error = NULL;
    if (sqlite3_exec(database, sql, NULL, NULL, &error) != SQLITE_OK) {
        char message[1024];
        snprintf(message, sizeof(message), "%s: %s", context, error ? error : sqlite3_errmsg(database));
        sqlite3_free(error);
        sqlite3_close(database);
        die(message);
    }
}

static sqlite3_int64 database_insert_directory(ScanDatabase *database,
                                               sqlite3_int64 parent_id,
                                               bool has_parent,
                                               const char *name,
                                               const char *path,
                                               int64_t modified_at) {
    sqlite3_reset(database->insert_directory);
    sqlite3_clear_bindings(database->insert_directory);
    if (has_parent) {
        sqlite3_bind_int64(database->insert_directory, 1, parent_id);
    } else {
        sqlite3_bind_null(database->insert_directory, 1);
    }
    sqlite3_bind_text(database->insert_directory, 2, name, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(database->insert_directory, 3, path, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(database->insert_directory, 4, modified_at);
    if (sqlite3_step(database->insert_directory) != SQLITE_DONE) {
        sqlite_fail(database->handle, "could not index directory");
    }
    return sqlite3_last_insert_rowid(database->handle);
}

static void database_update_directory(ScanDatabase *database,
                                      sqlite3_int64 id,
                                      const DirectoryAggregate *aggregate) {
    sqlite3_reset(database->update_directory);
    sqlite3_clear_bindings(database->update_directory);
    sqlite3_bind_int64(database->update_directory, 1, (sqlite3_int64)aggregate->size);
    sqlite3_bind_int64(database->update_directory, 2, (sqlite3_int64)aggregate->logical_size);
    sqlite3_bind_int64(database->update_directory, 3, (sqlite3_int64)aggregate->direct_file_size);
    sqlite3_bind_int64(database->update_directory, 4, (sqlite3_int64)aggregate->file_count);
    sqlite3_bind_int64(database->update_directory, 5, (sqlite3_int64)aggregate->directory_count);
    sqlite3_bind_int64(database->update_directory, 6, (sqlite3_int64)aggregate->direct_file_count);
    sqlite3_bind_int64(database->update_directory, 7, (sqlite3_int64)aggregate->direct_directory_count);
    sqlite3_bind_int64(database->update_directory, 8, id);
    if (sqlite3_step(database->update_directory) != SQLITE_DONE) {
        sqlite_fail(database->handle, "could not aggregate directory");
    }
}

static void database_insert_file(ScanDatabase *database,
                                 sqlite3_int64 parent_id,
                                 sqlite3_int64 root_branch_id,
                                 const char *name,
                                 const char *path,
                                 uint64_t size,
                                 uint64_t logical_size,
                                 uint64_t allocated_size,
                                 bool cloud_only,
                                 bool hardlink_duplicate,
                                 bool clone_duplicate,
                                 bool shared_blocks,
                                 uint32_t clone_refcount,
                                 int64_t modified_at) {
    sqlite3_reset(database->insert_file);
    sqlite3_clear_bindings(database->insert_file);
    sqlite3_bind_int64(database->insert_file, 1, parent_id);
    sqlite3_bind_text(database->insert_file, 2, name, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(database->insert_file, 3, path, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(database->insert_file, 4, modified_at);
    sqlite3_bind_int64(database->insert_file, 5, (sqlite3_int64)size);
    sqlite3_bind_int64(database->insert_file, 6, (sqlite3_int64)logical_size);
    sqlite3_bind_int64(database->insert_file, 7, (sqlite3_int64)allocated_size);
    sqlite3_bind_int(database->insert_file, 8, cloud_only);
    sqlite3_bind_int(database->insert_file, 9, hardlink_duplicate);
    sqlite3_bind_int(database->insert_file, 10, clone_duplicate);
    sqlite3_bind_int(database->insert_file, 11, shared_blocks);
    sqlite3_bind_int(database->insert_file, 12, (int)clone_refcount);
    if (root_branch_id > 0) {
        sqlite3_bind_int64(database->insert_file, 13, root_branch_id);
    } else {
        sqlite3_bind_null(database->insert_file, 13);
    }
    if (sqlite3_step(database->insert_file) != SQLITE_DONE) {
        sqlite_fail(database->handle, "could not index file");
    }
}

static DirectoryAggregate write_scan_database(const char *database_path,
                                              const char *root_path,
                                              int root_fd,
                                              char *attr_buffer,
                                              size_t attr_buffer_size,
                                              const ScanOptions *options) {
    ScanDatabase database = {0};

    unlink(database_path);
    if (sqlite3_open_v2(database_path,
                        &database.handle,
                        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE,
                        NULL) != SQLITE_OK) {
        sqlite_fail(database.handle, "could not create scan database");
    }

    sqlite_exec_checked(database.handle,
                        "PRAGMA journal_mode=OFF;"
                        "PRAGMA synchronous=OFF;"
                        "PRAGMA temp_store=FILE;"
                        "PRAGMA cache_size=-65536;"
                        "PRAGMA locking_mode=EXCLUSIVE;"
                        "CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);"
                        "CREATE TABLE scan_summary("
                        "allocated_bytes INTEGER NOT NULL,"
                        "logical_bytes INTEGER NOT NULL,"
                        "cloud_only_files INTEGER NOT NULL,"
                        "symlinks_skipped INTEGER NOT NULL,"
                        "unreadable_directories INTEGER NOT NULL,"
                        "excluded_directories INTEGER NOT NULL,"
                        "hardlink_duplicates INTEGER NOT NULL,"
                        "hardlink_bytes_saved INTEGER NOT NULL,"
                        "clone_duplicates INTEGER NOT NULL,"
                        "clone_bytes_saved INTEGER NOT NULL,"
                        "shared_block_files INTEGER NOT NULL"
                        ");"
                        "CREATE TABLE directories("
                        "id INTEGER PRIMARY KEY,"
                        "parent_id INTEGER,"
                        "name TEXT NOT NULL,"
                        "path TEXT NOT NULL,"
                        "modified_at INTEGER NOT NULL DEFAULT 0,"
                        "size INTEGER NOT NULL,"
                        "logical_size INTEGER NOT NULL,"
                        "direct_file_size INTEGER NOT NULL,"
                        "file_count INTEGER NOT NULL,"
                        "directory_count INTEGER NOT NULL,"
                        "direct_file_count INTEGER NOT NULL,"
                        "direct_directory_count INTEGER NOT NULL"
                        ");"
                        "CREATE TABLE files("
                        "id INTEGER PRIMARY KEY,"
                        "parent_id INTEGER NOT NULL,"
                        "name TEXT NOT NULL,"
                        "path TEXT NOT NULL,"
                        "modified_at INTEGER NOT NULL DEFAULT 0,"
                        "size INTEGER NOT NULL,"
                        "logical_size INTEGER NOT NULL,"
                        "allocated_size INTEGER NOT NULL,"
                        "cloud_only INTEGER NOT NULL DEFAULT 0,"
                        "hardlink_duplicate INTEGER NOT NULL DEFAULT 0,"
                        "clone_duplicate INTEGER NOT NULL DEFAULT 0,"
                        "shared_blocks INTEGER NOT NULL DEFAULT 0,"
                        "clone_refcount INTEGER NOT NULL DEFAULT 0,"
                        "root_branch_id INTEGER"
                        ");"
                        "BEGIN IMMEDIATE;",
                        "could not initialize scan database");

    const char *directory_sql =
        "INSERT INTO directories("
        "parent_id,name,path,modified_at,size,logical_size,direct_file_size,file_count,directory_count,"
        "direct_file_count,direct_directory_count"
        ") VALUES(?,?,?,?,0,0,0,0,0,0,0)";
    const char *directory_update_sql =
        "UPDATE directories SET size=?,logical_size=?,direct_file_size=?,file_count=?,"
        "directory_count=?,direct_file_count=?,direct_directory_count=? WHERE id=?";
    const char *file_sql =
        "INSERT INTO files("
        "parent_id,name,path,modified_at,size,logical_size,allocated_size,cloud_only,"
        "hardlink_duplicate,clone_duplicate,shared_blocks,clone_refcount,root_branch_id"
        ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)";
    const char *metadata_sql = "INSERT INTO metadata(key,value) VALUES(?,?)";
    if (sqlite3_prepare_v2(database.handle,
                           directory_sql,
                           -1,
                           &database.insert_directory,
                           NULL) != SQLITE_OK ||
        sqlite3_prepare_v2(database.handle,
                           directory_update_sql,
                           -1,
                           &database.update_directory,
                           NULL) != SQLITE_OK ||
        sqlite3_prepare_v2(database.handle,
                           file_sql,
                           -1,
                           &database.insert_file,
                           NULL) != SQLITE_OK ||
        sqlite3_prepare_v2(database.handle,
                           metadata_sql,
                           -1,
                           &database.insert_metadata,
                           NULL) != SQLITE_OK) {
        sqlite_fail(database.handle, "could not prepare scan database");
    }

    sqlite3_int64 root_id = database_insert_directory(&database,
                                                       0,
                                                       false,
                                                       root_display_name(root_path),
                                                       root_path,
                                                       0);
    DirectoryAggregate root = scan_directory_fd(&database,
                                                root_id,
                                                root_id,
                                                0,
                                                root_path,
                                                root_path,
                                                root_fd,
                                                attr_buffer,
                                                attr_buffer_size,
                                                options);
    database_update_directory(&database, root_id, &root);

    const char *metadata[][2] = {
        {"schema_version", "6"},
        {"root_path", root_path}
    };
    for (size_t i = 0; i < sizeof(metadata) / sizeof(metadata[0]); i++) {
        sqlite3_reset(database.insert_metadata);
        sqlite3_clear_bindings(database.insert_metadata);
        sqlite3_bind_text(database.insert_metadata, 1, metadata[i][0], -1, SQLITE_STATIC);
        sqlite3_bind_text(database.insert_metadata, 2, metadata[i][1], -1, SQLITE_TRANSIENT);
        if (sqlite3_step(database.insert_metadata) != SQLITE_DONE) {
            sqlite_fail(database.handle, "could not write scan metadata");
        }
    }
    sqlite3_stmt *summary_statement = NULL;
    const char *summary_sql =
        "INSERT INTO scan_summary VALUES(?,?,?,?,?,?,?,?,?,?,?)";
    if (sqlite3_prepare_v2(database.handle,
                           summary_sql,
                           -1,
                           &summary_statement,
                           NULL) != SQLITE_OK) {
        sqlite_fail(database.handle, "could not prepare scan summary");
    }
    sqlite3_bind_int64(summary_statement, 1, (sqlite3_int64)g_stats.bytes_discovered);
    sqlite3_bind_int64(summary_statement, 2, (sqlite3_int64)g_stats.logical_bytes_discovered);
    sqlite3_bind_int64(summary_statement, 3, (sqlite3_int64)g_stats.cloud_only_files);
    sqlite3_bind_int64(summary_statement, 4, (sqlite3_int64)g_stats.symlinks_skipped);
    sqlite3_bind_int64(summary_statement, 5, (sqlite3_int64)g_stats.unreadable_directories);
    sqlite3_bind_int64(summary_statement, 6, (sqlite3_int64)g_stats.excluded_directories);
    sqlite3_bind_int64(summary_statement, 7, (sqlite3_int64)g_stats.hardlink_duplicates);
    sqlite3_bind_int64(summary_statement, 8, (sqlite3_int64)g_stats.hardlink_bytes_saved);
    sqlite3_bind_int64(summary_statement, 9, (sqlite3_int64)g_stats.clone_duplicates);
    sqlite3_bind_int64(summary_statement, 10, (sqlite3_int64)g_stats.clone_bytes_saved);
    sqlite3_bind_int64(summary_statement, 11, (sqlite3_int64)g_stats.shared_block_files);
    if (sqlite3_step(summary_statement) != SQLITE_DONE) {
        sqlite_fail(database.handle, "could not write scan summary");
    }
    sqlite3_finalize(summary_statement);

    sqlite3_finalize(database.insert_metadata);
    sqlite3_finalize(database.insert_file);
    sqlite3_finalize(database.update_directory);
    sqlite3_finalize(database.insert_directory);
    sqlite_exec_checked(database.handle,
                        "COMMIT;"
                        "CREATE UNIQUE INDEX directories_path ON directories(path);"
                        "CREATE INDEX directories_parent_size ON directories(parent_id,size DESC);"
                        "CREATE INDEX files_parent_size ON files(parent_id,size DESC);"
                        "CREATE INDEX files_size ON files(size DESC);"
                        "CREATE INDEX files_root_branch_size ON files(root_branch_id,size DESC);"
                        "CREATE INDEX files_name_size ON files(name COLLATE NOCASE,size DESC);"
                        "CREATE INDEX files_modified_size ON files(modified_at DESC,size DESC);"
                        "CREATE VIRTUAL TABLE file_search USING fts5("
                        "name,path,content='files',content_rowid='id',"
                        "tokenize='unicode61 remove_diacritics 2'"
                        ");"
                        "INSERT INTO file_search(rowid,name,path) "
                        "SELECT id,name,path FROM files;"
                        "CREATE TABLE largest_files("
                        "scope TEXT NOT NULL,"
                        "root_branch_id INTEGER,"
                        "rank INTEGER NOT NULL,"
                        "name TEXT NOT NULL,"
                        "path TEXT NOT NULL,"
                        "size INTEGER NOT NULL,"
                        "logical_size INTEGER NOT NULL,"
                        "allocated_size INTEGER NOT NULL,"
                        "cloud_only INTEGER NOT NULL"
                        ");"
                        "INSERT INTO largest_files("
                        "scope,root_branch_id,rank,name,path,size,logical_size,allocated_size,cloud_only"
                        ") "
                        "SELECT 'global',NULL,ROW_NUMBER() OVER (ORDER BY size DESC,name),"
                        "name,path,size,logical_size,allocated_size,cloud_only "
                        "FROM files ORDER BY size DESC,name LIMIT 10;"
                        "INSERT INTO largest_files("
                        "scope,root_branch_id,rank,name,path,size,logical_size,allocated_size,cloud_only"
                        ") "
                        "SELECT 'branch',root_branch_id,rank,name,path,size,"
                        "logical_size,allocated_size,cloud_only FROM ("
                        "SELECT root_branch_id,name,path,size,logical_size,allocated_size,cloud_only,"
                        "ROW_NUMBER() OVER (PARTITION BY root_branch_id ORDER BY size DESC,name) AS rank "
                        "FROM files WHERE root_branch_id IS NOT NULL"
                        ") WHERE rank<=3;"
                        "CREATE TABLE branch_file_summary("
                        "root_branch_id INTEGER PRIMARY KEY,"
                        "file_count INTEGER NOT NULL,"
                        "file_size INTEGER NOT NULL"
                        ");"
                        "INSERT INTO branch_file_summary(root_branch_id,file_count,file_size) "
                        "SELECT root_branch_id,COUNT(*),TOTAL(size) FROM files "
                        "WHERE root_branch_id IS NOT NULL GROUP BY root_branch_id;"
                        "CREATE INDEX largest_files_scope_branch "
                        "ON largest_files(scope,root_branch_id,rank);"
                        "ANALYZE;",
                        "could not finalize scan database");
    sqlite3_close(database.handle);
    return root;
}

static void directory_row_free(DirectoryRow *row) {
    free(row->name);
    free(row->path);
    memset(row, 0, sizeof(*row));
}

static void directory_row_list_add(DirectoryRowList *list, DirectoryRow row) {
    if (list->count == list->capacity) {
        size_t next_capacity = list->capacity == 0 ? 16 : list->capacity * 2;
        list->items = xrealloc(list->items, next_capacity * sizeof(DirectoryRow));
        list->capacity = next_capacity;
    }
    list->items[list->count++] = row;
}

static void directory_row_list_free(DirectoryRowList *list) {
    for (size_t i = 0; i < list->count; i++) {
        directory_row_free(&list->items[i]);
    }
    free(list->items);
    memset(list, 0, sizeof(*list));
}

static DirectoryRow directory_row_from_statement(sqlite3_stmt *statement) {
    DirectoryRow row;
    memset(&row, 0, sizeof(row));
    row.id = sqlite3_column_int64(statement, 0);
    row.has_parent = sqlite3_column_type(statement, 1) != SQLITE_NULL;
    row.parent_id = row.has_parent ? sqlite3_column_int64(statement, 1) : 0;
    row.name = xstrdup((const char *)sqlite3_column_text(statement, 2));
    row.path = xstrdup((const char *)sqlite3_column_text(statement, 3));
    row.size = (uint64_t)sqlite3_column_int64(statement, 4);
    row.logical_size = (uint64_t)sqlite3_column_int64(statement, 5);
    row.direct_file_size = (uint64_t)sqlite3_column_int64(statement, 6);
    row.file_count = (uint64_t)sqlite3_column_int64(statement, 7);
    row.directory_count = (uint64_t)sqlite3_column_int64(statement, 8);
    row.direct_file_count = (uint64_t)sqlite3_column_int64(statement, 9);
    row.direct_directory_count = (uint64_t)sqlite3_column_int64(statement, 10);
    return row;
}

static bool load_directory(sqlite3 *database,
                           const char *column,
                           const char *path,
                           sqlite3_int64 id,
                           DirectoryRow *row) {
    char sql[512];
    snprintf(sql,
             sizeof(sql),
             "SELECT id,parent_id,name,path,size,logical_size,direct_file_size,file_count,directory_count,"
             "direct_file_count,direct_directory_count FROM directories WHERE %s=?",
             column);
    sqlite3_stmt *statement = NULL;
    if (sqlite3_prepare_v2(database, sql, -1, &statement, NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not prepare directory query");
    }
    if (path) {
        sqlite3_bind_text(statement, 1, path, -1, SQLITE_TRANSIENT);
    } else {
        sqlite3_bind_int64(statement, 1, id);
    }
    bool found = sqlite3_step(statement) == SQLITE_ROW;
    if (found) {
        *row = directory_row_from_statement(statement);
    }
    sqlite3_finalize(statement);
    return found;
}

static DirectoryRowList load_child_directories(sqlite3 *database,
                                                sqlite3_int64 parent_id,
                                                int limit) {
    DirectoryRowList list = {0};
    sqlite3_stmt *statement = NULL;
    const char *sql =
        "SELECT id,parent_id,name,path,size,logical_size,direct_file_size,file_count,directory_count,"
        "direct_file_count,direct_directory_count "
        "FROM directories WHERE parent_id=? ORDER BY size DESC,name LIMIT ?";
    if (sqlite3_prepare_v2(database, sql, -1, &statement, NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not prepare child directory query");
    }
    sqlite3_bind_int64(statement, 1, parent_id);
    sqlite3_bind_int(statement, 2, limit);
    while (sqlite3_step(statement) == SQLITE_ROW) {
        directory_row_list_add(&list, directory_row_from_statement(statement));
    }
    sqlite3_finalize(statement);
    return list;
}

static void write_directory_fields(FILE *out, const DirectoryRow *row) {
    fputs("\"name\":", out);
    json_write_escaped(out, row->name);
    fputs(",\"path\":", out);
    json_write_escaped(out, row->path);
    fprintf(out,
            ",\"size\":%llu,\"logicalSize\":%llu,\"type\":\"directory\",\"fileCount\":%llu,"
            "\"subdirCount\":%llu,\"itemCount\":%llu,\"hasChildren\":%s",
            (unsigned long long)row->size,
            (unsigned long long)row->logical_size,
            (unsigned long long)row->file_count,
            (unsigned long long)row->directory_count,
            (unsigned long long)(row->direct_file_count + row->direct_directory_count),
            (row->direct_file_count + row->direct_directory_count) > 0 ? "true" : "false");
}

static void write_breadcrumbs(FILE *out, sqlite3 *database, const DirectoryRow *current) {
    DirectoryRowList ancestors = {0};
    sqlite3_int64 id = current->id;
    for (;;) {
        DirectoryRow row;
        memset(&row, 0, sizeof(row));
        if (!load_directory(database, "id", NULL, id, &row)) {
            break;
        }
        bool has_parent = row.has_parent;
        sqlite3_int64 parent_id = row.parent_id;
        directory_row_list_add(&ancestors, row);
        if (!has_parent) {
            break;
        }
        id = parent_id;
    }

    fputs(",\"breadcrumbs\":[", out);
    for (size_t index = ancestors.count; index > 0; index--) {
        DirectoryRow *row = &ancestors.items[index - 1];
        if (index < ancestors.count) {
            fputc(',', out);
        }
        fputs("{\"name\":", out);
        json_write_escaped(out, row->name);
        fputs(",\"path\":", out);
        json_write_escaped(out, row->path);
        fputc('}', out);
    }
    fputc(']', out);
    directory_row_list_free(&ancestors);
}

static void write_aggregate(FILE *out,
                            const char *parent_path,
                            const char *name,
                            const char *kind,
                            uint64_t size,
                            uint64_t count) {
    fputs("{\"name\":", out);
    json_write_escaped(out, name);
    fputs(",\"path\":", out);
    size_t synthetic_length = strlen(parent_path) + strlen(kind) + 32;
    char *synthetic_path = xcalloc(synthetic_length, 1);
    snprintf(synthetic_path, synthetic_length, "diskstatsx:aggregate:%s:%s", kind, parent_path);
    json_write_escaped(out, synthetic_path);
    free(synthetic_path);
    fprintf(out,
            ",\"size\":%llu,\"type\":\"aggregate\",\"aggregateKind\":\"%s\","
            "\"itemCount\":%llu,\"synthetic\":true}",
            (unsigned long long)size,
            kind,
            (unsigned long long)count);
}

static void write_file_json(FILE *out,
                            const char *name,
                            const char *path,
                            uint64_t size,
                            uint64_t logical_size,
                            uint64_t allocated_size,
                            bool cloud_only,
                            bool hardlink_duplicate,
                            bool clone_duplicate,
                            bool shared_blocks,
                            uint32_t clone_refcount,
                            int64_t modified_at) {
    fputs("{\"name\":", out);
    json_write_escaped(out, name);
    fputs(",\"path\":", out);
    json_write_escaped(out, path);
    fprintf(out,
            ",\"size\":%llu,\"logicalSize\":%llu,\"allocatedSize\":%llu,"
            "\"type\":\"file\",\"cloudOnly\":%s,\"hardlinkDuplicate\":%s,"
            "\"cloneDuplicate\":%s,\"sharedBlocks\":%s,\"cloneRefCount\":%u,"
            "\"modifiedAt\":%lld}",
            (unsigned long long)size,
            (unsigned long long)logical_size,
            (unsigned long long)allocated_size,
            cloud_only ? "true" : "false",
            hardlink_duplicate ? "true" : "false",
            clone_duplicate ? "true" : "false",
            shared_blocks ? "true" : "false",
            clone_refcount,
            (long long)modified_at);
}

static void write_directory_children(FILE *out,
                                     sqlite3 *database,
                                     const DirectoryRow *parent,
                                     int directory_limit,
                                     int file_limit,
                                     int expanded_directory_limit) {
    DirectoryRowList children = load_child_directories(database,
                                                       parent->id,
                                                       directory_limit);
    bool needs_comma = false;
    uint64_t included_directory_size = 0;

    for (size_t i = 0; i < children.count; i++) {
        if (needs_comma) {
            fputc(',', out);
        }
        fputc('{', out);
        write_directory_fields(out, &children.items[i]);
        if ((int)i < expanded_directory_limit &&
            (children.items[i].direct_file_count +
             children.items[i].direct_directory_count) > 0) {
            fputs(",\"children\":[", out);
            write_directory_children(out,
                                     database,
                                     &children.items[i],
                                     QUERY_SECOND_LEVEL_DIRECTORY_LIMIT,
                                     QUERY_SECOND_LEVEL_FILE_LIMIT,
                                     0);
            fputc(']', out);
        }
        fputc('}', out);
        included_directory_size += children.items[i].size;
        needs_comma = true;
    }

    sqlite3_stmt *files = NULL;
    const char *file_sql =
        "SELECT name,size,logical_size,allocated_size,cloud_only,"
        "hardlink_duplicate,clone_duplicate,shared_blocks,clone_refcount,modified_at "
        "FROM files WHERE parent_id=? ORDER BY size DESC,name LIMIT ?";
    if (sqlite3_prepare_v2(database, file_sql, -1, &files, NULL) != SQLITE_OK) {
        directory_row_list_free(&children);
        sqlite_fail(database, "could not prepare file query");
    }
    sqlite3_bind_int64(files, 1, parent->id);
    sqlite3_bind_int(files, 2, file_limit);
    uint64_t included_file_size = 0;
    uint64_t included_file_count = 0;
    while (sqlite3_step(files) == SQLITE_ROW) {
        const char *name = (const char *)sqlite3_column_text(files, 0);
        uint64_t size = (uint64_t)sqlite3_column_int64(files, 1);
        uint64_t logical_size = (uint64_t)sqlite3_column_int64(files, 2);
        uint64_t allocated_size = (uint64_t)sqlite3_column_int64(files, 3);
        bool cloud_only = sqlite3_column_int(files, 4) != 0;
        char *file_path = join_path(parent->path, name);
        if (needs_comma) {
            fputc(',', out);
        }
        write_file_json(out,
                        name,
                        file_path,
                        size,
                        logical_size,
                        allocated_size,
                        cloud_only,
                        sqlite3_column_int(files, 5) != 0,
                        sqlite3_column_int(files, 6) != 0,
                        sqlite3_column_int(files, 7) != 0,
                        (uint32_t)sqlite3_column_int(files, 8),
                        (int64_t)sqlite3_column_int64(files, 9));
        free(file_path);
        included_file_size += size;
        included_file_count++;
        needs_comma = true;
    }
    sqlite3_finalize(files);

    uint64_t omitted_directories = parent->direct_directory_count > children.count
        ? parent->direct_directory_count - children.count
        : 0;
    uint64_t directory_bytes = parent->size >= parent->direct_file_size
        ? parent->size - parent->direct_file_size
        : 0;
    uint64_t omitted_directory_size = directory_bytes > included_directory_size
        ? directory_bytes - included_directory_size
        : 0;
    if (omitted_directories > 0) {
        if (needs_comma) {
            fputc(',', out);
        }
        char name[128];
        snprintf(name,
                 sizeof(name),
                 "Other folders (%llu)",
                 (unsigned long long)omitted_directories);
        write_aggregate(out,
                        parent->path,
                        name,
                        "folders",
                        omitted_directory_size,
                        omitted_directories);
        needs_comma = true;
    }

    uint64_t omitted_files = parent->direct_file_count > included_file_count
        ? parent->direct_file_count - included_file_count
        : 0;
    uint64_t omitted_file_size = parent->direct_file_size > included_file_size
        ? parent->direct_file_size - included_file_size
        : 0;
    if (omitted_files > 0) {
        if (needs_comma) {
            fputc(',', out);
        }
        char name[128];
        snprintf(name,
                 sizeof(name),
                 "Other files (%llu)",
                 (unsigned long long)omitted_files);
        write_aggregate(out,
                        parent->path,
                        name,
                        "files",
                        omitted_file_size,
                        omitted_files);
    }

    directory_row_list_free(&children);
}

static void close_largest_file_branch(FILE *out,
                                      const char *branch_path,
                                      uint64_t total_count,
                                      uint64_t total_size,
                                      uint64_t included_count,
                                      uint64_t included_size) {
    fputc(']', out);
    if (total_count > included_count) {
        uint64_t remaining_count = total_count - included_count;
        uint64_t remaining_size = total_size > included_size
            ? total_size - included_size
            : 0;
        fputs(",\"other\":", out);
        char name[128];
        snprintf(name,
                 sizeof(name),
                 "Other files (%llu)",
                 (unsigned long long)remaining_count);
        write_aggregate(out,
                        branch_path,
                        name,
                        "files",
                        remaining_size,
                        remaining_count);
    }
    fputc('}', out);
}

static void write_largest_files_summary(FILE *out,
                                        sqlite3 *database,
                                        sqlite3_int64 root_id) {
    sqlite3_stmt *global = NULL;
    const char *global_sql =
        "SELECT name,path,size,logical_size,allocated_size,cloud_only FROM largest_files "
        "WHERE scope='global' ORDER BY rank";
    if (sqlite3_prepare_v2(database, global_sql, -1, &global, NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not prepare global largest files query");
    }

    fputs(",\"largestFiles\":{\"global\":[", out);
    bool needs_comma = false;
    while (sqlite3_step(global) == SQLITE_ROW) {
        if (needs_comma) {
            fputc(',', out);
        }
        write_file_json(out,
                        (const char *)sqlite3_column_text(global, 0),
                        (const char *)sqlite3_column_text(global, 1),
                        (uint64_t)sqlite3_column_int64(global, 2),
                        (uint64_t)sqlite3_column_int64(global, 3),
                        (uint64_t)sqlite3_column_int64(global, 4),
                        sqlite3_column_int(global, 5) != 0,
                        false,
                        false,
                        false,
                        0,
                        0);
        needs_comma = true;
    }
    sqlite3_finalize(global);

    sqlite3_stmt *branches = NULL;
    const char *branch_sql =
        "SELECT d.id,d.name,d.path,s.file_count,s.file_size,"
        "lf.rank,lf.name,lf.path,lf.size,lf.logical_size,lf.allocated_size,lf.cloud_only "
        "FROM directories d "
        "JOIN branch_file_summary s ON s.root_branch_id=d.id "
        "LEFT JOIN largest_files lf ON lf.scope='branch' AND lf.root_branch_id=d.id "
        "WHERE d.parent_id=? "
        "ORDER BY d.size DESC,d.name,lf.rank";
    if (sqlite3_prepare_v2(database, branch_sql, -1, &branches, NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not prepare branch largest files query");
    }
    sqlite3_bind_int64(branches, 1, root_id);

    fputs("],\"firstLevel\":[", out);
    sqlite3_int64 current_branch_id = -1;
    char *current_branch_path = NULL;
    uint64_t total_count = 0;
    uint64_t total_size = 0;
    uint64_t included_count = 0;
    uint64_t included_size = 0;
    bool branch_comma = false;
    bool file_comma = false;

    while (sqlite3_step(branches) == SQLITE_ROW) {
        sqlite3_int64 branch_id = sqlite3_column_int64(branches, 0);
        if (branch_id != current_branch_id) {
            if (current_branch_id >= 0) {
                close_largest_file_branch(out,
                                          current_branch_path,
                                          total_count,
                                          total_size,
                                          included_count,
                                          included_size);
                free(current_branch_path);
            }
            if (branch_comma) {
                fputc(',', out);
            }
            current_branch_id = branch_id;
            current_branch_path = xstrdup((const char *)sqlite3_column_text(branches, 2));
            total_count = (uint64_t)sqlite3_column_int64(branches, 3);
            total_size = (uint64_t)sqlite3_column_int64(branches, 4);
            included_count = 0;
            included_size = 0;
            file_comma = false;
            fputs("{\"name\":", out);
            json_write_escaped(out, (const char *)sqlite3_column_text(branches, 1));
            fputs(",\"path\":", out);
            json_write_escaped(out, current_branch_path);
            fputs(",\"files\":[", out);
            branch_comma = true;
        }

        if (sqlite3_column_type(branches, 5) != SQLITE_NULL) {
            if (file_comma) {
                fputc(',', out);
            }
            uint64_t size = (uint64_t)sqlite3_column_int64(branches, 8);
            write_file_json(out,
                            (const char *)sqlite3_column_text(branches, 6),
                            (const char *)sqlite3_column_text(branches, 7),
                            size,
                            (uint64_t)sqlite3_column_int64(branches, 9),
                            (uint64_t)sqlite3_column_int64(branches, 10),
                            sqlite3_column_int(branches, 11) != 0,
                            false,
                            false,
                            false,
                            0,
                            0);
            included_count++;
            included_size += size;
            file_comma = true;
        }
    }
    if (current_branch_id >= 0) {
        close_largest_file_branch(out,
                                  current_branch_path,
                                  total_count,
                                  total_size,
                                  included_count,
                                  included_size);
        free(current_branch_path);
    }
    sqlite3_finalize(branches);
    fputs("]}", out);
}

static void write_scan_summary(FILE *out, sqlite3 *database) {
    sqlite3_stmt *statement = NULL;
    const char *sql =
        "SELECT allocated_bytes,logical_bytes,cloud_only_files,symlinks_skipped,"
        "unreadable_directories,excluded_directories,hardlink_duplicates,"
        "hardlink_bytes_saved,clone_duplicates,clone_bytes_saved,shared_block_files "
        "FROM scan_summary LIMIT 1";
    if (sqlite3_prepare_v2(database, sql, -1, &statement, NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not prepare scan summary query");
    }
    if (sqlite3_step(statement) == SQLITE_ROW) {
        uint64_t shared_block_files = (uint64_t)sqlite3_column_int64(statement, 10);
        fprintf(out,
                ",\"scanSummary\":{\"allocatedBytes\":%llu,\"logicalBytes\":%llu,"
                "\"cloudOnlyFiles\":%llu,\"symlinksSkipped\":%llu,"
                "\"unreadableDirectories\":%llu,\"excludedDirectories\":%llu,"
                "\"excludedBytes\":null,\"hardlinkDuplicates\":%llu,"
                "\"hardlinkBytesSaved\":%llu,\"cloneDuplicates\":%llu,"
                "\"cloneBytesSaved\":%llu,\"sharedBlockFiles\":%llu,"
                "\"allocationIsEstimate\":%s}",
                (unsigned long long)sqlite3_column_int64(statement, 0),
                (unsigned long long)sqlite3_column_int64(statement, 1),
                (unsigned long long)sqlite3_column_int64(statement, 2),
                (unsigned long long)sqlite3_column_int64(statement, 3),
                (unsigned long long)sqlite3_column_int64(statement, 4),
                (unsigned long long)sqlite3_column_int64(statement, 5),
                (unsigned long long)sqlite3_column_int64(statement, 6),
                (unsigned long long)sqlite3_column_int64(statement, 7),
                (unsigned long long)sqlite3_column_int64(statement, 8),
                (unsigned long long)sqlite3_column_int64(statement, 9),
                (unsigned long long)shared_block_files,
                shared_block_files > 0 ? "true" : "false");
    }
    sqlite3_finalize(statement);
}

static void query_database(const char *database_path, const char *requested_path) {
    sqlite3 *database = NULL;
    if (sqlite3_open_v2(database_path, &database, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not open scan database");
    }

    DirectoryRow current;
    memset(&current, 0, sizeof(current));
    if (!load_directory(database, "path", requested_path, 0, &current)) {
        sqlite3_close(database);
        die("directory is not present in the scan index");
    }
    fputc('{', stdout);
    write_directory_fields(stdout, &current);
    fputs(",\"lazy\":true", stdout);
    if (current.has_parent) {
        DirectoryRow parent;
        memset(&parent, 0, sizeof(parent));
        if (load_directory(database, "id", NULL, current.parent_id, &parent)) {
            fputs(",\"parentPath\":", stdout);
            json_write_escaped(stdout, parent.path);
            directory_row_free(&parent);
        }
    }
    write_breadcrumbs(stdout, database, &current);
    write_scan_summary(stdout, database);
    fputs(",\"children\":[", stdout);
    write_directory_children(stdout,
                             database,
                             &current,
                             QUERY_DIRECTORY_LIMIT,
                             QUERY_FILE_LIMIT,
                             QUERY_EXPANDED_DIRECTORY_LIMIT);
    fputc(']', stdout);
    if (!current.has_parent) {
        write_largest_files_summary(stdout, database, current.id);
    }
    fputs("}\n", stdout);
    fflush(stdout);
    directory_row_free(&current);
    sqlite3_close(database);
}

static char *sqlite_like_pattern(const char *value, bool suffix_only) {
    size_t length = strlen(value);
    char *pattern = xcalloc(length * 2 + 3, 1);
    size_t offset = 0;
    pattern[offset++] = '%';
    for (size_t i = 0; i < length; i++) {
        if (value[i] == '%' || value[i] == '_' || value[i] == '\\') {
            pattern[offset++] = '\\';
        }
        pattern[offset++] = value[i];
    }
    if (!suffix_only) {
        pattern[offset++] = '%';
    }
    pattern[offset] = '\0';
    return pattern;
}

static char *sqlite_fts_prefix_query(const char *value) {
    size_t length = strlen(value);
    /* A one-character token can expand to '"a"* AND ' (nine bytes per pair). */
    char *query = xcalloc(length * 5 + 64, 1);
    size_t offset = 0;
    bool in_token = false;
    bool needs_and = false;
    for (size_t i = 0; i < length; i++) {
        unsigned char character = (unsigned char)value[i];
        bool token_character = isalnum(character) || character >= 0x80;
        if (!token_character) {
            if (in_token) {
                query[offset++] = '"';
                query[offset++] = '*';
                in_token = false;
                needs_and = true;
            }
            continue;
        }
        if (!in_token) {
            if (needs_and) {
                memcpy(query + offset, " AND ", 5);
                offset += 5;
            }
            query[offset++] = '"';
            in_token = true;
        }
        query[offset++] = (char)character;
    }
    if (in_token) {
        query[offset++] = '"';
        query[offset++] = '*';
    }
    if (offset == 0) {
        strcpy(query, "\"diskstatsxqznotoken\"");
    } else {
        query[offset] = '\0';
    }
    return query;
}

static uint64_t parse_u64_argument(const char *value, const char *name) {
    char *end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(value, &end, 10);
    if (errno != 0 || !end || *end != '\0') {
        char message[256];
        snprintf(message, sizeof(message), "invalid %s", name);
        die(message);
    }
    return (uint64_t)parsed;
}

static int64_t parse_i64_argument(const char *value, const char *name) {
    char *end = NULL;
    errno = 0;
    long long parsed = strtoll(value, &end, 10);
    if (errno != 0 || !end || *end != '\0') {
        char message[256];
        snprintf(message, sizeof(message), "invalid %s", name);
        die(message);
    }
    return (int64_t)parsed;
}

static bool sqlite_table_exists(sqlite3 *database, const char *name) {
    sqlite3_stmt *statement = NULL;
    const char *sql =
        "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=? LIMIT 1";
    if (sqlite3_prepare_v2(database, sql, -1, &statement, NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not inspect scan database schema");
    }
    sqlite3_bind_text(statement, 1, name, -1, SQLITE_STATIC);
    bool found = sqlite3_step(statement) == SQLITE_ROW;
    sqlite3_finalize(statement);
    return found;
}

static void query_search(const char *database_path, const SearchOptions *options) {
    sqlite3 *database = NULL;
    if (sqlite3_open_v2(database_path, &database, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not open scan database");
    }
    const char *term = options->term ? options->term : "";
    const char *extension = options->extension ? options->extension : "";
    char *term_query = sqlite_fts_prefix_query(term);
    char *term_pattern = NULL;
    char *extension_pattern = sqlite_like_pattern(extension, true);
    bool has_full_text_index = sqlite_table_exists(database, "file_search");
    const char *indexed_sql =
        "SELECT f.name,f.path,f.size,f.logical_size,f.allocated_size,f.modified_at,f.cloud_only,"
        "f.hardlink_duplicate,f.clone_duplicate,f.shared_blocks,f.clone_refcount "
        "FROM files AS f WHERE "
        "(?1='' OR f.id IN (SELECT rowid FROM file_search WHERE file_search MATCH ?2)) "
        "AND (?3=0 OR f.size>=?3) "
        "AND (?4=0 OR f.size<=?4) "
        "AND (?5=0 OR f.modified_at>=?5) "
        "AND (?6=0 OR f.modified_at<=?6) "
        "AND (?7='' OR f.name LIKE ?8 ESCAPE '\\' COLLATE NOCASE) "
        "AND (?9=0 OR f.cloud_only=1) "
        "AND (?10=0 OR f.shared_blocks=1) "
        "ORDER BY f.size DESC,f.name COLLATE NOCASE LIMIT ?11";
    const char *legacy_sql =
        "SELECT name,path,size,logical_size,allocated_size,modified_at,cloud_only,"
        "hardlink_duplicate,clone_duplicate,shared_blocks,clone_refcount "
        "FROM files WHERE "
        "(?1='' OR name LIKE ?2 ESCAPE '\\' COLLATE NOCASE OR path LIKE ?2 ESCAPE '\\' COLLATE NOCASE) "
        "AND (?3=0 OR size>=?3) "
        "AND (?4=0 OR size<=?4) "
        "AND (?5=0 OR modified_at>=?5) "
        "AND (?6=0 OR modified_at<=?6) "
        "AND (?7='' OR name LIKE ?8 ESCAPE '\\' COLLATE NOCASE) "
        "AND (?9=0 OR cloud_only=1) "
        "AND (?10=0 OR shared_blocks=1) "
        "ORDER BY size DESC,name COLLATE NOCASE LIMIT ?11";
    const char *sql = has_full_text_index ? indexed_sql : legacy_sql;
    if (!has_full_text_index) {
        term_pattern = sqlite_like_pattern(term, false);
    }
    sqlite3_stmt *statement = NULL;
    if (sqlite3_prepare_v2(database, sql, -1, &statement, NULL) != SQLITE_OK) {
        free(term_query);
        free(term_pattern);
        free(extension_pattern);
        sqlite_fail(database, "could not prepare search query");
    }
    sqlite3_bind_text(statement, 1, term, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(statement,
                      2,
                      has_full_text_index ? term_query : term_pattern,
                      -1,
                      SQLITE_TRANSIENT);
    sqlite3_bind_int64(statement, 3, (sqlite3_int64)options->min_size);
    sqlite3_bind_int64(statement, 4, (sqlite3_int64)options->max_size);
    sqlite3_bind_int64(statement, 5, options->modified_after);
    sqlite3_bind_int64(statement, 6, options->modified_before);
    sqlite3_bind_text(statement, 7, extension, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(statement, 8, extension_pattern, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(statement, 9, options->cloud_only ? 1 : 0);
    sqlite3_bind_int(statement, 10, options->shared_blocks ? 1 : 0);
    sqlite3_bind_int(statement, 11, options->limit);

    fputs("{\"results\":[", stdout);
    bool needs_comma = false;
    while (sqlite3_step(statement) == SQLITE_ROW) {
        if (needs_comma) {
            fputc(',', stdout);
        }
        write_file_json(stdout,
                        (const char *)sqlite3_column_text(statement, 0),
                        (const char *)sqlite3_column_text(statement, 1),
                        (uint64_t)sqlite3_column_int64(statement, 2),
                        (uint64_t)sqlite3_column_int64(statement, 3),
                        (uint64_t)sqlite3_column_int64(statement, 4),
                        sqlite3_column_int(statement, 6) != 0,
                        sqlite3_column_int(statement, 7) != 0,
                        sqlite3_column_int(statement, 8) != 0,
                        sqlite3_column_int(statement, 9) != 0,
                        (uint32_t)sqlite3_column_int(statement, 10),
                        (int64_t)sqlite3_column_int64(statement, 5));
        needs_comma = true;
    }
    fprintf(stdout, "],\"limit\":%d}\n", options->limit);
    fflush(stdout);
    sqlite3_finalize(statement);
    free(term_query);
    free(term_pattern);
    free(extension_pattern);
    sqlite3_close(database);
}

static bool ends_with_case_insensitive(const char *value, const char *suffix) {
    size_t value_length = strlen(value);
    size_t suffix_length = strlen(suffix);
    return value_length >= suffix_length &&
        strcasecmp(value + value_length - suffix_length, suffix) == 0;
}

static const char *cleanup_category(const char *name,
                                    const char *path,
                                    int64_t modified_at,
                                    int64_t old_download_cutoff) {
    if (ends_with_case_insensitive(name, ".dmg") ||
        ends_with_case_insensitive(name, ".iso")) {
        return "Disk image";
    }
    if (ends_with_case_insensitive(name, ".pkg")) {
        return "Installer";
    }
    if (ends_with_case_insensitive(name, ".zip") ||
        ends_with_case_insensitive(name, ".tar") ||
        ends_with_case_insensitive(name, ".tgz") ||
        ends_with_case_insensitive(name, ".gz") ||
        ends_with_case_insensitive(name, ".7z") ||
        ends_with_case_insensitive(name, ".rar")) {
        return "Archive";
    }
    if (strstr(path, "/Caches/") != NULL) {
        return "Cache payload";
    }
    if (strstr(path, "/Downloads/") != NULL &&
        modified_at > 0 && modified_at < old_download_cutoff) {
        return "Old download";
    }
    return NULL;
}

static void write_cleanup_file_json(FILE *out,
                                    sqlite3_stmt *statement,
                                    const char *category) {
    fputs("{\"name\":", out);
    json_write_escaped(out, (const char *)sqlite3_column_text(statement, 0));
    fputs(",\"path\":", out);
    json_write_escaped(out, (const char *)sqlite3_column_text(statement, 1));
    fprintf(out,
            ",\"size\":%llu,\"logicalSize\":%llu,\"allocatedSize\":%llu,"
            "\"modifiedAt\":%lld,\"type\":\"file\",\"cloudOnly\":%s,"
            "\"sharedBlocks\":%s,\"cleanupCategory\":",
            (unsigned long long)sqlite3_column_int64(statement, 2),
            (unsigned long long)sqlite3_column_int64(statement, 3),
            (unsigned long long)sqlite3_column_int64(statement, 4),
            (long long)sqlite3_column_int64(statement, 5),
            sqlite3_column_int(statement, 6) != 0 ? "true" : "false",
            sqlite3_column_int(statement, 9) != 0 ? "true" : "false");
    json_write_escaped(out, category);
    fputs("}", out);
}

static void query_cleanup(const char *database_path, int limit, int64_t old_download_cutoff) {
    sqlite3 *database = NULL;
    if (sqlite3_open_v2(database_path, &database, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not open scan database");
    }
    const char *sql =
        "SELECT name,path,size,logical_size,allocated_size,modified_at,cloud_only,"
        "hardlink_duplicate,clone_duplicate,shared_blocks,clone_refcount "
        "FROM files WHERE size>=? ORDER BY size DESC,name COLLATE NOCASE LIMIT 1500";
    sqlite3_stmt *statement = NULL;
    if (sqlite3_prepare_v2(database, sql, -1, &statement, NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not prepare cleanup query");
    }
    sqlite3_bind_int64(statement, 1, 50LL * 1024LL * 1024LL);
    int emitted = 0;
    bool needs_comma = false;
    fputs("{\"results\":[", stdout);
    while (emitted < limit && sqlite3_step(statement) == SQLITE_ROW) {
        const char *name = (const char *)sqlite3_column_text(statement, 0);
        const char *path = (const char *)sqlite3_column_text(statement, 1);
        const char *category = cleanup_category(name,
                                                path,
                                                (int64_t)sqlite3_column_int64(statement, 5),
                                                old_download_cutoff);
        if (!category) {
            continue;
        }
        if (needs_comma) {
            fputc(',', stdout);
        }
        write_cleanup_file_json(stdout, statement, category);
        needs_comma = true;
        emitted++;
    }
    fprintf(stdout, "],\"limit\":%d}\n", limit);
    fflush(stdout);
    sqlite3_finalize(statement);
    sqlite3_close(database);
}

static SnapshotTotals read_snapshot_totals(sqlite3 *database, const char *schema) {
    SnapshotTotals totals = {0};
    char sql[512];
    snprintf(sql,
             sizeof(sql),
             "SELECT allocated_bytes,logical_bytes,"
             "(SELECT COUNT(*) FROM %s.files),"
             "(SELECT COUNT(*) FROM %s.directories) "
             "FROM %s.scan_summary LIMIT 1",
             schema,
             schema,
             schema);
    sqlite3_stmt *statement = NULL;
    if (sqlite3_prepare_v2(database, sql, -1, &statement, NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not prepare snapshot totals");
    }
    if (sqlite3_step(statement) == SQLITE_ROW) {
        totals.allocated_bytes = (uint64_t)sqlite3_column_int64(statement, 0);
        totals.logical_bytes = (uint64_t)sqlite3_column_int64(statement, 1);
        totals.file_count = (uint64_t)sqlite3_column_int64(statement, 2);
        totals.directory_count = (uint64_t)sqlite3_column_int64(statement, 3);
    } else {
        sqlite3_finalize(statement);
        die("scan snapshot is missing summary data");
    }
    sqlite3_finalize(statement);
    return totals;
}

static void write_snapshot_totals(FILE *out, const SnapshotTotals *totals) {
    fprintf(out,
            "{\"allocatedBytes\":%llu,\"logicalBytes\":%llu,"
            "\"fileCount\":%llu,\"directoryCount\":%llu}",
            (unsigned long long)totals->allocated_bytes,
            (unsigned long long)totals->logical_bytes,
            (unsigned long long)totals->file_count,
            (unsigned long long)totals->directory_count);
}

static void query_compare(const char *before_database_path, const char *after_database_path) {
    sqlite3 *database = NULL;
    if (sqlite3_open_v2(before_database_path, &database, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not open baseline snapshot");
    }
    sqlite3_stmt *attach = NULL;
    if (sqlite3_prepare_v2(database, "ATTACH DATABASE ? AS other", -1, &attach, NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not prepare snapshot attach");
    }
    sqlite3_bind_text(attach, 1, after_database_path, -1, SQLITE_TRANSIENT);
    if (sqlite3_step(attach) != SQLITE_DONE) {
        sqlite3_finalize(attach);
        sqlite_fail(database, "could not attach comparison snapshot");
    }
    sqlite3_finalize(attach);

    SnapshotTotals before = read_snapshot_totals(database, "main");
    SnapshotTotals after = read_snapshot_totals(database, "other");
    const char *changes_sql =
        "WITH changes(name,path,before_size,after_size,before_logical,after_logical) AS ("
        "SELECT old_dir.name,old_dir.path,old_dir.size,COALESCE(new_dir.size,0),"
        "old_dir.logical_size,COALESCE(new_dir.logical_size,0) "
        "FROM main.directories AS old_dir "
        "LEFT JOIN other.directories AS new_dir ON new_dir.path=old_dir.path "
        "UNION ALL "
        "SELECT new_dir.name,new_dir.path,0,new_dir.size,0,new_dir.logical_size "
        "FROM other.directories AS new_dir "
        "LEFT JOIN main.directories AS old_dir ON old_dir.path=new_dir.path "
        "WHERE old_dir.path IS NULL"
        ") "
        "SELECT name,path,before_size,after_size,before_logical,after_logical "
        "FROM changes WHERE before_size<>after_size OR before_logical<>after_logical "
        "ORDER BY ABS(after_size-before_size) DESC,path COLLATE NOCASE LIMIT 120";
    sqlite3_stmt *changes = NULL;
    if (sqlite3_prepare_v2(database, changes_sql, -1, &changes, NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not prepare comparison query");
    }

    int64_t allocated_delta = (int64_t)after.allocated_bytes - (int64_t)before.allocated_bytes;
    int64_t logical_delta = (int64_t)after.logical_bytes - (int64_t)before.logical_bytes;
    int64_t file_delta = (int64_t)after.file_count - (int64_t)before.file_count;
    int64_t directory_delta = (int64_t)after.directory_count - (int64_t)before.directory_count;
    fputs("{\"before\":", stdout);
    write_snapshot_totals(stdout, &before);
    fputs(",\"after\":", stdout);
    write_snapshot_totals(stdout, &after);
    fprintf(stdout,
            ",\"delta\":{\"allocatedBytes\":%lld,\"logicalBytes\":%lld,"
            "\"fileCount\":%lld,\"directoryCount\":%lld},\"changes\":[",
            (long long)allocated_delta,
            (long long)logical_delta,
            (long long)file_delta,
            (long long)directory_delta);
    bool needs_comma = false;
    while (sqlite3_step(changes) == SQLITE_ROW) {
        uint64_t before_size = (uint64_t)sqlite3_column_int64(changes, 2);
        uint64_t after_size = (uint64_t)sqlite3_column_int64(changes, 3);
        int64_t delta = (int64_t)after_size - (int64_t)before_size;
        const char *kind = before_size == 0 ? "added" :
            after_size == 0 ? "removed" :
            delta > 0 ? "grown" : "shrunk";
        if (needs_comma) {
            fputc(',', stdout);
        }
        fputs("{\"name\":", stdout);
        json_write_escaped(stdout, (const char *)sqlite3_column_text(changes, 0));
        fputs(",\"path\":", stdout);
        json_write_escaped(stdout, (const char *)sqlite3_column_text(changes, 1));
        fprintf(stdout,
                ",\"beforeSize\":%llu,\"afterSize\":%llu,\"delta\":%lld,\"kind\":",
                (unsigned long long)before_size,
                (unsigned long long)after_size,
                (long long)delta);
        json_write_escaped(stdout, kind);
        fputc('}', stdout);
        needs_comma = true;
    }
    fputs("]}\n", stdout);
    fflush(stdout);
    sqlite3_finalize(changes);
    sqlite3_close(database);
}

static int search_mode(int argc, char **argv) {
    if (argc < 4) {
        die("usage: scanner --search <database> <term> [filters]");
    }
    SearchOptions options = {
        .term = argv[3],
        .limit = 200
    };
    for (int i = 4; i < argc; i++) {
        if (strcmp(argv[i], "--extension") == 0 && i + 1 < argc) {
            options.extension = argv[++i];
        } else if (strcmp(argv[i], "--min-size") == 0 && i + 1 < argc) {
            options.min_size = parse_u64_argument(argv[++i], "minimum size");
        } else if (strcmp(argv[i], "--max-size") == 0 && i + 1 < argc) {
            options.max_size = parse_u64_argument(argv[++i], "maximum size");
        } else if (strcmp(argv[i], "--modified-after") == 0 && i + 1 < argc) {
            options.modified_after = parse_i64_argument(argv[++i], "modified-after timestamp");
        } else if (strcmp(argv[i], "--modified-before") == 0 && i + 1 < argc) {
            options.modified_before = parse_i64_argument(argv[++i], "modified-before timestamp");
        } else if (strcmp(argv[i], "--cloud-only") == 0) {
            options.cloud_only = true;
        } else if (strcmp(argv[i], "--shared-blocks") == 0) {
            options.shared_blocks = true;
        } else if (strcmp(argv[i], "--limit") == 0 && i + 1 < argc) {
            uint64_t limit = parse_u64_argument(argv[++i], "search limit");
            options.limit = (int)(limit > 500 ? 500 : limit);
        } else {
            die("unknown search option");
        }
    }
    if (options.limit < 1) {
        options.limit = 1;
    }
    query_search(argv[2], &options);
    return 0;
}

static int cleanup_mode(int argc, char **argv) {
    if (argc < 3) {
        die("usage: scanner --cleanup <database> [options]");
    }
    int limit = 150;
    int64_t age_days = 30;
    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--limit") == 0 && i + 1 < argc) {
            uint64_t parsed = parse_u64_argument(argv[++i], "cleanup limit");
            limit = (int)(parsed > 300 ? 300 : parsed);
        } else if (strcmp(argv[i], "--older-than-days") == 0 && i + 1 < argc) {
            age_days = parse_i64_argument(argv[++i], "cleanup age");
        } else {
            die("unknown cleanup option");
        }
    }
    if (limit < 1) {
        limit = 1;
    }
    if (age_days < 0) {
        age_days = 0;
    }
    int64_t cutoff = (int64_t)time(NULL) - age_days * 24 * 60 * 60;
    query_cleanup(argv[2], limit, cutoff);
    return 0;
}

static int scan_mode(int argc, char **argv) {
    if (argc < 2) {
        die("usage: scanner <root-path> --database <path> [filters]");
    }

    ScanOptions options = {0};
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--skip-caches") == 0) {
            options.skip_caches = 1;
        } else if (strcmp(argv[i], "--skip-external-volumes") == 0) {
            options.skip_external_volumes = 1;
        } else if (strcmp(argv[i], "--skip-system-folders") == 0) {
            options.skip_system_folders = 1;
        } else if (strcmp(argv[i], "--exclude") == 0 && i + 1 < argc) {
            options.excluded_paths = xrealloc(
                options.excluded_paths,
                (options.excluded_path_count + 1) * sizeof(char *)
            );
            options.excluded_paths[options.excluded_path_count++] = argv[++i];
        } else if (strcmp(argv[i], "--database") == 0 && i + 1 < argc) {
            options.database_path = argv[++i];
        } else {
            die("unknown scanner option");
        }
    }
    if (!options.database_path) {
        die("--database is required");
    }

    setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
                   IOPOL_SCOPE_PROCESS,
                   IOPOL_MATERIALIZE_DATALESS_FILES_OFF);

    char *root_path = normalize_root_path(argv[1]);
    int root_fd = open(root_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW, 0);
    if (root_fd < 0) {
        char message[1024];
        snprintf(message, sizeof(message), "cannot open directory: %s", root_path);
        free(root_path);
        die(message);
    }

    char *attr_buffer = malloc(ATTR_BUFFER_SIZE);
    if (!attr_buffer) {
        close(root_fd);
        free(root_path);
        die("out of memory");
    }

    g_stats = (ScanStats){0};
    g_last_progress_ms = now_ms();
    emit_progress(root_path, true);
    DirectoryAggregate root = write_scan_database(options.database_path,
                                                  root_path,
                                                  root_fd,
                                                  attr_buffer,
                                                  ATTR_BUFFER_SIZE,
                                                  &options);
    close(root_fd);

    emit_progress(root_path, true);
    fputs("{\"rootPath\":", stdout);
    json_write_escaped(stdout, root_path);
    fprintf(stdout,
            ",\"size\":%llu,\"logicalSize\":%llu,\"filesScanned\":%llu,"
            "\"directoriesScanned\":%llu,\"hardlinkDuplicates\":%llu,"
            "\"cloneDuplicates\":%llu}\n",
            (unsigned long long)root.size,
            (unsigned long long)root.logical_size,
            (unsigned long long)g_stats.files_scanned,
            (unsigned long long)g_stats.directories_scanned,
            (unsigned long long)g_stats.hardlink_duplicates,
            (unsigned long long)g_stats.clone_duplicates);
    fflush(stdout);

    identity_set_free(&g_hardlinks);
    identity_set_free(&g_clones);
    free(options.excluded_paths);
    free(attr_buffer);
    free(root_path);
    return 0;
}

int main(int argc, char **argv) {
    if (argc >= 4 && strcmp(argv[1], "--query") == 0) {
        query_database(argv[2], argv[3]);
        return 0;
    }
    if (argc >= 4 && strcmp(argv[1], "--search") == 0) {
        return search_mode(argc, argv);
    }
    if (argc >= 3 && strcmp(argv[1], "--cleanup") == 0) {
        return cleanup_mode(argc, argv);
    }
    if (argc >= 4 && strcmp(argv[1], "--compare") == 0) {
        query_compare(argv[2], argv[3]);
        return 0;
    }
    return scan_mode(argc, argv);
}
