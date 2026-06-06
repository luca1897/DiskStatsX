#define _DARWIN_C_SOURCE

#include "scanner.h"

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/vnode.h>
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
    uint64_t total_size;
    uint64_t alloc_size;
    uint64_t data_length;
    uint64_t data_alloc_size;
} EntryAttrs;

typedef struct PendingDir {
    Node *node;
    char *path;
} PendingDir;

typedef struct PendingDirList {
    PendingDir *items;
    size_t count;
    size_t capacity;
} PendingDirList;

typedef struct DirectoryRow {
    sqlite3_int64 id;
    sqlite3_int64 parent_id;
    char *name;
    char *path;
    uint64_t size;
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

static Node *node_create(const char *name, NodeType type, uint64_t size) {
    Node *node = xcalloc(1, sizeof(Node));
    node->name = xstrdup(name);
    node->type = type;
    node->size = size;
    return node;
}

static void node_add_child(Node *parent, Node *child) {
    if (parent->child_count == parent->child_capacity) {
        size_t next_capacity = parent->child_capacity == 0 ? 16 : parent->child_capacity * 2;
        parent->children = xrealloc(parent->children, next_capacity * sizeof(Node *));
        parent->child_capacity = next_capacity;
    }
    parent->children[parent->child_count++] = child;
}

static void pending_dir_add(PendingDirList *list, Node *node, char *path) {
    if (list->count == list->capacity) {
        size_t next_capacity = list->capacity == 0 ? 16 : list->capacity * 2;
        list->items = xrealloc(list->items, next_capacity * sizeof(PendingDir));
        list->capacity = next_capacity;
    }
    list->items[list->count].node = node;
    list->items[list->count].path = path;
    list->count++;
}

static void free_node(Node *node) {
    if (!node) {
        return;
    }
    for (size_t i = 0; i < node->child_count; i++) {
        free_node(node->children[i]);
    }
    free(node->children);
    free(node->name);
    free(node);
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
            ",\"filesScanned\":%llu,\"directoriesScanned\":%llu,\"bytesDiscovered\":%llu}\n",
            (unsigned long long)g_stats.files_scanned,
            (unsigned long long)g_stats.directories_scanned,
            (unsigned long long)g_stats.bytes_discovered);
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

    if (returned.commonattr & ATTR_CMN_OBJTYPE) {
        attrs.type = read_obj_type(field);
        field += sizeof(fsobj_type_t);
    }

    if (returned.commonattr & ATTR_CMN_FLAGS) {
        attrs.flags = read_u32(field);
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
    }

    return attrs;
}

