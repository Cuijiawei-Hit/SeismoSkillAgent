"""Package the authorized public download and a read-only GitHub Pages example.

Only allowlisted source, Auckland inputs, the chosen saved example and the
knowledge release are copied. Developer runtime state and credentials are absent.
"""
from __future__ import annotations
import argparse
from copy import deepcopy
from hashlib import sha256
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import sys
import urllib.request
from zipfile import ZipFile, ZIP_DEFLATED

import export_source

ROOT = Path(__file__).resolve().parents[1]
VERSION = '0.3.1'
SOURCE_SESSION = 'web-20261124-050130-271ae606'
DEMO_ID = 'demo-auckland'
SITE_BASE = '/SeismoSkillAgent/power/demo/'
REPOSITORY = 'Cuijiawei-Hit/SeismoSkillAgent'
RELEASE_URL = f'https://github.com/{REPOSITORY}/releases/download/power-v{VERSION}/PowerSkillAgent-v{VERSION}.zip'


def read(url):
    with urllib.request.urlopen(url, timeout=90) as response:
        return response.read()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')


def portable(value):
    if isinstance(value, dict):
        return {key: portable(item) for key, item in value.items()
                if key not in {'expert_memory', 'experience_memory', 'case_memory', 'feedback_items', 'memory_items'}}
    if isinstance(value, list):
        return [portable(item) for item in value]
    if isinstance(value, str):
        if re.match(r'^[A-Za-z]:[\\/]', value):
            return PureWindowsPath(value).name
        return re.sub(r'[A-Za-z]:[\\/][^\n`<>|]+', lambda m: PureWindowsPath(m[0]).name, value)
    return value


def example(stage, origin):
    target = stage / 'seismo-skill-agent/demo/auckland'
    target.mkdir(parents=True, exist_ok=True)
    views = {}
    for language, suffix in [('en-US', 'en'), ('zh-CN', 'zh')]:
        view = json.loads(read(f'{origin}/api/sessions/{SOURCE_SESSION}?language={language}'))
        allowed = {'engineering_results.docx', 'engineering_results.xlsx', 'power_network.png', 'power_recovery.png', 'power_supply.png'}
        downloads = {}
        for item in [*view.get('artifacts', []), *view.get('session_artifacts', [])]:
            if item['name'] not in allowed or not item.get('url'):
                continue
            name = suffix + '-' + item['name']
            (target / name).write_bytes(read(origin + item['url']))
            downloads[item['url']] = '/demo/auckland/' + name
        def artifacts(items):
            return [{**item, 'index': index, 'url': downloads[item['url']]}
                    for index, item in enumerate(item for item in items if item.get('url') in downloads)]
        view['artifacts'] = artifacts(view.get('artifacts', []))
        for iteration in view.get('iterations', []):
            iteration['artifacts'] = deepcopy(view['artifacts'])
            iteration['expert_decision'] = None
            iteration.pop('result', None)
        view['session_artifacts'] = []
        view['audit_files'] = []
        view['events'] = []
        view['follow_ups'] = []
        view['expert_memory'] = {}
        view['knowledge_usage'] = []
        view['session_id'] = DEMO_ID
        view['is_demo'] = True
        view['historical_read_only'] = False
        view['review'] = None
        view['recovery_attempt'] = None
        view['user_message'] = ('Auckland grid · PGA 0.4g · One repair crew' if suffix == 'en' else '奥克兰电网 · PGA 0.4g · 1 支工程队')
        # Private acceptance comments and reviewer identities are not part of the
        # scientific example. Numerical summaries and saved schedules are retained.
        view = portable(view)
        views[suffix] = view
        write_json(target / f'session.{suffix}.json', view)
    scene = portable(json.loads(read(f'{origin}/api/sessions/{SOURCE_SESSION}/power-scene?iteration=1')))
    write_json(target / 'scene.json', scene)
    write_json(target / 'power-case.json', portable(json.loads(read(origin + '/api/power-case'))))
    for language, suffix in [('en-US', 'en'), ('zh-CN', 'zh')]:
        manifest = json.loads(read(f'{origin}/api/sessions/{SOURCE_SESSION}/reference-figures?iteration=1&language={language}'))
        manifest['session_id'] = DEMO_ID
        for item in manifest['figures']:
            for fmt, url in item['formats'].items():
                name = suffix + '-' + item['figure_id'] + '.' + fmt
                (target / name).write_bytes(read(origin + url))
                item['formats'][fmt] = '/demo/auckland/' + name
        write_json(target / f'figures.{suffix}.json', manifest)
    return views


