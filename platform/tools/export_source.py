"""Build a local source-review archive; never upload or publish anything."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import os
from pathlib import Path, PureWindowsPath
import re
import subprocess
import sys
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
MAX_FILE_BYTES = 5 * 1024 * 1024
VENDORED_BROWSER_LIMITS = {'seismo-skill-agent/src/seismo_skill_agent/web_static/vendor/rescity/vendor/cesium/Cesium.js': 8 * 1024 * 1024}
MAX_TOTAL_BYTES = 30 * 1024 * 1024
SUFFIXES = {'.py', '.js', '.css', '.html', '.json', '.toml', '.md', '.txt', '.yaml', '.yml', '.png', '.jpg', '.gif', '.svg', '.woff', '.woff2', '.wasm', '.xml'}
ROOT_FILES = ('.gitignore', 'THIRD_PARTY_NOTICES.md', 'requirements.txt',
              'install-power.ps1', 'start-power.ps1', 'start-power.cmd', 'stop-power.ps1',
              'configure-model.ps1', 'configure-model.cmd')
TOOLS = ('build_knowledge.py', 'export_source.py', 'export_public_release.py')
SKIP_PARTS = {'__pycache__', '.pytest_cache', 'node_modules', '.git', '.venv',
              '.bootstrap-incomplete-environment', 'runtime', 'outputs', 'runs-verification'}
SECRET_PATTERNS = (
    re.compile(rb'(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{24,}'),
    re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    re.compile(rb'(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*[\'"]([A-Za-z0-9._-]{24,})[\'"]'),
)
ABSOLUTE_RUNTIME_PATH = re.compile(r'\bPath\(\s*[\'"][A-Za-z]:[\\/]')


def digest(data: bytes) -> str:
    return sha256(data).hexdigest()


def portable_metadata(value):
    """Keep provenance, replacing only developer-machine path prefixes."""
    if isinstance(value, dict):
        return {key: portable_metadata(item) for key, item in value.items()
                if key not in {'nodes', 'links', 'frames', 'features', 'rows', 'workbooks',
                               'geometry', 'coordinates', 'geometry_by_id', 'feature_by_ref'}}
    if isinstance(value, list):
        return [portable_metadata(item) for item in value]
    if isinstance(value, str) and re.match(r'^[A-Za-z]:[\\/]', value):
        normalized = value.replace('\\', '/')
        for project in ('RescityAgent', 'SeismoSkillAgent', 'PowerSkillAgent'):
            marker = '/' + project + '/'
            if marker in normalized:
                return project + '/' + normalized.split(marker, 1)[1]
        return 'local-file:' + PureWindowsPath(value).name
    return value


def candidates():
    for name in ROOT_FILES:
        path = ROOT / name
        if path.is_file():
            yield path
    yield ROOT / 'docs/opensource.md'
    yield ROOT / 'docs/static-example.js'
    for package in ('engineering-skills', 'seismo-skill-agent'):
        yield ROOT / package / 'pyproject.toml'
        for path in sorted((ROOT / package / 'src').rglob('*')):
            relative = path.relative_to(ROOT)
            if (not path.is_file() or set(relative.parts) & SKIP_PARTS
                    or path.name == 'vendorize.py'
                    or ('healthcare' in relative.parts and ('assets' in relative.parts or 'skills' in relative.parts))):
                continue
            if path.suffix.lower() in SUFFIXES or path.name in {'LICENSE', 'COPYING', 'NOTICE'}:
                yield path
    for name in TOOLS:
        yield ROOT / 'tools' / name
    yield ROOT / 'seismo-skill-agent/examples/auckland_power_context.json'
    # This test runs from synthetic temporary inputs without private case data,
    # source checkouts, model accounts or a downloaded embedding snapshot.
    yield ROOT / 'tests/test_power_knowledge_quality.py'
    yield ROOT / 'tests/test_reference_decision.cjs'
    yield ROOT / 'tests/test_default_language.cjs'
    yield ROOT / 'tests/test_public_bundle.py'


def source_metadata():
    source = ROOT / 'data/auckland/source.json'
    record = json.loads(source.read_text(encoding='utf-8')) if source.exists() else {}
    record.pop('workbooks', None)
    city = ROOT / 'data/auckland/city.json'
    if city.is_file():
        payload = json.loads(city.read_text(encoding='utf-8'))
        record['public_data_provenance'] = {key: payload[key] for key in
            ('provenance', 'power_impact_provenance', 'source_note', 'simulation_assumptions', 'power_damage_model')
            if key in payload}
        record['geospatial_source'] = payload.get('geospatial', {}).get('source')
    record['complete_dataset_included'] = False
    record['distribution_scope'] = 'source metadata and assumptions only; full data requires separate authorization'
    return portable_metadata(record)


def build_archive(destination: Path):
    files: dict[str, bytes] = {}
    transformations: dict[str, str] = {}
    for path in candidates():
        if not path.is_file():
            raise ValueError('Required source file is missing: ' + str(path.relative_to(ROOT)))
        if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
            raise ValueError('Source entry leaves the project: ' + path.name)
        relative = path.relative_to(ROOT).as_posix()
        data = path.read_bytes()
        if relative.endswith('/native/source_manifest.json'):
            data = (json.dumps(portable_metadata(json.loads(data)), ensure_ascii=False, indent=2) + '\n').encode('utf-8')
            transformations[relative] = 'Developer paths replaced with project-relative source labels; source hashes retained.'
        files[relative] = data
    # The workstation README describes an already installed private-data example.
    # A public reviewer receives setup instructions matching the actual archive.
    files['README.md'] = (ROOT / 'docs/opensource.md').read_bytes()
    transformations['README.md'] = 'Generated from docs/opensource.md for the data-excluded review archive.'
    for package in ('engineering-skills', 'seismo-skill-agent'):
        relative = package + '/README.md'
        files[relative] = ('# PowerSkillAgent component\n\nSee the root README for installation, data requirements, source lineage and the pending license decision.\n').encode('utf-8')
        transformations[relative] = 'Portable package readme; historical workstation notes are not part of the source review.'
    files['data/auckland/SOURCE_METADATA.json'] = (json.dumps(source_metadata(), ensure_ascii=False, indent=2) + '\n').encode('utf-8')

    runtime_paths = []
    total = 0
    for name, data in files.items():
        if len(data) > VENDORED_BROWSER_LIMITS.get(name, MAX_FILE_BYTES):
            raise ValueError('Oversized source entry: ' + name)
        total += len(data)
        if any(pattern.search(data) for pattern in SECRET_PATTERNS):
            raise ValueError('Potential credential found; file withheld: ' + name)
        if name.endswith(('.py', '.ps1', '.cmd')):
            text = data.decode('utf-8-sig')
            if ABSOLUTE_RUNTIME_PATH.search(text):
                runtime_paths.append(name)
    if runtime_paths:
        raise ValueError('Hardcoded local runtime paths must be removed: ' + ', '.join(runtime_paths))
    if total > MAX_TOTAL_BYTES:
        raise ValueError('Source review exceeds the bounded source-only size policy')
    records = [{'path': name, 'size_bytes': len(data), 'sha256': digest(data)}
               for name, data in sorted(files.items())]
    manifest = {
        'schema_version': 'power-source-review.v1',
        'created_at': datetime.now(timezone.utc).isoformat(),
        'purpose': 'local source review; no upload or publication performed',
        'project_license': 'not_selected', 'publication_ready': False,
        'file_count': len(records), 'total_uncompressed_bytes': total, 'files': records,
        'transformations': transformations,
        'checks': {'credential_patterns': 'passed', 'absolute_runtime_path_dependencies': 'none detected',
                   'source_only_size_policy': 'passed', 'symlinks': 'excluded'},
        'excluded': ['virtual environments and bootstrap copies', 'runtime, expert memory, sessions and logs',
                     'databases and computed results', 'private or unlicensed knowledge full text and original PDFs/images',
                     'embedding weights and indexes', 'complete city data and parameter workbooks',
                     'local migration and source-checkout verification scripts', 'inactive medical Skills and historical map caches'],
        'limits': {'max_file_bytes': MAX_FILE_BYTES, 'max_total_bytes': MAX_TOTAL_BYTES, 'vendored_browser_limits': VENDORED_BROWSER_LIMITS},
    }
    files['SOURCE_RELEASE_MANIFEST.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, 'x', compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            archive.writestr('PowerSkillAgent/' + name, data)
    with ZipFile(destination) as archive:
        assert archive.testzip() is None
        for entry in records:
            assert digest(archive.read('PowerSkillAgent/' + entry['path'])) == entry['sha256']
    return {'archive': str(destination), 'archive_sha256': digest(destination.read_bytes()),
            'source_files': len(records), 'size_bytes': destination.stat().st_size,
            'uncompressed_bytes': total, 'project_license': 'not_selected', 'publication_ready': False,
            'checks': manifest['checks']}


def verify_extraction(archive_path: Path):
    """Check source imports and pure tests outside the installed checkout.

    The temporary extraction is retained for review. This check neither removes
    files nor starts a server, model request, index build or engineering run.
    """
    folder = Path(tempfile.mkdtemp(prefix='power-source-review-'))
    with ZipFile(archive_path) as archive:
        for name in archive.namelist():
            if not name.startswith('PowerSkillAgent/') or '..' in Path(name).parts:
                raise ValueError('Unexpected archive path')
        archive.extractall(folder)
    release = folder / 'PowerSkillAgent'
    env = os.environ.copy()
    env['PYTHONPATH'] = os.pathsep.join(str(release / package / 'src') for package in ('seismo-skill-agent', 'engineering-skills'))
    env['POWER_WORKSPACE_ROOT'] = str(release)
    env.pop('SEISMO_KNOWLEDGE_LOCK', None)
    check = '''from pathlib import Path
import seismo_skill_agent, engineering_skills
from seismo_skill_agent.web import SessionManager
from engineering_skills.builtin import get_registry
root = Path.cwd()
assert Path(seismo_skill_agent.__file__).is_relative_to(root)
assert Path(engineering_skills.__file__).is_relative_to(root)
get_registry()
print('isolated source imports: passed')
'''
    for arguments in ([sys.executable, '-c', check],
                      [sys.executable, '-m', 'pytest', 'tests/test_power_knowledge_quality.py', '-q']):
        result = subprocess.run(arguments, cwd=release, env=env, text=True, capture_output=True, timeout=90)
        if result.returncode:
            raise RuntimeError('Isolated source check failed: ' + result.stdout[-2500:] + result.stderr[-2500:])
    return {'source_imports': 'passed from extracted archive', 'pure_unit_tests': 3,
            'extraction': str(release), 'engineering_or_model_execution': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='A new local .zip path; existing files are never overwritten')
    parser.add_argument('--verify-extraction', action='store_true', help='Check package imports and pure tests from a separate extraction (requires installed dependencies)')
    args = parser.parse_args()
    stamp = datetime.now(timezone(timedelta(hours=8))).strftime('%Y%m%d-%H%M%S')
    destination = (args.output or ROOT / 'outputs/source-review' / ('powerskillagent-source-review-' + stamp + '.zip')).resolve()
    if destination.suffix.lower() != '.zip':
        parser.error('--output must be a .zip path')
    report = build_archive(destination)
    if args.verify_extraction:
        report['extracted_check'] = verify_extraction(destination)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
