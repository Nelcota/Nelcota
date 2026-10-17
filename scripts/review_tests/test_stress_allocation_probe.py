"""Native known-allocation controls for the optional glibc diagnostic observer."""
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = r'''
#define _DEFAULT_SOURCE
#include <stdlib.h>
#include <unistd.h>
static volatile unsigned char *held;
int main(void) {
    usleep(350000);
    held = malloc(64 * 1024 * 1024);
    if (!held) return 2;
    for (size_t index=0; index<64*1024*1024; index+=4096) held[index]=1;
    usleep(350000);
    free((void *)held);
    held = NULL;
    usleep(350000);
    return 0;
}
'''

WORKER_FIXTURE = r'''
#define _DEFAULT_SOURCE
#include <malloc.h>
#include <pthread.h>
#include <stdlib.h>
#include <unistd.h>
static void *allocate_in_worker(void *unused) {
    (void)unused;
    void *held[32];
    for (size_t index=0; index<32; index++) {
        held[index] = malloc(1024 * 1024);
        if (!held[index]) _exit(2);
        volatile unsigned char *bytes = held[index];
        for (size_t offset=0; offset<1024*1024; offset+=4096) bytes[offset]=1;
    }
    usleep(350000);
    for (size_t index=0; index<32; index++) free(held[index]);
    usleep(350000);
    return NULL;
}
int main(void) {
    /* Only the control changes this threshold, never the application. */
    if (!mallopt(M_MMAP_THRESHOLD, 4 * 1024 * 1024)) return 2;
    usleep(350000);
    pthread_t worker;
    if (pthread_create(&worker, NULL, allocate_in_worker, NULL)) return 2;
    if (pthread_join(worker, NULL)) return 2;
    return 0;
}
'''


@unittest.skipUnless(platform.system()=='Linux' and platform.libc_ver()[0]=='glibc' and shutil.which('cc'), 'Native glibc/cc diagnostic is unavailable')
class NativeAllocationObserver(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.library = cls.root/'libg05alloc.so'
        cls.executable = cls.root/'nelcota'
        (cls.root/'worker').mkdir()
        cls.worker_executable = cls.root/'worker/nelcota'
        fixture = cls.root/'fixture.c'
        fixture.write_text(FIXTURE)
        worker_fixture = cls.root/'worker.c'
        worker_fixture.write_text(WORKER_FIXTURE)
        for arguments in [
            ['-std=c11','-O2','-Wall','-Wextra','-Werror','-shared','-fPIC','-pthread',str(ROOT/'bench/allocation_probe.c'),'-o',str(cls.library)],
            ['-std=c11','-O2','-Wall','-Wextra','-Werror',str(fixture),'-o',str(cls.executable)],
            ['-std=c11','-O2','-Wall','-Wextra','-Werror','-pthread',str(worker_fixture),'-o',str(cls.worker_executable)],
        ]:
            subprocess.run(['cc',*arguments],check=True,capture_output=True,text=True,timeout=15)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def invoke(self, directory, executable=None, period='100'):
        environment={**os.environ,'LD_PRELOAD':str(self.library),'NELCOTA_G05_ALLOC_DIR':str(directory),'NELCOTA_G05_ALLOC_PERIOD_MS':period}
        subprocess.run([str(executable or self.executable)],env=environment,check=True,capture_output=True,timeout=5)

    def test_known_malloc_and_free_are_visible_without_inventing_live_bytes(self):
        with tempfile.TemporaryDirectory(dir=self.root) as temporary:
            root=Path(temporary)
            self.invoke(root)
            files=list(root.glob('alloc-*.jsonl'))
            self.assertEqual(len(files),1)
            self.assertEqual(stat.S_IMODE(files[0].stat().st_mode),0o600)
            body=files[0].read_text()
            self.assertTrue(body.endswith('\n'))
            values=[json.loads(line) for line in body.splitlines()]
            self.assertGreaterEqual(len(values),6)
            used=[row['in_use_including_mmap_bytes'] for row in values]
            self.assertGreaterEqual(max(used)-used[0],60*1024*1024)
            self.assertLess(used[-1],used[0]+1024*1024)
            self.assertTrue(all(row['schema']==1 and all(isinstance(value,int) and value>=0 for value in row.values()) for row in values))

    def test_inherited_env_cannot_start_observers_in_docker_exec_helpers(self):
        with tempfile.TemporaryDirectory(dir=self.root) as temporary:
            helper=self.root/'helper'
            shutil.copyfile(self.executable,helper)
            helper.chmod(0o700)
            self.invoke(Path(temporary),helper)
            self.assertEqual(list(Path(temporary).iterdir()),[])

    def test_secondary_worker_arena_is_measured_and_released(self):
        with tempfile.TemporaryDirectory(dir=self.root) as temporary:
            root=Path(temporary)
            self.invoke(root,self.worker_executable)
            files=list(root.glob('alloc-*.jsonl'))
            self.assertEqual(len(files),1)
            values=[json.loads(line) for line in files[0].read_text().splitlines()]
            self.assertGreaterEqual(len(values),6)
            used=[row['in_use_including_mmap_bytes'] for row in values]
            arenas=[row['arena_bytes'] for row in values]
            mapped=[row['mmap_bytes'] for row in values]
            self.assertGreaterEqual(max(used)-used[0],30*1024*1024)
            self.assertGreaterEqual(max(arenas)-arenas[0],30*1024*1024)
            self.assertLess(max(mapped)-mapped[0],1024*1024)
            self.assertLess(used[-1],used[0]+1024*1024)

    def test_group_writable_diagnostic_directory_is_refused(self):
        with tempfile.TemporaryDirectory(dir=self.root) as temporary:
            root=Path(temporary)
            root.chmod(0o770)
            self.invoke(root)
            self.assertEqual(list(root.iterdir()),[])

    def test_symlink_directory_cannot_redirect_the_diagnostic_writer(self):
        with tempfile.TemporaryDirectory(dir=self.root) as temporary:
            root=Path(temporary)
            private=root/'private'
            private.mkdir(mode=0o700)
            alias=root/'alias'
            alias.symlink_to(private,target_is_directory=True)
            self.invoke(alias)
            self.assertEqual(list(private.iterdir()),[])

    def test_invalid_or_nonfinite_sampling_period_cannot_start_an_observer(self):
        with tempfile.TemporaryDirectory(dir=self.root) as temporary:
            root=Path(temporary)
            self.invoke(root,period='NaN')
            self.assertEqual(list(root.iterdir()),[])


if __name__=='__main__':
    unittest.main()
