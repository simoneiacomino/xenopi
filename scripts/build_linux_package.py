#!/usr/bin/env python3
"""Build the standalone Linux x86_64 package from a locked npm tree and Node bundle."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

from release_version import validate_package_version

ROOT = Path(__file__).resolve().parents[1]


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(argv, **kwargs):
    return subprocess.check_output(list(map(str, argv)), text=True, **kwargs).strip()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--node-dir', type=Path, required=True, help='Full extracted official Linux x64 Node >=26 bundle, including LICENSE')
    p.add_argument('--output', type=Path, required=True, help='New or empty output directory outside this checkout')
    p.add_argument('--package-version', help='Must equal package.json; never relabels prebuilt JavaScript')
    args = p.parse_args()
    metadata = json.loads((ROOT / 'package.json').read_text())
    version = metadata['version']
    try:
        validate_package_version(version)
    except ValueError as error:
        p.error(str(error))
    if args.package_version and args.package_version != version:
        p.error('--package-version must match the tracked package.json version')
    node = args.node_dir.resolve(strict=True)
    out = args.output.resolve()
    if out == ROOT or out.is_relative_to(ROOT):
        p.error('--output must be outside this checkout')
    if out.exists() and any(out.iterdir()):
        p.error('--output must be empty; preserve previous candidates separately')
    if not (node / 'LICENSE').is_file():
        p.error('the complete Node distribution and LICENSE are required')
    node_version = run([node / 'bin/node', '--version'])
    if int(node_version.lstrip('v').split('.')[0]) < 26:
        p.error('Node >=26 is required')
    target = run([node / 'bin/node', '-p', 'process.platform + "-" + process.arch'])
    if target != 'linux-x64':
        p.error('this builder supports linux-x64 only')
    lock = json.loads((ROOT / 'package-lock.json').read_text())
    if lock['packages']['']['dependencies'] != metadata['dependencies']:
        p.error('package-lock root dependencies differ; run npm ci from the committed lockfile')
    for name, item in lock['packages'].items():
        if not name or item.get('dev'):
            continue
        installed = ROOT / name / 'package.json'
        if not installed.exists() and item.get('optional'):
            continue
        if not installed.exists() or json.loads(installed.read_text()).get('version') != item.get('version'):
            p.error(f'locked production dependency mismatch: {name}; run npm ci --ignore-scripts')
    out.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, 'PATH': str(node / 'bin') + os.pathsep + os.environ['PATH'],
           'npm_config_cache': str(out / 'npm-cache'), 'npm_config_offline': 'true', 'npm_config_audit': 'false', 'npm_config_fund': 'false'}
    # npm's bundleDependencies selects the production closure; npm pack runs the
    # ordinary prepack build, so generated output cannot silently be stale.
    run(['npm', 'pack', '--pack-destination', out, '--offline'], cwd=ROOT, env=env)
    npm_archive = out / f'xenopi-{version}.tgz'
    unpack = out / 'npm-unpacked'
    unpack.mkdir()
    with tarfile.open(npm_archive) as archive:
        archive.extractall(unpack, filter='data')
    stage = out / 'package'
    app = stage / 'lib/xenopi'
    shutil.copytree(unpack / 'package', app, symlinks=False)
    shutil.copytree(node, stage / 'node', symlinks=False)
    (stage / 'bin').mkdir()
    launcher = stage / 'bin/xenopi'
    launcher.write_text('''#!/bin/sh
set -eu
entry=$(readlink -f -- "$0")
root=$(CDPATH= cd -- "$(dirname -- "$entry")/.." && pwd)
exec "$root/node/bin/node" "$root/lib/xenopi/dist/src/bin/xenopi.js" "$@"
''')
    launcher.chmod(0o755)
    if (app / 'node_modules/typescript').exists():
        raise ValueError('development dependency unexpectedly included')
    commit = run(['git', '-C', ROOT, 'rev-parse', 'HEAD'])
    epoch = int(os.environ.get('SOURCE_DATE_EPOCH', run(['git', '-C', ROOT, 'show', '-s', '--format=%ct', 'HEAD'])))
    archive_path = out / f'xenopi-{version}-linux-x86_64.tar.gz'
    # Canonical order/ownership/time make repeated builds of identical inputs
    # comparable; gzip timestamps do not depend on the operator's clock.
    with archive_path.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=epoch) as gz, tarfile.open(fileobj=gz, mode='w') as archive:
        for path in sorted(stage.rglob('*')):
            if path.is_symlink() or not (path.is_dir() or path.is_file()):
                raise ValueError(f'unsupported package entry: {path}')
            info = archive.gettarinfo(str(path), str(path.relative_to(stage)))
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.mtime = epoch
            if path.is_file():
                with path.open('rb') as stream:
                    archive.addfile(info, stream)
            else:
                archive.addfile(info)
    node_manifest = {str(path.relative_to(node)): sha(path) for path in sorted(node.rglob('*')) if path.is_file()}
    (out / 'node-input-manifest.json').write_text(json.dumps(node_manifest, sort_keys=True, indent=2) + '\n')
    provenance = {'schema_version': 1, 'baseGitCommit': commit, 'derivedPackageVersion': version,
                  'target': 'x86_64-unknown-linux-gnu', 'sourceDateEpoch': epoch,
                  'sourceDirty': bool(run(['git', '-C', ROOT, 'status', '--porcelain'])),
                  'packageLockSha256': sha(ROOT / 'package-lock.json'),
                  'nodeVersion': node_version, 'nodeBinarySha256': sha(node / 'bin/node'),
                  'nodeLicenseSha256': sha(node / 'LICENSE'),
                  'nodeInputManifestSha256': sha(out / 'node-input-manifest.json'),
                  'nodeOriginVerification': 'caller-supplied extracted bundle; release workflow checks official archive SHA256', 'archiveSha256': sha(archive_path),
                  'builderSha256': sha(Path(__file__)), 'build': 'npm pack --offline (prepack build and production bundles)'}
    (out / 'xenopi-release-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    (out / 'SHA256SUMS').write_text(f'{sha(archive_path)}  {archive_path.name}\n')
    print(archive_path)


if __name__ == '__main__':
    main()
