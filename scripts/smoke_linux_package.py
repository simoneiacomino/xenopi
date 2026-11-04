#!/usr/bin/env python3
"""Extract and launch a standalone archive with no npm install or engine."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('archive', type=Path)
a = p.parse_args()
with tempfile.TemporaryDirectory(prefix='xenopi standalone offline ') as temp:
    root = Path(temp)
    package = root / 'package'
    with tarfile.open(a.archive) as archive:
        assert all(m.isfile() or m.isdir() for m in archive), 'archive must contain files/directories only'
        archive.extractall(package, filter='data')
    app = package / 'lib/xenopi'
    metadata = json.loads((app / 'package.json').read_text())
    assert metadata['name'] == 'xenopi'
    assert metadata['bin']['xenopi'] == 'dist/src/bin/xenopi.js'
    assert metadata['piConfig'] == {'name': 'xenopi', 'configDir': '.xenopi'}
    assert metadata['xenolith']['nativeConfig'] == 1
    assert not (app / 'node_modules/typescript').exists()
    assert (package / 'node/LICENSE').is_file()
    fake = root / 'commands'
    fake.mkdir()
    # Any fallback to system Node or package installation fails immediately.
    for name in ('node', 'npm', 'npx', 'xenolith'):
        path = fake / name
        path.write_text('#!/bin/sh\nexit 93\n')
        path.chmod(0o755)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('XENOLITH_', 'XENOPI_', 'PI_', 'XDG_'))}
    env.update(HOME=str(root / 'home'), PATH=str(fake) + ':/usr/bin:/bin',
               XENOLITH_BIN=str(fake / 'xenolith'), XENOLITH_NO_SPAWN='1',
               npm_config_offline='true', HTTP_PROXY='http://127.0.0.1:9', HTTPS_PROXY='http://127.0.0.1:9')
    (root / 'home').mkdir()
    for flag in ('--version', '--help'):
        result = subprocess.run([str(package / 'bin/xenopi'), flag], env=env, cwd=root,
                                text=True, capture_output=True, check=True, timeout=60)
        if flag == '--version':
            assert result.stdout.strip() == metadata['version'], result.stdout
        else:
            assert 'xenopi - AI coding assistant' in result.stdout
    runtime = root / 'home/.xenopi/agent/runtime-package'
    assert (runtime / 'docs/mcp.md').is_file()
    assert (runtime / 'dist/modes/interactive/theme/dark.json').is_file()
    print(f'Offline standalone help/version and Pi assets passed: {metadata["version"]}')
