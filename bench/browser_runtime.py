"""Stage public browser tooling in owned files, without mounting a real home."""
import hashlib
import importlib.metadata
import importlib.util
import json
import os
import platform
from pathlib import Path
import re
import shutil
import subprocess
import sys
import sysconfig

MAXIMUM_BYTES = 1536*1024*1024


def runtime_target(destination, target):
    root, path = Path(destination).resolve(), Path(target).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError('Browser runtime metadata cannot write outside its owned root')
    return path


def runtime_library(source, roots):
    """Validate the resolved library, including standard ELF loader aliases."""
    resolved = Path(source).resolve(strict=True)
    if not resolved.is_file() or not any(resolved.is_relative_to(Path(root).resolve(strict=True)) for root in roots):
        raise ValueError('Unexpected resolved browser runtime dependency path')
    return resolved


def runtime_dependencies(binaries, roots):
    """Include native dependencies of dlopen modules as well as executables."""
    libraries = set()
    for binary in binaries:
        result = subprocess.run(['ldd', str(binary)], capture_output=True, text=True, timeout=10)
        if result.returncode or 'not found' in result.stdout:
            raise RuntimeError('Native browser dependency closure is incomplete: '+binary.name)
        for name in re.findall(r'(/[^\s()]+)', result.stdout):
            source = Path(name)
            runtime_library(source, roots)
            libraries.add(source)
    return libraries


