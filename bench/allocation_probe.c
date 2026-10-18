/* Optional, owned diagnostic preload. Never part of a production artifact.
 * mallinfo2 distinguishes allocator-held free arenas from in-use allocations;
 * its in-use figure can include libc thread caches and is not an object census.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <malloc.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static int sample_fd = -1;
static long period_ms = 5000;
static const size_t maximum_bytes = 1024 * 1024;

static int write_record(const char *buffer, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t written = write(sample_fd, buffer + offset, length - offset);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return -1;
        offset += (size_t)written;
    }
    return 0;
}

static void *observe(void *unused) {
    (void)unused;
    (void)pthread_setname_np(pthread_self(), "g05-alloc");
    size_t total = 0;
    for (size_t index = 0; index < 7200; index++) {
        struct timespec now;
        if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) break;
        struct mallinfo2 stats = mallinfo2();
        if (stats.hblkhd > SIZE_MAX - stats.uordblks) break;
        char line[320];
        int count = snprintf(line, sizeof(line),
            "{\"schema\":1,\"pid\":%ld,\"monotonic_seconds\":%ld,"
            "\"monotonic_nanoseconds\":%ld,\"in_use_including_mmap_bytes\":%zu,"
            "\"free_arena_bytes\":%zu,\"arena_bytes\":%zu,\"mmap_bytes\":%zu}\n",
            (long)getpid(), (long)now.tv_sec, now.tv_nsec,
            stats.uordblks + stats.hblkhd, stats.fordblks, stats.arena, stats.hblkhd);
        if (count <= 0 || (size_t)count >= sizeof(line)) break;
        if ((size_t)count > maximum_bytes - total) break;
        if (write_record(line, (size_t)count) != 0) break;
        total += (size_t)count;
        struct timespec pause = {.tv_sec = period_ms / 1000,
                                 .tv_nsec = (period_ms % 1000) * 1000000};
        while (nanosleep(&pause, &pause) != 0) {
            if (errno == EINTR) continue;
            close(sample_fd);
            return NULL;
        }
    }
    close(sample_fd);
    return NULL;
}

__attribute__((constructor)) static void start_owned_diagnostic(void) {
    const char *directory = getenv("NELCOTA_G05_ALLOC_DIR");
    if (directory == NULL || directory[0] != '/') return;
    /* docker exec helpers inherit container env: never start observers in them. */
    char executable[4096];
    ssize_t size = readlink("/proc/self/exe", executable, sizeof(executable)-1);
    if (size <= 0 || (size_t)size >= sizeof(executable)-1) return;
    executable[size] = '\0';
    const char *name = strrchr(executable, '/');
    if (name == NULL || strcmp(name + 1, "nelcota") != 0) return;
    const char *period = getenv("NELCOTA_G05_ALLOC_PERIOD_MS");
    if (period != NULL) {
        if (period[0] == '\0') return;
        for (const char *character = period; *character; character++) {
            if (*character < '0' || *character > '9') return;
        }
        errno = 0;
        char *end = NULL;
        unsigned long parsed = strtoul(period, &end, 10);
        if (errno || end == NULL || *end || parsed < 100 || parsed > 5000) return;
        period_ms = (long)parsed;
    }
    int parent = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent < 0) return;
    struct stat state;
    if (fstat(parent, &state) != 0 || state.st_uid != geteuid() || (state.st_mode & 0022)) {
        close(parent);
        return;
    }
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        close(parent);
        return;
    }
    char filename[160];
    int count = snprintf(filename, sizeof(filename), "alloc-%ld-%ld-%ld.jsonl",
                         (long)getpid(), (long)now.tv_sec, now.tv_nsec);
    if (count <= 0 || (size_t)count >= sizeof(filename)) {
        close(parent);
        return;
    }
    sample_fd = openat(parent, filename, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    close(parent);
    if (sample_fd < 0) return;
    pthread_attr_t attributes;
    if (pthread_attr_init(&attributes) != 0) {
        close(sample_fd);
        return;
    }
    pthread_t worker;
    int failed = pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
    if (!failed) failed = pthread_attr_setstacksize(&attributes, 128 * 1024);
    if (!failed) failed = pthread_create(&worker, &attributes, observe, NULL);
    pthread_attr_destroy(&attributes);
    if (failed) close(sample_fd);
}
