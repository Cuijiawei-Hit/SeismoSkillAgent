from __future__ import annotations

from functools import lru_cache
from hashlib import sha256
import json
from pathlib import Path
from typing import Any
import numpy as np
import pandas as pd

from .schemas import PowerDatasetSource
from .native.assets import branch_properties
from .native.flow import DCPowerFlow

WORKSPACE = Path(__file__).resolve().parents[4]


def _inside_workspace(path: Path) -> Path:
    path = path.expanduser().resolve()
    if not path.is_relative_to(WORKSPACE):
        raise ValueError('电力案例和参数文件须位于独立PowerSkillAgent工作区内。')
    return path


@lru_cache(maxsize=3)
def _read_json(path: str, size: int, modified_ns: int):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def read_json(path: Path) -> dict:
    path = _inside_workspace(Path(path)); stat = path.stat()
    return _read_json(str(path), stat.st_size, stat.st_mtime_ns)


def _sheet(payload, suffix, name=None, index=0):
    book = next((b for b in payload.get('workbooks', []) if b.get('filename', '').replace('\\', '/').endswith(suffix)), None)
    if book is None:
        raise ValueError('缺少工作簿：' + suffix)
    sheets = book.get('sheets', [])
    sheet = next((s for s in sheets if s.get('name') == name), None) if name else sheets[index]
    if sheet is None:
        raise ValueError('缺少工作表：' + str(name))
    return sheet.get('rows', [])


def load_dataset(source: PowerDatasetSource | dict) -> dict[str, Any]:
    source = source if isinstance(source, PowerDatasetSource) else PowerDatasetSource.model_validate(source)
    path = _inside_workspace(source.path)
    payload = read_json(path)
    if payload.get('system') != 'power_system':
        raise ValueError('案例数据不是power_system。')
    bus = np.asarray(_sheet(payload, '1 电力系统基础信息.xlsx', '变电站信息')[1:], dtype=object)
    branch = np.asarray(_sheet(payload, '1 电力系统基础信息.xlsx', '线路信息')[1:], dtype=float)
    gen = np.asarray(_sheet(payload, '1 电力系统基础信息.xlsx', '发电站信息')[1:], dtype=float)
    repair = np.asarray([r[1:6] for r in _sheet(payload, '2 组件修复时间.xlsx')[1:]], dtype=float)
    if repair.shape != (2, 5) or not np.isfinite(repair).all() or (repair < 0).any() or (repair[:, 3:] <= 0).any():
        raise ValueError('修复参数须为节点、线路两行五级非负天数，严重及完全破坏工期须为正。')
    fragility_path = _inside_workspace(source.fragility_path or WORKSPACE / 'data/parameters/电力系统组件地震易损性数据.xlsx')
    criteria_path = _inside_workspace(source.criteria_path or WORKSPACE / 'data/parameters/韧性指标目标值及韧性等级划分.xlsx')
    fragility = pd.read_excel(fragility_path, sheet_name=0, header=None, skiprows=2, usecols='D:K').to_numpy(dtype=float)
    fragility = fragility[~np.isnan(fragility).all(axis=1)]
    try:
        rows = _sheet(payload, '1 电力系统基础信息.xlsx', '支路建模属性')[1:]
    except ValueError:
        rows = None
    kinds, branch_repair = branch_properties(rows, bus, branch, repair)
    flow = DCPowerFlow(bus, gen, branch)
    sidecar = path.with_name('source.json')
    provenance = read_json(sidecar) if sidecar.exists() else {}
    return dict(path=path, source=source, payload=payload, bus=bus, branch=branch, gen=gen,
                repair=repair, fragility=fragility, fragility_path=fragility_path, criteria_path=criteria_path,
                branch_kinds=kinds, branch_repair=branch_repair, explicit_branch_kinds=rows is not None,
                flow=flow, provenance=provenance)


def load_reference(reference) -> dict:
    data = read_json(reference.path)
    if data.get('kind') != 'power_dataset':
        raise ValueError('电力数据产物类型不匹配。')
    dataset = load_dataset(data['dataset_source'])
    digest = sha256(dataset['path'].read_bytes()).hexdigest()
    if digest != data['source_sha256']:
        raise ValueError('冻结城市数据已变化，不能复用旧数据产物。')
    for file, expected in data.get('parameter_sources', {}).items():
        if sha256(_inside_workspace(Path(file)).read_bytes()).hexdigest() != expected:
            raise ValueError('工程参数源文件已变化，不能复用旧数据产物。')
    return dataset


def network(dataset):
    payload = dataset['payload']; geo = payload.get('geospatial', {})
    nodes = []
    geo_nodes = {str(n.get('result_id', n.get('id'))): n for n in geo.get('nodes', [])}
    for row in dataset['bus']:
        identifier = str(int(row[0])); existing = geo_nodes.get(identifier, {})
        nodes.append({**existing, 'id': identifier, 'result_id': identifier,
                      'name': str(row[1]), 'longitude': float(row[3]), 'latitude': float(row[4]),
                      'demand_mw': float(row[5]), 'voltage_kv': float(row[6]), 'type': int(row[2])})
    links = []
    geo_links = {str(e.get('result_id', e.get('id'))): e for e in geo.get('links', [])}
    for row in dataset['branch']:
        identifier = str(int(row[0])); existing = geo_links.get(identifier, {})
        links.append({**existing, 'id': identifier, 'result_id': identifier,
                      'from_node': str(int(row[1])), 'to_node': str(int(row[2])),
                      'reactance_ohm': float(row[3]), 'capacity_mw': float(row[4]), 'voltage_kv': float(row[5])})
    return {'nodes': nodes, 'links': links, 'source': geo.get('source', {}),
            'schema_version': 'engineering.network-map.v1', 'system': 'power_system'}
