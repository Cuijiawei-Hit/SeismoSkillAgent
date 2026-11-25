"""Population-conserving spatial exposure from saved electric supply states.

This module does not infer household outages from line colours. It intersects
explicit census support with exclusive service polygons in a local equal-area
projection, then applies saved load-weighted supply fractions. Geometry and
electrical assignment evidence are kept separate. Unknown coverage is never
silently treated as supplied. No network solve or assessment mutation occurs.
"""
from __future__ import annotations

from copy import deepcopy
from collections import OrderedDict
from hashlib import sha256
import json
import math
from threading import Lock

EPS = 1e-9
SCHEMA = "engineering.power-impact.v1"
_SPATIAL_CACHE = OrderedDict()
_SPATIAL_CACHE_LOCK = Lock()
_SPATIAL_CACHE_ESTIMATED_LIMIT = 192 * 1024 * 1024


def _cached_spatial(config):
    """Bounded, content-keyed static geometry reuse across strategy frames.

    Input is frozen by validation on a cache miss. Every returned public result
    is copied below, so callers cannot alter the cache. Cache accounting uses
    four times canonical JSON bytes to budget Python/GEOS coordinate storage.
    """
    try:
        canonical = json.dumps(config, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    except (ValueError, TypeError) as error:
        raise ValueError("配置须为可保存的有限 JSON 数据。") from error
    digest = sha256(canonical).hexdigest()
    estimate = len(canonical) * 4
    with _SPATIAL_CACHE_LOCK:
        cached = _SPATIAL_CACHE.get(digest)
        if cached is not None:
            _SPATIAL_CACHE.move_to_end(digest)
            return cached[1]
    prepared = _prepare_spatial(config)
    if estimate <= _SPATIAL_CACHE_ESTIMATED_LIMIT:
        with _SPATIAL_CACHE_LOCK:
            _SPATIAL_CACHE[digest] = (estimate, prepared)
            while len(_SPATIAL_CACHE) > 2 or sum(value[0] for value in _SPATIAL_CACHE.values()) > _SPATIAL_CACHE_ESTIMATED_LIMIT:
                _SPATIAL_CACHE.popitem(last=False)
    return prepared


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _key(value):
    if type(value) in (int, float) and float(value).is_integer():
        return str(int(value))
    return str(value)


def _libraries():
    # Imports are lazy so other engineering systems do not require a GIS runtime.
    from pyproj import CRS, Transformer
    from shapely.geometry import shape, mapping, Polygon
    from shapely.ops import transform, unary_union
    from shapely.strtree import STRtree
    return CRS, Transformer, shape, mapping, Polygon, transform, unary_union, STRtree


def _polygon(value, label):
    """Validate topology, axis order, finite WGS84 values and bounded complexity."""
    _, _, shape, _, _, _, _, _ = _libraries()
    if not isinstance(value, dict) or value.get("type") not in {"Polygon", "MultiPolygon"}:
        raise ValueError(f"{label}须为 WGS84 GeoJSON Polygon 或 MultiPolygon。")
    coordinates = value.get("coordinates")
    if not isinstance(coordinates, list) or not coordinates:
        raise ValueError(f"{label}须包含非空多边形坐标。")
    polygons = [coordinates] if value["type"] == "Polygon" else coordinates
    count = 0
    for polygon in polygons:
        if not isinstance(polygon, list) or not polygon:
            raise ValueError(f"{label}缺少外环。")
        for ring in polygon:
            if not isinstance(ring, list) or len(ring) < 4:
                raise ValueError(f"{label}坐标环须包含至少四个闭合顶点。")
            for point in ring:
                if (not isinstance(point, (list, tuple)) or len(point) != 2 or
                    not all(_number(v) for v in point) or
                    not -180 <= point[0] <= 180 or not -90 < point[1] < 90):
                    raise ValueError(f"{label}顶点须为有限的 WGS84 [经度,纬度]；不能使用投影坐标。")
            if ring[0] != ring[-1] or len({tuple(p) for p in ring[:-1]}) < 3:
                raise ValueError(f"{label}坐标环须闭合且至少有三个不同顶点。")
            count += len(ring)
            if count > 250000:
                raise ValueError(f"{label}超过 250000 个顶点。")
    geometry = shape(value)
    if geometry.is_empty or not geometry.is_valid or geometry.area <= 0:
        raise ValueError(f"{label}存在自交、无效孔洞或零面积；请修复源几何后重试。")
    if geometry.bounds[2] - geometry.bounds[0] > 180:
        raise ValueError(f"{label}跨越日期变更线；请先拆分为本地研究范围。")
    return geometry


def _rows(config, name, maximum):
    rows = config.get(name)
    if not isinstance(rows, list) or not rows or len(rows) > maximum:
        raise ValueError(f"{name} 须为非空数组，最多 {maximum} 条。")
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"].strip():
            raise ValueError(f"{name} 每条须包含非空字符串 id。")
        if row["id"] in seen:
            raise ValueError(f"{name} 的 id 不能重复。")
        seen.add(row["id"])
    return rows


def validate_config(config):
    """Return a frozen copy; perform full geometric validation before execution."""
    if not isinstance(config, dict):
        raise ValueError("停电影响配置须为对象。")
    if config.get("coordinate_system", "WGS84") not in {"WGS84", "EPSG:4326"}:
        raise ValueError("停电影响输入仅接受 WGS84 / EPSG:4326；请先转换坐标。")
    if config.get("population_allocation", "uniform_area") != "uniform_area":
        raise ValueError("当前人口叠加支持 uniform_area；其他权重需提供分解后的普查网格。")
    if config.get("overlap_policy", "unknown") != "unknown":
        raise ValueError("服务区交叠部分采用 unknown，不按先后顺序武断分配。")
    tolerance = config.get("population_overlap_tolerance_m2", 1e-4)
    if not _number(tolerance) or not 0 <= tolerance <= .02:
        raise ValueError("population_overlap_tolerance_m2 须为 [0,0.02] 平方米内的有限数。")
    coverage_tolerance = config.get("population_coverage_tolerance_m2")
    if coverage_tolerance is not None and (not _number(coverage_tolerance) or not 0 <= coverage_tolerance <= 5):
        raise ValueError("population_coverage_tolerance_m2 须为 [0,5] 平方米内的有限数。")
    services = _rows(config, "service_areas", 20000)
    populations = _rows(config, "population_areas", 50000)
    for row in services:
        _polygon(row.get("geometry"), "供电服务区 " + row["id"])
        ids = row.get("node_ids")
        if (not isinstance(ids, list) or not ids or
            any(type(value) not in (str, int, float) or
                (type(value) in (int, float) and not _number(value)) or
                (isinstance(value, str) and not value.strip()) for value in ids)):
            raise ValueError("服务区 node_ids 须为非空节点编号数组。")
        if len({_key(v) for v in ids}) != len(ids):
            raise ValueError("服务区 node_ids 不能重复。")
        weights = row.get("node_weights")
        if weights is not None:
            if not isinstance(weights, dict) or set(map(_key, weights)) != set(map(_key, ids)):
                raise ValueError("node_weights 须准确覆盖该区 node_ids。")
            if any(not _number(v) or v < 0 for v in weights.values()) or sum(weights.values()) <= 0:
                raise ValueError("node_weights 须为非负有限数，合计大于零。")
        for field in ("geometry_basis", "assignment_basis", "source"):
            if not isinstance(row.get(field), str) or not row[field].strip():
                raise ValueError(f"服务区须分别提供 {field}，区分地理边界、电气关联和来源。")
    for row in populations:
        _polygon(row.get("geometry"), "人口区 " + row["id"])
        if row.get("population") is not None and (not _number(row["population"]) or row["population"] < 0):
            raise ValueError("人口须为非负有限数，缺失须显式为 null。")
        if not isinstance(row.get("source"), str) or not row["source"].strip():
            raise ValueError("人口区须提供 source。")
    if config.get("study_area") is not None:
        _polygon(config["study_area"], "研究范围")
    # Do not carry Python objects, NaN or Infinity into saved results.
    try:
        json.dumps(config, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ValueError("配置须为可保存的有限 JSON 数据。") from error
    return deepcopy(config)


def _projection(geometry):
    CRS, Transformer, _, _, _, _, _, _ = _libraries()
    west, south, east, north = geometry.bounds
    if east - west > 120 or north - south > 80:
        raise ValueError("研究范围过大；请分成地方/区域范围进行等面积人口叠加。")
    center = geometry.representative_point()
    crs = CRS.from_proj4(f"+proj=laea +lat_0={center.y:.10f} +lon_0={center.x:.10f} +datum=WGS84 +units=m +no_defs")
    forward = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    inverse = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    return forward, inverse, crs


def _polygon_only(geometry):
    _, _, _, _, _, _, union, _ = _libraries()
    if geometry.geom_type in {"Polygon", "MultiPolygon"}:
        return geometry
    pieces = [part for part in getattr(geometry, "geoms", [])
              if part.geom_type in {"Polygon", "MultiPolygon"} and part.area > 0]
    return union(pieces)


def _json_geometry(geometry, inverse):
    _, _, _, mapping, _, transform, _, _ = _libraries()
    # JSON roundtrip converts coordinate tuples without rounding away narrow areas.
    return json.loads(json.dumps(mapping(transform(inverse.transform, _polygon_only(geometry)))))


def _load_weight(node):
    props = node.get("properties") or {}
    for value in (node.get("demand_mw"), node.get("load_mw"), props.get("demand_mw"),
                  props.get("负荷(MW)"), props.get("电站负荷(MW)")):
        if _number(value) and value >= 0:
            return float(value)
    return None


def _supply(area, nodes, functions):
    ids = [_key(value) for value in area["node_ids"]]
    missing_nodes = [node for node in ids if node not in nodes]
    if missing_nodes:
        return None, "missing_bound_network_nodes", missing_nodes
    if area.get("node_weights") is not None:
        weights = {_key(key): float(value) for key, value in area["node_weights"].items()}
        basis = "explicit_node_weights_and_saved_supply"
    else:
        weights = {node: _load_weight(nodes[node]) for node in ids}
        basis = "published_node_load_weights_and_saved_supply"
    if any(value is None for value in weights.values()) or sum(weights.values()) <= 0:
        return None, "missing_positive_load_weights", ids
    missing = [node for node in ids if weights[node] > 0 and not _number(functions.get(node))]
    if missing:
        return None, "missing_saved_supply", missing
    values = [functions[node] for node in ids if weights[node] > 0]
    if any(value < -EPS or value > 1 + EPS for value in values):
        raise ValueError("保存的节点供电比例须在 [0,1]；不能把 MW 误作比例。")
    ratio = sum(weights[node] * min(1., max(0., functions[node]))
                for node in ids if weights[node] > 0) / sum(weights.values())
    return ratio, basis, []


def _frames(network, frames):
    rows = frames if frames is not None else network.get("frames")
    if not rows:
        rows = [{"time_hours": 0, "node": {"function": {
            _key(node.get("result_id", node.get("id"))): node.get("function")
            for node in network.get("nodes", [])}}}]
    result, seen = [], set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("保存帧须为对象。")
        time = row.get("time_hours")
        if time is None and _number(row.get("time")):
            unit = row.get("time_unit", "小时")
            if unit not in {"天", "小时", "hours", "days"}:
                raise ValueError("帧时间单位须为小时或天。")
            time = row["time"] * (24 if unit in {"天", "days"} else 1)
        if not _number(time) or time < 0 or time in seen:
            raise ValueError("保存帧时间须非负、有限且不重复。")
        seen.add(time)
        source = (row.get("node") or {}).get("function") or row.get("node_supply_ratios") or {}
        if not isinstance(source, dict):
            raise ValueError("保存帧 node.function 须为供电比例字典。")
        result.append((float(time), {_key(key): value for key, value in source.items()}))
    return sorted(result)


def _prepare_spatial(config):
    config = validate_config(config)
    _, _, _, _, _, transform, union, STRtree = _libraries()
    from shapely.geometry import Polygon
    from shapely.prepared import prep
    services = config["service_areas"]
    population_rows = config["population_areas"]
    service_wgs = [_polygon(row["geometry"], "服务区") for row in services]
    study_wgs = (_polygon(config["study_area"], "研究范围") if config.get("study_area")
                 else union(service_wgs))
    forward, inverse, crs = _projection(study_wgs)
    study = transform(forward.transform, study_wgs)
    prepared_study = prep(study)
    def clip_to_study(geometry):
        if prepared_study.covers(geometry):
            return geometry
        if not prepared_study.intersects(geometry):
            return Polygon()
        return _polygon_only(geometry.intersection(study))
    projected_services = [clip_to_study(transform(forward.transform, geometry)) for geometry in service_wgs]
    service_tree = STRtree(projected_services)
    overlaps = []
    exclusive = []
    for index, geometry in enumerate(projected_services):
        nearby = [int(other) for other in service_tree.query(geometry, predicate="intersects") if int(other) != index]
        intersections = [geometry.intersection(projected_services[other]) for other in nearby]
        positive = [part for part in intersections if part.area > 1e-6]
        overlaps.extend(positive)
        exclusive.append(_polygon_only(geometry.difference(union(positive)) if positive else geometry))
    overlap_geometry = union(overlaps)
    exclusive_union = union(exclusive)
    unmapped_geometry = _polygon_only(study.difference(exclusive_union))
    pop_geometries = [transform(forward.transform, _polygon(row["geometry"], "人口区"))
                      for row in population_rows]
    population_tree = STRtree(pop_geometries)
    population_overlaps = []
    tolerance = config.get("population_overlap_tolerance_m2", 1e-4)
    for index, geometry in enumerate(pop_geometries):
        for other in population_tree.query(geometry, predicate="intersects"):
            other = int(other)
            if other > index:
                shared = geometry.intersection(pop_geometries[other]).area
                if shared > tolerance:
                    raise ValueError("人口区存在内部交叠，可能重复计算同一人口；请使用互斥普查层级或网格。")
                if shared > 1e-12:
                    left, right = population_rows[index], population_rows[other]
                    density_left = left.get("population") / geometry.area if left.get("population") is not None else None
                    density_right = right.get("population") / pop_geometries[other].area if right.get("population") is not None else None
                    bound = shared * (density_left + density_right) if density_left is not None and density_right is not None else None
                    population_overlaps.append(dict(left_id=left["id"], right_id=right["id"], area_m2=shared,
                        potential_population_overlap_upper_bound=bound))
    # Only explicitly permitted sub-centimetric projection seams are normalized.
    # Retain each census record's entire population; its uniform density is
    # renormalized over its mutually exclusive geometry. This avoids both
    # spatial double counting and silently losing source population.
    normalization = []
    if population_overlaps:
        rank = {index: order for order, index in enumerate(sorted(range(len(population_rows)), key=lambda i: population_rows[i]["id"]))}
        originals = list(pop_geometries)
        for index in sorted(range(len(population_rows)), key=lambda i: rank[i]):
            geometry = originals[index]
            prior = [int(other) for other in population_tree.query(geometry, predicate="intersects")
                     if rank[int(other)] < rank[index]]
            if not prior:
                continue
            normalized = _polygon_only(geometry.difference(union([originals[other] for other in prior])))
            removed = max(0., geometry.area-normalized.area)
            if removed <= 1e-12:
                continue
            if normalized.is_empty or normalized.area <= 0:
                raise ValueError("人口单元被精度去缝完全删除，无法守恒分配人口。")
            amount = population_rows[index].get("population")
            pop_geometries[index] = normalized
            normalization.append(dict(id=population_rows[index]["id"], removed_area_m2=removed,
                original_area_m2=geometry.area, normalized_area_m2=normalized.area,
                retained_population=amount, population_reallocation_upper_bound=amount*removed/geometry.area if amount is not None else None))
    service_population = [0. for _ in services]
    service_missing = [0. for _ in services]
    service_missing_records = [0 for _ in services]
    service_population_uncertainty = [[] for _ in services]
    clipped_census = []
    input_population = study_population = unmapped_population = ambiguous_population = 0.
    outside_population = 0.
    missing_cells = 0
    missing_area = 0.
    tree = STRtree(exclusive)
    prepared_services = [prep(geometry) for geometry in exclusive]
    for row, geometry in zip(population_rows, pop_geometries):
        clipped = clip_to_study(geometry)
        if row.get("population") is not None:
            input_population += float(row["population"])
        if clipped.is_empty or clipped.area <= 0:
            if row.get("population") is not None:
                outside_population += float(row["population"])
            continue
        clipped_census.append(clipped)
        amount = row.get("population")
        if amount is None:
            missing_cells += 1
            missing_area += clipped.area
        else:
            study_amount = amount * clipped.area / geometry.area
            study_population += study_amount
            outside_population += amount - study_amount
        assigned = 0.
        for index in tree.query(clipped, predicate="intersects"):
            index = int(index)
            intersection = clipped if prepared_services[index].covers(clipped) else clipped.intersection(exclusive[index])
            if intersection.area <= 0:
                continue
            if row.get("uncertainty") is not None:
                service_population_uncertainty[index].append(dict(id=row["id"], source=row["source"],
                    uncertainty=deepcopy(row["uncertainty"])))
            if amount is None:
                service_missing[index] += intersection.area
                service_missing_records[index] += 1
            else:
                allocated = amount * intersection.area / geometry.area
                assigned += allocated
                service_population[index] += allocated
        if amount is not None:
            unmapped_population += max(0., study_amount - assigned)
            if not overlap_geometry.is_empty:
                ambiguous_population += amount * clipped.intersection(overlap_geometry).area / geometry.area
    mapped_population = sum(service_population)
    residual = study_population - mapped_population - unmapped_population
    if abs(residual) > max(1e-5, study_population * 1e-9):
        raise ArithmeticError("空间人口叠加未满足守恒，请检查数据。")
    known_census_union = union(clipped_census)
    census_uncovered = study.difference(known_census_union)
    uncovered_area = max(0., census_uncovered.area)
    # A hole in the census layer means population is unobserved, not zero.
    # Only an explicit census polygon with population=0 supports a zero count.
    if not census_uncovered.is_empty:
        for index, geometry in enumerate(exclusive):
            service_missing[index] += geometry.intersection(census_uncovered).area
    coverage_tolerance = config.get("population_coverage_tolerance_m2")
    if coverage_tolerance is None:
        coverage_tolerance = min(5., max(1e-4, study.area * 1e-9))
    population_complete = missing_cells == 0 and uncovered_area <= coverage_tolerance
    density_values = [row["population"] / geometry.area for row, geometry in zip(population_rows, pop_geometries)
                      if row.get("population") is not None and geometry.area > 0]
    max_density = max(density_values) if density_values else None
    coverage = dict(input_population=input_population, study_population=study_population,
        mapped_population=mapped_population, unmapped_population=unmapped_population,
        ambiguous_overlap_population=ambiguous_population, outside_study_population=outside_population,
        population_coverage_ratio=mapped_population / study_population if study_population > 0 else None,
        study_area_km2=study.area / 1e6, mapped_area_km2=exclusive_union.area / 1e6,
        unmapped_area_km2=unmapped_geometry.area / 1e6, ambiguous_overlap_area_km2=overlap_geometry.area / 1e6,
        census_geometry_coverage_ratio=known_census_union.area / study.area,
        population_missing_cells=missing_cells, population_unknown_area_km2=(missing_area + uncovered_area) / 1e6,
        census_uncovered_area_km2=uncovered_area / 1e6,
        population_values_complete=population_complete,
        population_coverage_area_tolerance_m2=coverage_tolerance,
        population_max_input_density_per_m2=max_density,
        population_geometric_precision_sensitivity_upper_bound=(max_density * uncovered_area
            if max_density is not None and missing_cells == 0 else None),
        population_overlap_area_m2=sum(row["area_m2"] for row in population_overlaps),
        population_seam_removed_area_m2=sum(row["removed_area_m2"] for row in normalization),
        population_overlap_error_upper_bound=(sum(row["potential_population_overlap_upper_bound"] for row in population_overlaps)
            if all(row["potential_population_overlap_upper_bound"] is not None for row in population_overlaps) else None),
        conservation_residual=residual)
    geometries = [None if geometry.is_empty or geometry.area <= 1e-6
                  else _json_geometry(geometry, inverse) for geometry in exclusive]
    return (config, services, population_rows, exclusive, inverse, crs, unmapped_geometry, service_population, service_missing, service_missing_records, service_population_uncertainty, study_population, unmapped_population, coverage, population_overlaps, normalization, geometries)


def evaluate_power_impact(config, network, frames=None):
    """Spatially allocate census population, then evaluate every immutable frame.

    Census polygon population is uniformly spread over that polygon (an explicit
    approximation). Service overlaps are removed from all assignments and remain
    unknown. Population polygons must have nonoverlapping interiors. Integrals
    use left-continuous, piecewise-constant saved states; no terminal backfill.
    """
    if not isinstance(network, dict) or not isinstance(network.get("nodes"), list):
        raise ValueError("network 须含 nodes 和保存的 frames。")
    (config, services, population_rows, exclusive, inverse, crs, unmapped_geometry, service_population, service_missing, service_missing_records, service_population_uncertainty, study_population, unmapped_population, coverage, population_overlaps, normalization, geometries) = _cached_spatial(config)
    nodes = {_key(node.get("result_id", node.get("id"))): node for node in network["nodes"]}
    output_frames = []
    for time, functions in _frames(network, frames):
        features = []
        summary = dict(full_outage_population=0., partial_outage_population_equivalent=0.,
            affected_population_equivalent=0., affected_population_any_outage=0.,
            unknown_population=0., unmapped_population=unmapped_population,
            outage_area_km2=0., full_outage_area_km2=0., partial_outage_area_km2=0.,
            unknown_supply_area_km2=0., observed_population=0.,
            population_coverage_ratio=coverage["population_coverage_ratio"],
            population_values_complete=coverage["population_values_complete"])
        for index, (area, geometry) in enumerate(zip(services, exclusive)):
            if geometry.is_empty or geometry.area <= 1e-6:
                continue
            supplied, supply_basis, unknown_nodes = _supply(area, nodes, functions)
            deficit = None if supplied is None else 1 - supplied
            population = service_population[index]
            # The numerical geometry budget belongs to the entire study, not
            # to each differently sized polygon. Sharing it prevents a complete
            # aggregate and an unknown small zone from contradicting each other.
            population_complete = (service_missing_records[index] == 0 and
                service_missing[index] <= coverage["population_coverage_area_tolerance_m2"])
            status = ("unknown" if supplied is None else "full_outage" if supplied <= EPS
                      else "partial_outage" if deficit > EPS else "grid_supplied")
            equivalent = None if deficit is None else population * deficit
            full = population if status == "full_outage" else 0. if supplied is not None else None
            partial = equivalent if status == "partial_outage" else 0. if supplied is not None else None
            properties = dict(zone_id=area["id"], node_ids=list(map(_key, area["node_ids"])),
                population=population if population_complete else None, population_known_lower_bound=population,
                population_values_complete=population_complete, population_unknown_area_km2=service_missing[index]/1e6,
                population_census_null_cell_count=service_missing_records[index],
                population_coverage_area_tolerance_m2=coverage["population_coverage_area_tolerance_m2"],
                population_geometric_precision_sensitivity_upper_bound=(service_missing[index] * coverage["population_max_input_density_per_m2"]
                    if service_missing_records[index] == 0 and coverage["population_max_input_density_per_m2"] is not None else None),
                area_km2=geometry.area / 1e6, supply_ratio=supplied, served_ratio=supplied,
                unserved_ratio=deficit, status=status, full_outage_population=full if population_complete else None,
                partial_outage_population_equivalent=partial if population_complete else None,
                affected_population_equivalent=equivalent if population_complete else None,
                affected_population=equivalent if population_complete else None,
                affected_population_any_outage=(population if deficit > EPS else 0.)
                    if deficit is not None and population_complete else None,
                unknown_population=population if supplied is None and population_complete else
                    None if not population_complete else 0., unknown_node_ids=unknown_nodes,
                source=area["source"], geometry_basis=area["geometry_basis"],
                assignment_basis=area["assignment_basis"], supply_basis=supply_basis,
                population_basis="census_polygon_uniform_area_intersection_equivalent_exposure",
                effective_geometry_basis="study_clipped_exclusive_service_area",
                uncertainty=deepcopy(area.get("uncertainty")), population_uncertainty=deepcopy(service_population_uncertainty[index]))
            features.append(dict(id="impact:" + area["id"], kind="zone", name=area.get("name", area["id"]),
                geometry=deepcopy(geometries[index]), properties=properties))
            if supplied is None:
                summary["unknown_population"] += population
                summary["unknown_supply_area_km2"] += geometry.area / 1e6
            else:
                summary["observed_population"] += population
                summary["affected_population_equivalent"] += equivalent
                summary["full_outage_population"] += full
                summary["partial_outage_population_equivalent"] += partial
                if deficit > EPS:
                    summary["affected_population_any_outage"] += population
                    summary["outage_area_km2"] += geometry.area / 1e6
                    summary["full_outage_area_km2" if status == "full_outage" else "partial_outage_area_km2"] += geometry.area / 1e6
        summary["observed_population_coverage_ratio"] = summary["observed_population"] / study_population if study_population > 0 else None
        summary["affected_population_equivalent_lower_bound"] = summary["affected_population_equivalent"]
        summary["affected_population_equivalent_upper_bound"] = (summary["affected_population_equivalent"] +
            summary["unknown_population"] + unmapped_population) if coverage["population_values_complete"] else None
        if not coverage["population_values_complete"]:
            # Named aggregate counts are unknown, while their known-population
            # lower bounds remain available for audit; never turn suppression into zero.
            for field in ("full_outage_population", "partial_outage_population_equivalent", "affected_population_equivalent",
                          "affected_population_any_outage", "unknown_population"):
                summary[field + "_known_lower_bound"] = summary[field]
                summary[field] = None
        output_frames.append(dict(time_hours=time, features=features, summary=summary))
    first, last = output_frames[0]["time_hours"], output_frames[-1]["time_hours"]
    metrics = dict(observation_start_hours=first, observation_end_hours=last, observed_duration_hours=last-first,
        full_outage_person_hours=0., partial_outage_person_hours_equivalent=0., outage_person_hours_equivalent=0.,
        unknown_person_hours=0., unmapped_person_hours=unmapped_population*(last-first))
    fields = {"full_outage_person_hours": "full_outage_population", "partial_outage_person_hours_equivalent": "partial_outage_population_equivalent",
              "outage_person_hours_equivalent": "affected_population_equivalent", "unknown_person_hours": "unknown_population"}
    for left, right in zip(output_frames, output_frames[1:]):
        duration = right["time_hours"] - left["time_hours"]
        for target, field in fields.items():
            value = left["summary"][field]
            if value is None:
                metrics[target] = None
            elif metrics[target] is not None:
                metrics[target] += value * duration
    for target, field in (("peak_affected_population_equivalent", "affected_population_equivalent"),
                          ("peak_full_outage_population", "full_outage_population")):
        values = [row["summary"][field] for row in output_frames]
        metrics[target] = max(values) if all(value is not None for value in values) else None
    metrics["population_values_complete"] = coverage["population_values_complete"]
    assumptions = [
        "人口按普查多边形面积均匀分配，再与供电服务区做等面积叠加；不是逐户停电识别。",
        "存在缺供的区域内人口、完全失供区域内人口、负荷缺供率折算等效人口分别报告。",
        "官方边界的地理依据与节点供电关联依据分别保存；推断的关联或分区不视为运营商认证边界。",
        "服务区交叠部分从所有归属中剔除并标为未知；未覆盖或缺供电资料的人口不视为已恢复。",
        "累计人·小时在相邻保存时刻间保持左端状态，不用终态回填，也不假设最后时刻以后的恢复。",
        "设施侧备用或移动电源不自动改变居民供电范围；应计入电网节点供电才影响区域指标。",
        "全域与每区共用已记录的研究域几何数值面积预算；预算内微缝不等于人口数据缺值。几何精度敏感性上界采用输入最大人口面密度×缝隙面积，是条件敏感性而非统计置信区间，不增加人口。",
    ]
    if population_overlaps:
        assumptions.append("人口面只对已显式允许的投影微接缝按单元 id 稳定顺序去缝；保留各单元原人口总量并重新归一面积密度，微接缝面积与人口影响上界另存。")
    return dict(schema_version=SCHEMA, coordinate_system="WGS84", frames=output_frames,
        coverage=deepcopy(coverage), metrics=metrics, assumptions=assumptions,
        provenance=dict(area_projection=crs.to_string(), area_projection_wkt=crs.to_wkt(),
            area_projection_method="local_lambert_azimuthal_equal_area",
            population_allocation="uniform_area", overlap_policy="unknown", integration="left_continuous_saved_frames",
            population_geometry_normalization=dict(method="stable_id_exclusive_micro_seam_preserving_cell_population",
                tolerance_m2=config.get("population_overlap_tolerance_m2", 1e-4),
                overlap_pairs=deepcopy(population_overlaps), adjusted_cells=deepcopy(normalization)),
            population_coverage_precision=dict(area_tolerance_m2=coverage["population_coverage_area_tolerance_m2"],
                basis="shared_study_numerical_area_budget", default_study_area_fraction=1e-9,
                default_minimum_area_m2=1e-4, maximum_area_m2=5,
                requested_tolerance_m2=config.get("population_coverage_tolerance_m2"),
                shared_between_all_service_areas=True, null_census_values_never_filled=True,
                sensitivity_basis="maximum_input_population_polygon_density_times_uncovered_area_conditional_not_statistical_interval"),
            input_source=deepcopy(config.get("source")), population_sources=sorted({row["source"] for row in population_rows}),
            service_sources=sorted({row["source"] for row in services}),
            population_records=[dict(id=row["id"], source=row["source"], uncertainty=deepcopy(row.get("uncertainty")))
                for row in population_rows],
            service_assignments=[dict(id=row["id"], geometry_basis=row["geometry_basis"],
                assignment_basis=row["assignment_basis"], node_ids=list(map(_key, row["node_ids"]))) for row in services]),
        coverage_features=([dict(id="impact:unmapped", kind="zone", name="未映射或供电关联交叠区域",
            geometry=_json_geometry(unmapped_geometry, inverse), properties=dict(status="unknown",
            population=unmapped_population if coverage["population_values_complete"] else None, geometry_basis="explicit_study_area_minus_exclusive_service_coverage",
            assignment_basis="unmapped_or_overlapping_service_assignment", source=config.get("source"),
            area_km2=unmapped_geometry.area/1e6))] if unmapped_geometry.area > 1e-6 else []))


def infer_service_areas(nodes, study_area, *, source="inferred_nearest_network_node", node_ids=None):
    """Clip nearest-node (Voronoi) regions to an explicit study polygon.

    Half-plane clipping also works for two or collinear nodes, unlike a raw
    scipy Voronoi call. These are accessibility proxies, never true feeders.
    Duplicate locations are rejected instead of assigning arbitrarily.
    """
    _, _, _, _, Polygon, transform, _, _ = _libraries()
    study_wgs = _polygon(study_area, "推断研究范围")
    forward, inverse, _ = _projection(study_wgs)
    study = transform(forward.transform, study_wgs)
    selected = [row for row in nodes if node_ids is None or _key(row.get("result_id", row.get("id"))) in set(map(_key, node_ids))]
    if not 1 <= len(selected) <= 300:
        raise ValueError("Voronoi 推断须提供 1～300 个节点；较大集合请先区域分组。")
    points = []
    ids = []
    for node in selected:
        lon, lat = node.get("longitude"), node.get("latitude")
        if not _number(lon) or not _number(lat) or not -180 <= lon <= 180 or not -90 < lat < 90:
            raise ValueError("推断节点须包含有限 WGS84 经纬度。")
        point = forward.transform(lon, lat)
        if not all(math.isfinite(value) for value in point):
            raise ValueError("节点超出投影有效范围。")
        if any(math.dist(point, old) < 1e-3 for old in points):
            raise ValueError("推断节点坐标重复，无法确认供电归属。")
        key = _key(node.get("result_id", node.get("id")))
        if key == "None" or key in ids:
            raise ValueError("推断节点 id 须非空且唯一。")
        points.append(point)
        ids.append(key)
    bounds = study.bounds
    centroid = study.centroid
    scale = max(bounds[2]-bounds[0], bounds[3]-bounds[1],
                max(math.dist(point, (centroid.x, centroid.y)) for point in points),
                max(math.dist(a, b) for a in points for b in points), 100.) * 10
    result = []
    for index, (point, node) in enumerate(zip(points, selected)):
        region = study
        for other, location in enumerate(points):
            if index == other:
                continue
            dx, dy = location[0]-point[0], location[1]-point[1]
            distance = math.hypot(dx, dy)
            normal, tangent = (dx/distance, dy/distance), (-dy/distance, dx/distance)
            midpoint = ((point[0]+location[0])/2, (point[1]+location[1])/2)
            a = (midpoint[0]+tangent[0]*scale, midpoint[1]+tangent[1]*scale)
            b = (midpoint[0]-tangent[0]*scale, midpoint[1]-tangent[1]*scale)
            clip = Polygon([a, b, (b[0]-normal[0]*2*scale, b[1]-normal[1]*2*scale),
                            (a[0]-normal[0]*2*scale, a[1]-normal[1]*2*scale), a])
            region = region.intersection(clip)
        if region.is_empty or region.area <= 1e-6:
            continue
        result.append(dict(id="inferred:"+ids[index], name=node.get("name", ids[index]), node_ids=[ids[index]],
            geometry=_json_geometry(region, inverse), geometry_basis="inferred_clipped_voronoi_nearest_node",
            assignment_basis="inferred_nearest_node_not_verified_electrical_service", source=source,
            uncertainty="未使用真实馈线/用户供电关系；最近节点区仅用于缺资料时的空间情景估计。"))
    return result
