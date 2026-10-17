"""Load only the explicitly staged package directory under isolated Python."""
from pathlib import Path
import runpy
import sys


def staged_site(runtime):
    root=Path(runtime).resolve(strict=True)
    site=root/'python/lib'/f'python{sys.version_info.major}.{sys.version_info.minor}'/'site-packages'
    if not site.is_dir() or site.resolve(strict=True)!=site:
        raise ValueError('The browser package directory must be owned and explicit')
    return site


def launch(runtime, driver):
    if not sys.flags.isolated:
        raise RuntimeError('Browser tooling requires isolated Python')
    sys.path.insert(0,str(staged_site(runtime)))
    runpy.run_path(str(driver),run_name='__main__')


if __name__=='__main__':
    launch('/runtime','/driver.py')