def prepare(folder, origin):
    stage = folder / 'PowerSkillAgent'
    if stage.exists():
        raise ValueError('Choose a new output directory; existing releases are not overwritten')
    folder.mkdir(parents=True, exist_ok=True)
    source_zip = folder / 'source-review.zip'
    export_source.build_archive(source_zip)
    with ZipFile(source_zip) as archive:
        archive.extractall(folder)
    # This is the full runnable download; the source-review inventory deliberately
    # excludes the additional data and must not be presented as its manifest.
    (stage / 'SOURCE_RELEASE_MANIFEST.json').unlink()
    for relative in ['data/auckland', 'data/parameters']:
        shutil.copytree(ROOT / relative, stage / relative, dirs_exist_ok=True)
    shutil.copytree(ROOT / 'knowledge-base', stage / 'knowledge-base',
                    ignore=shutil.ignore_patterns('migration.json', '*.log', '__pycache__'))
    (stage / 'reproducibility').mkdir(exist_ok=True)
    shutil.copy2(ROOT / 'reproducibility/knowledge.lock.json', stage / 'reproducibility/knowledge.lock.json')
    example(stage, origin)
    # A portable public package contains no workstation state, index rebuild or
    # model credentials. The retained lock verifies every corpus/model/index file.
    print(json.dumps({'stage': str(stage), 'example': DEMO_ID, 'prepared': True}), flush=True)
    return stage


def scan(stage):
    key = os.getenv('DEEPSEEK_API_KEY')
    key_bytes = key.encode() if key else None
    patterns = export_source.SECRET_PATTERNS
    count = 0
    for path in stage.rglob('*'):
        if not path.is_file():
            continue
        relative = path.relative_to(stage).as_posix()
        if any(part in {'.venv', 'runtime', '.git'} for part in path.relative_to(stage).parts):
            raise ValueError('Runtime or private checkout file in release: ' + relative)
        data = path.read_bytes()
        if (key_bytes and key_bytes in data) or any(pattern.search(data) for pattern in patterns):
            raise ValueError('Credential pattern found; release withheld: ' + relative)
        if path.suffix in {'.xlsx', '.docx'}:
            with ZipFile(path) as archive:
                for name in archive.namelist():
                    if name.endswith(('.xml', '.rels')):
                        item = archive.read(name)
                        if key_bytes and key_bytes in item:
                            raise ValueError('Credential found in document; release withheld: ' + relative)
        count += 1
    return count


