#define _DARWIN_C_SOURCE

#include "scanner.h"

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/attr.h>
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

typedef struct EntryAttrs {
    const char *name;
    fsobj_type_t type;
    uint32_t error;
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

static int compare_nodes_by_size_desc(const void *a, const void *b) {
    const Node *left = *(const Node * const *)a;
    const Node *right = *(const Node * const *)b;
    if (left->size < right->size) {
        return 1;
    }
    if (left->size > right->size) {
        return -1;
    }
    return strcmp(left->name, right->name);
}

static void sort_tree(Node *node) {
    if (!node || node->type != NODE_DIRECTORY) {
        return;
    }
    if (node->child_count > 1) {
        qsort(node->children, node->child_count, sizeof(Node *), compare_nodes_by_size_desc);
    }
    for (size_t i = 0; i < node->child_count; i++) {
        sort_tree(node->children[i]);
    }
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
    if (attrs->alloc_size > 0) {
        return attrs->alloc_size;
    }
    if (attrs->data_alloc_size > 0) {
        return attrs->data_alloc_size;
    }
    if (attrs->total_size > 0) {
        return attrs->total_size;
    }
    return attrs->data_length;
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
                           ATTR_CMN_OBJTYPE;
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
                node_add_child(dir_node, file);
                dir_node->size += size;
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
        free(pending_dirs.items[i].path);
    }
    free(pending_dirs.items);
}

static void write_node_json(FILE *out, const Node *node, const char *path) {
    fputs("{\"name\":", out);
    json_write_escaped(out, node->name);
    fputs(",\"path\":", out);
    json_write_escaped(out, path);
    fprintf(out, ",\"size\":%llu,\"type\":\"%s\"",
            (unsigned long long)node->size,
            node->type == NODE_DIRECTORY ? "directory" : "file");

    if (node->type == NODE_DIRECTORY) {
        fputs(",\"children\":[", out);
        for (size_t i = 0; i < node->child_count; i++) {
            if (i > 0) {
                fputc(',', out);
            }
            char *child_path = join_path(path, node->children[i]->name);
            write_node_json(out, node->children[i], child_path);
            free(child_path);
        }
        fputc(']', out);
    }

    fputc('}', out);
}

int main(int argc, char **argv) {
    if (argc < 2) {
        die("usage: scanner <root-path> [--skip-caches] [--skip-external-volumes] [--skip-system-folders]");
    }

    ScanOptions options = {0};
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--skip-caches") == 0) {
            options.skip_caches = 1;
        } else if (strcmp(argv[i], "--skip-external-volumes") == 0) {
            options.skip_external_volumes = 1;
        } else if (strcmp(argv[i], "--skip-system-folders") == 0) {
            options.skip_system_folders = 1;
        } else {
            die("unknown scanner option");
        }
    }

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

    sort_tree(root);
    emit_progress(root_path, true);
    write_node_json(stdout, root, root_path);
    fputc('\n', stdout);
    fflush(stdout);

    free_node(root);
    free(attr_buffer);
    free(root_path);
    return 0;
}