def prepare(destination, sdk, chrome_executable=None):
    if platform.machine() != 'x86_64':
        raise RuntimeError('The native browser runtime profile is validated only on x86_64')
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError('Preserve an existing browser runtime')
    chrome = Path('/usr/lib/chromium')
    executable_chrome = chrome/'chromium'
    if chrome_executable is not None:
        executable_chrome = Path(chrome_executable).resolve(strict=True)
        chrome = executable_chrome.parent
    python = Path(sys.prefix)
    executable = Path(sys.executable).resolve()
    sdk = Path(sdk).resolve(strict=True)
    if not executable_chrome.is_file() or not os.access(executable_chrome, os.X_OK) or not (sdk/'index.js').is_file():
        raise RuntimeError('Native Chromium and freshly built SDK are required')
    destination.mkdir()
    records = []
    copied = 0
    def copy(source, target):
        nonlocal copied
        target = runtime_target(destination, target)
        source = source.resolve(strict=True)
        if not source.is_file() or source.stat().st_size > 512*1024*1024:
            raise ValueError('Browser runtime input exceeds its file boundary')
        copied += source.stat().st_size
        if copied > MAXIMUM_BYTES:
            raise ValueError('Browser runtime exceeds its 1536-MiB disk budget')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)  # Do not inherit setuid bits or file caps.
        target.chmod(0o444)
        if source.stat().st_mode & 0o111:
            target.chmod(0o555)
        with target.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        records.append({'file':str(target.relative_to(destination)), 'bytes':target.stat().st_size, 'sha256':digest})
    def tree(source, target, exclusions=()):
        for directory, names, files in os.walk(source):
            names[:] = sorted(name for name in names if name not in exclusions and not (Path(directory)/name).is_symlink())
            for name in sorted(files):
                item = Path(directory)/name
                if name in exclusions or name.endswith(('.pyc', '.pyo')) or item.is_symlink():
                    continue
                copy(item, target/item.relative_to(source))
    exclusions = ()
    if executable_chrome.name != 'chromium':
        exclusions = (executable_chrome.name,)
    tree(chrome, destination/'chrome', exclusions)
    if executable_chrome.name != 'chromium':
        copy(executable_chrome, destination/'chrome/chromium')
    copy(executable, destination/'python/bin/python3')
    copy(Path(__file__).with_name('browser_entry.py'), destination/'browser_entry.py')
    stdlib = Path(sysconfig.get_path('stdlib'))
    # This headless Chromium profile does not import Python's separate Tcl/Tk
    # GUI toolkit. Some development Python installs retain its extension while
    # Tcl/Tk itself is absent. All staged mandatory extensions still need ldd.
    unused_extensions = {item.name for item in stdlib.glob('lib-dynload/_tkinter.*')}
    tree(stdlib, destination/'python/lib'/stdlib.name,
         ('site-packages', '__pycache__', 'test', 'tests', 'idlelib', 'ensurepip', 'turtledemo', 'tkinter', *unused_extensions))
    site = destination/'python/lib'/stdlib.name/'site-packages'
    for package in ['playwright', 'pyee', 'greenlet', 'typing_extensions']:
        spec = importlib.util.find_spec(package)
        if spec is None or spec.origin is None:
            raise RuntimeError('A required installed browser dependency is missing')
        source = Path(spec.origin)
        if source.name == '__init__.py':
            tree(source.parent, site/package, ('__pycache__', 'tests', 'test'))
        if source.name != '__init__.py':
            copy(source, site/source.name)
        distribution = importlib.metadata.distribution(package)
        for entry in distribution.files or []:
            if '.dist-info/' in str(entry) and distribution.locate_file(entry).is_file():
                copy(distribution.locate_file(entry), site/entry)
    # Managed Python packages can link this one public executable to the
    # installed Node runtime. Keep generic tree symlinks excluded; stage the
    # known Playwright entrypoint explicitly as immutable bytes.
    node_source = Path(importlib.util.find_spec('playwright').origin).parent/'driver/node'
    node_target = site/'playwright/driver/node'
    if not node_target.is_file():
        copy(node_source, node_target)
    if not os.access(node_target, os.X_OK):
        raise RuntimeError('The staged Playwright driver has no executable entrypoint')
    for item in python.joinpath('lib').glob('libpython*.so*'):
        if item.is_file() and not item.is_symlink():
            copy(item, destination/'python/lib'/item.name)
    for item in sorted(sdk.rglob('*.js')):
        if item.is_symlink() or not item.resolve().is_relative_to(sdk):
            raise ValueError('SDK runtime cannot follow external asset links')
        copy(item, destination/'sdk'/item.relative_to(sdk))
    binaries = [executable_chrome, executable, Path(shutil.which('certutil') or '/missing-certutil'),
                *[item for item in stdlib.glob('lib-dynload/*.so') if item.name not in unused_extensions],
                *[Path(shutil.which(name) or '/missing-tool') for name in ['sh', 'cat', 'ls', 'wc', 'du']]]
    binaries.extend((destination/'python').rglob('node'))
    modules = set()
    for pattern in ['libnss*.so*', 'libsoftokn*.so*', 'libfreebl*.so*']:
        modules.update(Path('/usr/lib/x86_64-linux-gnu').glob(pattern))
    libraries = modules | runtime_dependencies([*binaries, *sorted(modules)], [Path('/lib'), Path('/usr/lib'), python, destination, chrome])
    names = {}
    for library in sorted(libraries):
        resolved = library.resolve(strict=True)
        if library.name in names and names[library.name] != resolved:
            raise ValueError('Ambiguous browser runtime library names')
        if library.name in names:
            continue
        names[library.name] = resolved
        copy(library, destination/'libs'/library.name)
    fonts = Path('/usr/share/fonts/truetype/dejavu')
    for name in ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf', 'DejaVuSansMono.ttf']:
        copy(fonts/name, destination/'fonts'/name)
    font_config = '<?xml version="1.0"?><fontconfig><dir>/runtime/fonts</dir><cachedir>/home/ubuntu/.cache/fontconfig</cachedir></fontconfig>\n'
    (destination/'fonts.conf').write_text(font_config)
    records.append({'file':'fonts.conf', 'bytes':len(font_config.encode()), 'sha256':hashlib.sha256(font_config.encode()).hexdigest()})
    copied += len(font_config.encode())
    if copied > MAXIMUM_BYTES:
        raise ValueError('Browser runtime exceeds its logical payload budget')
    profile = {'kind':'owned development browser tooling, not a production dependency',
               'bytes':copied, 'maximum_bytes':MAXIMUM_BYTES, 'files':len(records),
               'python_version':sys.version.split()[0], 'playwright_version':importlib.metadata.version('playwright'),
               'isolated_python':True, 'explicit_package_directory':str(site.relative_to(destination)),
               'excluded_optional_Python_GUI_modules':['tkinter', '_tkinter'],
               'sdk_assets':len(list((destination/'sdk').rglob('*.js')))}
    manifest = json.dumps({'profile':profile, 'files':records}, sort_keys=True, indent=2)+'\n'
    (destination/'runtime-manifest.json').write_text(manifest)
    profile['manifest_sha256'] = hashlib.sha256(manifest.encode()).hexdigest()
    return profile