def finalize(folder):
    stage = folder / 'PowerSkillAgent'
    count = scan(stage)
    records = [{'path': p.relative_to(stage).as_posix(), 'size_bytes': p.stat().st_size,
                'sha256': sha256(p.read_bytes()).hexdigest()} for p in sorted(stage.rglob('*')) if p.is_file()]
    manifest = {'version': VERSION, 'default_example': DEMO_ID, 'default_language': 'en-US',
                'credential_scan': 'passed', 'credentials_included': False,
                'knowledge_documents': 87, 'embedding_included': True, 'files': records}
    write_json(stage / 'RELEASE_MANIFEST.json', manifest)
    destination = folder / f'PowerSkillAgent-v{VERSION}.zip'
    with ZipFile(destination, 'x', ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(stage.rglob('*')):
            if path.is_file():
                archive.write(path, 'PowerSkillAgent/' + path.relative_to(stage).as_posix())
    digest = sha256(destination.read_bytes()).hexdigest()
    (folder / 'SHA256SUMS.txt').write_text(digest + '  ' + destination.name + '\n', encoding='utf-8')
    print(json.dumps({'archive': str(destination), 'sha256': digest, 'files_checked': count,
                      'size_bytes': destination.stat().st_size}), flush=True)


def site(folder, repository):
    stage = folder / 'PowerSkillAgent'
    target = repository / 'power/demo'
    target.mkdir(parents=True, exist_ok=True)
    web = stage / 'seismo-skill-agent/src/seismo_skill_agent/web_static'
    for path in web.iterdir():
        if path.is_file() and path.name not in {'power-workbench.js', 'power-workbench.css', 'power-scene.js', 'power-scene.css'}:
            shutil.copy2(path, target / path.name)
    shutil.copytree(web / 'vendor', target / 'vendor', dirs_exist_ok=True)
    index = (target / 'index.html').read_text(encoding='utf-8')
    index = index.replace('href="/', 'href="./').replace('src="/', 'src="./')
    index = index.replace('<script src="./lucide.min.js">', '<script src="./static-example.js"></script>\n  <script src="./lucide.min.js">')
    index = index.replace('<body class="power-home">', '<body class="power-home">\n<div class="example-banner">Saved Auckland example · No API key required <a href="../#usage">Run locally with your own API</a></div>')
    index = index.replace('</head>', '<style>.example-banner{height:34px;display:flex;justify-content:center;align-items:center;gap:24px;background:#e5f3f0;border-bottom:1px solid #b9d7d4;color:#125461;font:13px system-ui}.example-banner a{color:#125461;font-weight:600}.app-shell{height:calc(100dvh - var(--topbar-height,70px) - 34px)}@media(max-width:700px){.example-banner{font-size:11px;gap:10px}}</style>\n</head>')
    (target / 'index.html').write_text(index, encoding='utf-8')
    # Cesium's script/worker base is an absolute application path in the native
    # runtime. Relocate that path only for this project-site deployment.
    geographic = target / 'vendor/rescity/geographic-sandbox.js'
    content = geographic.read_text(encoding='utf-8').replace('/vendor/rescity/vendor/cesium/', SITE_BASE + 'vendor/rescity/vendor/cesium/')
    geographic.write_text(content, encoding='utf-8')
    example_dir = target / 'example'
    example_dir.mkdir(exist_ok=True)
    for path in (stage / 'seismo-skill-agent/demo/auckland').iterdir():
        if path.suffix == '.json':
            content = path.read_text(encoding='utf-8').replace('/demo/auckland/', SITE_BASE + 'example/')
            (example_dir / path.name).write_text(content, encoding='utf-8')
        else:
            shutil.copy2(path, example_dir / path.name)
    for suffix in ('en', 'zh'):
        view = json.loads((example_dir / f'session.{suffix}.json').read_text(encoding='utf-8'))
        listing = {key: view[key] for key in ('session_id','user_message','preset_id','output_language','status','created_at','updated_at','is_demo')}
        write_json(example_dir / f'sessions.{suffix}.json', {'sessions': [listing]})
    write_json(example_dir / 'health.json', {'status':'ok','api_key_configured':False,'model':'Saved Auckland example',
        'default_demo_session_id':DEMO_ID,'static_demo':True,'suggested_tasks':[],
        'knowledge_index':{'ready':True,'document_count':87,'evidence_available':True,'evidence_status':'bundled_example_evidence'}})
    shutil.copy2(ROOT / 'docs/static-example.js', target / 'static-example.js')
    # Source is independently accessible without making Git history carry the
    # embedding weights or raw city input bundle. Those belong in Release assets.
    source_target = repository / 'platform'
    source_target.mkdir(exist_ok=True)
    with ZipFile(folder / 'source-review.zip') as archive:
        for item in archive.infolist():
            relative = Path(item.filename).relative_to('PowerSkillAgent')
            if str(relative) == 'SOURCE_RELEASE_MANIFEST.json':
                continue
            destination = source_target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(archive.read(item))
    print(json.dumps({'static_example':str(target),'source':str(source_target),'download_url':RELEASE_URL}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare','finalize','site'])
    parser.add_argument('--folder', type=Path, required=True)
    parser.add_argument('--origin', default='http://127.0.0.1:8785')
    parser.add_argument('--repository', type=Path)
    args = parser.parse_args()
    if args.action == 'prepare': prepare(args.folder.resolve(), args.origin.rstrip('/'))
    elif args.action == 'finalize': finalize(args.folder.resolve())
    else: site(args.folder.resolve(), args.repository.resolve())