static void scan_directory_fd(Node *dir_node,
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
                           ATTR_CMN_OBJTYPE |
                           ATTR_CMN_FLAGS;
    attr_list.fileattr = ATTR_FILE_TOTALSIZE |
                         ATTR_FILE_ALLOCSIZE |
                         ATTR_FILE_DATALENGTH |
                         ATTR_FILE_DATAALLOCSIZE;

    g_stats.directories_scanned++;
    emit_progress(dir_path, false);

    PendingDirList pending_dirs = {0};

    for (;;) {
        int count = getattrlistbulk(dir_fd, &attr_list, attr_buffer, attr_buffer_size, 0);
        if (count == 0) {
            break;
        }
        if (count < 0) {
            if (errno == EACCES || errno == EPERM || errno == ENOENT || errno == ESTALE) {
                break;
            }
            break;
        }

        char *entry = attr_buffer;
        for (int i = 0; i < count; i++) {
            uint32_t entry_length = read_u32(entry);
            if (entry_length == 0) {
                break;
            }

            EntryAttrs attrs = parse_entry_attrs(entry);
            entry += entry_length;

            if (attrs.error != 0 || !attrs.name || attrs.name[0] == '\0') {
                continue;
            }
            if (strcmp(attrs.name, ".") == 0 || strcmp(attrs.name, "..") == 0) {
                continue;
            }
            if (attrs.type == VLNK) {
                continue;
            }

            if (attrs.type == VREG) {
                uint64_t size = entry_size_bytes(&attrs);
                Node *file = node_create(attrs.name, NODE_FILE, size);
                file->cloud_only = (attrs.flags & SF_DATALESS) != 0;
                node_add_child(dir_node, file);
                dir_node->size += size;
                dir_node->direct_file_size += size;
                dir_node->file_count++;
                g_stats.files_scanned++;
                g_stats.bytes_discovered += size;
                emit_progress(dir_path, false);
            } else if (attrs.type == VDIR) {
                char *child_path = join_path(dir_path, attrs.name);
                if (should_skip_directory(root_path, child_path, attrs.name, options)) {
                    free(child_path);
                    continue;
                }
                Node *child_dir = node_create(attrs.name, NODE_DIRECTORY, 0);
                node_add_child(dir_node, child_dir);
                pending_dir_add(&pending_dirs, child_dir, child_path);
                emit_progress(dir_path, false);
            }
        }
    }

    for (size_t i = 0; i < pending_dirs.count; i++) {
        int child_fd = open(pending_dirs.items[i].path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW, 0);
        if (child_fd >= 0) {
            scan_directory_fd(pending_dirs.items[i].node,
                              root_path,
                              pending_dirs.items[i].path,
                              child_fd,
                              attr_buffer,
                              attr_buffer_size,
                              options);
            close(child_fd);
        }
        dir_node->size += pending_dirs.items[i].node->size;
        dir_node->file_count += pending_dirs.items[i].node->file_count;
        dir_node->directory_count += pending_dirs.items[i].node->directory_count + 1;
        free(pending_dirs.items[i].path);
    }
    free(pending_dirs.items);
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

static uint64_t direct_file_count(const Node *node) {
    uint64_t count = 0;
    for (size_t i = 0; i < node->child_count; i++) {
        if (node->children[i]->type == NODE_FILE) {
            count++;
        }
    }
    return count;
}

static uint64_t direct_directory_count(const Node *node) {
    uint64_t count = 0;
    for (size_t i = 0; i < node->child_count; i++) {
        if (node->children[i]->type == NODE_DIRECTORY) {
            count++;
        }
    }
    return count;
}

static sqlite3_int64 database_insert_directory(sqlite3 *database,
                                               sqlite3_stmt *directory_statement,
                                               sqlite3_stmt *file_statement,
                                               Node *node,
                                               const char *path,
                                               sqlite3_int64 parent_id,
                                               bool has_parent,
                                               sqlite3_int64 root_branch_id,
                                               bool use_self_as_root_branch) {
    emit_progress(path, false);
    sqlite3_reset(directory_statement);
    sqlite3_clear_bindings(directory_statement);
    if (has_parent) {
        sqlite3_bind_int64(directory_statement, 1, parent_id);
    } else {
        sqlite3_bind_null(directory_statement, 1);
    }
    sqlite3_bind_text(directory_statement, 2, node->name, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(directory_statement, 3, path, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(directory_statement, 4, (sqlite3_int64)node->size);
    sqlite3_bind_int64(directory_statement, 5, (sqlite3_int64)node->direct_file_size);
    sqlite3_bind_int64(directory_statement, 6, (sqlite3_int64)node->file_count);
    sqlite3_bind_int64(directory_statement, 7, (sqlite3_int64)node->directory_count);
    sqlite3_bind_int64(directory_statement, 8, (sqlite3_int64)direct_file_count(node));
    sqlite3_bind_int64(directory_statement, 9, (sqlite3_int64)direct_directory_count(node));
    if (sqlite3_step(directory_statement) != SQLITE_DONE) {
        sqlite_fail(database, "could not index directory");
    }
    sqlite3_int64 directory_id = sqlite3_last_insert_rowid(database);
    sqlite3_int64 effective_root_branch_id = use_self_as_root_branch
        ? directory_id
        : root_branch_id;

    for (size_t i = 0; i < node->child_count; i++) {
        Node *child = node->children[i];
        if (!child || child->type != NODE_DIRECTORY) {
            continue;
        }
        char *child_path = join_path(path, child->name);
        database_insert_directory(database,
                                  directory_statement,
                                  file_statement,
                                  child,
                                  child_path,
                                  directory_id,
                                  true,
                                  effective_root_branch_id,
                                  !has_parent);
        free(child_path);
        free_node(child);
        node->children[i] = NULL;
    }

    for (size_t i = 0; i < node->child_count; i++) {
        Node *child = node->children[i];
        if (!child || child->type != NODE_FILE) {
            continue;
        }
        sqlite3_reset(file_statement);
        sqlite3_clear_bindings(file_statement);
        sqlite3_bind_int64(file_statement, 1, directory_id);
        sqlite3_bind_text(file_statement, 2, child->name, -1, SQLITE_TRANSIENT);
        char *file_path = join_path(path, child->name);
        sqlite3_bind_text(file_statement, 3, file_path, -1, SQLITE_TRANSIENT);
        sqlite3_bind_int64(file_statement, 4, (sqlite3_int64)child->size);
        sqlite3_bind_int(file_statement, 5, child->cloud_only);
        if (has_parent || use_self_as_root_branch) {
            sqlite3_bind_int64(file_statement, 6, effective_root_branch_id);
        } else {
            sqlite3_bind_null(file_statement, 6);
        }
        if (sqlite3_step(file_statement) != SQLITE_DONE) {
            free(file_path);
            sqlite_fail(database, "could not index file");
        }
        free(file_path);
        free_node(child);
        node->children[i] = NULL;
    }

    return directory_id;
}

static void write_scan_database(const char *database_path, Node *root, const char *root_path) {
    sqlite3 *database = NULL;
    sqlite3_stmt *directory_statement = NULL;
    sqlite3_stmt *file_statement = NULL;
    sqlite3_stmt *metadata_statement = NULL;

    unlink(database_path);
    if (sqlite3_open_v2(database_path,
                        &database,
                        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE,
                        NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not create scan database");
    }

    sqlite_exec_checked(database,
                        "PRAGMA journal_mode=OFF;"
                        "PRAGMA synchronous=OFF;"
                        "PRAGMA temp_store=FILE;"
                        "PRAGMA cache_size=-65536;"
                        "PRAGMA locking_mode=EXCLUSIVE;"
                        "CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);"
                        "CREATE TABLE directories("
                        "id INTEGER PRIMARY KEY,"
                        "parent_id INTEGER,"
                        "name TEXT NOT NULL,"
                        "path TEXT NOT NULL UNIQUE,"
                        "size INTEGER NOT NULL,"
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
                        "size INTEGER NOT NULL,"
                        "cloud_only INTEGER NOT NULL DEFAULT 0,"
                        "root_branch_id INTEGER"
                        ");"
                        "BEGIN IMMEDIATE;",
                        "could not initialize scan database");

    const char *directory_sql =
        "INSERT INTO directories("
        "parent_id,name,path,size,direct_file_size,file_count,directory_count,"
        "direct_file_count,direct_directory_count"
        ") VALUES(?,?,?,?,?,?,?,?,?)";
    const char *file_sql =
        "INSERT INTO files(parent_id,name,path,size,cloud_only,root_branch_id) "
        "VALUES(?,?,?,?,?,?)";
    const char *metadata_sql = "INSERT INTO metadata(key,value) VALUES(?,?)";
    if (sqlite3_prepare_v2(database, directory_sql, -1, &directory_statement, NULL) != SQLITE_OK ||
        sqlite3_prepare_v2(database, file_sql, -1, &file_statement, NULL) != SQLITE_OK ||
        sqlite3_prepare_v2(database, metadata_sql, -1, &metadata_statement, NULL) != SQLITE_OK) {
        sqlite_fail(database, "could not prepare scan database");
    }

    database_insert_directory(database,
                              directory_statement,
                              file_statement,
                              root,
                              root_path,
                              0,
                              false,
                              0,
                              false);

    const char *metadata[][2] = {
        {"schema_version", "3"},
        {"root_path", root_path}
    };
    for (size_t i = 0; i < sizeof(metadata) / sizeof(metadata[0]); i++) {
        sqlite3_reset(metadata_statement);
        sqlite3_clear_bindings(metadata_statement);
        sqlite3_bind_text(metadata_statement, 1, metadata[i][0], -1, SQLITE_STATIC);
        sqlite3_bind_text(metadata_statement, 2, metadata[i][1], -1, SQLITE_TRANSIENT);
        if (sqlite3_step(metadata_statement) != SQLITE_DONE) {
            sqlite_fail(database, "could not write scan metadata");
        }
    }

    sqlite3_finalize(metadata_statement);
    sqlite3_finalize(file_statement);
    sqlite3_finalize(directory_statement);
    sqlite_exec_checked(database,
                        "COMMIT;"
                        "CREATE INDEX directories_parent_size ON directories(parent_id,size DESC);"
                        "CREATE INDEX files_parent_size ON files(parent_id,size DESC);"
                        "CREATE INDEX files_size ON files(size DESC);"
                        "CREATE INDEX files_root_branch_size ON files(root_branch_id,size DESC);"
                        "CREATE TABLE largest_files("
                        "scope TEXT NOT NULL,"
                        "root_branch_id INTEGER,"
                        "rank INTEGER NOT NULL,"
                        "name TEXT NOT NULL,"
                        "path TEXT NOT NULL,"
                        "size INTEGER NOT NULL,"
                        "cloud_only INTEGER NOT NULL"
                        ");"
                        "INSERT INTO largest_files(scope,root_branch_id,rank,name,path,size,cloud_only) "
                        "SELECT 'global',NULL,ROW_NUMBER() OVER (ORDER BY size DESC,name),"
                        "name,path,size,cloud_only FROM files ORDER BY size DESC,name LIMIT 10;"
                        "INSERT INTO largest_files(scope,root_branch_id,rank,name,path,size,cloud_only) "
                        "SELECT 'branch',root_branch_id,rank,name,path,size,cloud_only FROM ("
                        "SELECT root_branch_id,name,path,size,cloud_only,"
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
    sqlite3_close(database);
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
    row.direct_file_size = (uint64_t)sqlite3_column_int64(statement, 5);
    row.file_count = (uint64_t)sqlite3_column_int64(statement, 6);
    row.directory_count = (uint64_t)sqlite3_column_int64(statement, 7);
    row.direct_file_count = (uint64_t)sqlite3_column_int64(statement, 8);
    row.direct_directory_count = (uint64_t)sqlite3_column_int64(statement, 9);
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
             "SELECT id,parent_id,name,path,size,direct_file_size,file_count,directory_count,"
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
        "SELECT id,parent_id,name,path,size,direct_file_size,file_count,directory_count,"
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
            ",\"size\":%llu,\"type\":\"directory\",\"fileCount\":%llu,"
            "\"subdirCount\":%llu,\"itemCount\":%llu,\"hasChildren\":%s",
            (unsigned long long)row->size,
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
                            bool cloud_only) {
    fputs("{\"name\":", out);
    json_write_escaped(out, name);
    fputs(",\"path\":", out);
    json_write_escaped(out, path);
    fprintf(out,
            ",\"size\":%llu,\"type\":\"file\",\"cloudOnly\":%s}",
            (unsigned long long)size,
            cloud_only ? "true" : "false");
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
        "SELECT name,size,cloud_only FROM files WHERE parent_id=? ORDER BY size DESC,name LIMIT ?";
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
        bool cloud_only = sqlite3_column_int(files, 2) != 0;
        char *file_path = join_path(parent->path, name);
        if (needs_comma) {
            fputc(',', out);
        }
        write_file_json(out, name, file_path, size, cloud_only);
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
    if (omitted_directories > 0 && omitted_directory_size > 0) {
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
    if (omitted_files > 0 && omitted_file_size > 0) {
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
        "SELECT name,path,size,cloud_only FROM largest_files "
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
                        sqlite3_column_int(global, 3) != 0);
        needs_comma = true;
    }
    sqlite3_finalize(global);

    sqlite3_stmt *branches = NULL;
    const char *branch_sql =
        "SELECT d.id,d.name,d.path,s.file_count,s.file_size,"
        "lf.rank,lf.name,lf.path,lf.size,lf.cloud_only "
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
                            sqlite3_column_int(branches, 9) != 0);
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

    g_last_progress_ms = now_ms();
    Node *root = node_create(root_display_name(root_path), NODE_DIRECTORY, 0);
    emit_progress(root_path, true);
    scan_directory_fd(root, root_path, root_path, root_fd, attr_buffer, ATTR_BUFFER_SIZE, &options);
    close(root_fd);

    emit_progress(root_path, true);
    write_scan_database(options.database_path, root, root_path);
    fputs("{\"rootPath\":", stdout);
    json_write_escaped(stdout, root_path);
    fprintf(stdout,
            ",\"size\":%llu,\"filesScanned\":%llu,\"directoriesScanned\":%llu}\n",
            (unsigned long long)root->size,
            (unsigned long long)g_stats.files_scanned,
            (unsigned long long)g_stats.directories_scanned);
    fflush(stdout);

    free_node(root);
    free(attr_buffer);
    free(root_path);
    return 0;
}

int main(int argc, char **argv) {
    if (argc >= 4 && strcmp(argv[1], "--query") == 0) {
        query_database(argv[2], argv[3]);
        return 0;
    }
    return scan_mode(argc, argv);
}
