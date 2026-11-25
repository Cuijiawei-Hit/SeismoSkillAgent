"""Read-only presentation of the bound case and immutable electrical outputs.

This module never imports a numerical solver. Geometry is sent once, and saved
recovery events contain values keyed by asset ID, rather than repeated geometry.
"""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import threading
from typing import Any


DAMAGE_LABELS = {1: "基本完好", 2: "轻微破坏", 3: "中等破坏", 4: "严重破坏", 5: "完全破坏"}
_DAMAGE_CODES = {label: code for code, label in DAMAGE_LABELS.items()}
SCHEMA_VERSION = "power_scene.v1"


def _rows(value):
    return value if isinstance(value, list) else []


def _pick(value, fields):
    return {key: deepcopy(value[key]) for key in fields if key in value}


def _scalars(value):
    return {key: item for key, item in (value or {}).items()
            if item is None or isinstance(item, (str, int, float, bool))}


def _identifier(value):
    if isinstance(value, (int, float)) and value == int(value):
        return str(int(value))
    return str(value)


def _source_brief(value):
    # The full shared source note is retained once on network.source/case.
    return _pick(value, ("title", "url", "year", "version")) if isinstance(value, dict) else value


def _table(payload, name):
    for book in _rows(payload.get("workbooks")):
        for sheet in _rows(book.get("sheets")):
            if sheet.get("name") == name:
                return _rows(sheet.get("rows"))[1:]
    return []


def _network(payload, damage=None, function=None):
    """Normalize saved network keys; preserve all recorded coordinates/attributes."""
    damage = damage or {}
    function = function or {}
    damage_nodes = {_identifier(row.get("id")): row for row in _rows(damage.get("nodes"))}
    damage_edges = {_identifier(row.get("id")): row for row in _rows(damage.get("branches"))}
    supply = function.get("node_supply_mw") or {}
    frame = function.get("network_frame") or {}
    node_function = (frame.get("node") or {}).get("function") or {}
    branch_function = (frame.get("pipe") or {}).get("function") or {}
    nodes, edges = [], []
    for row in _rows(payload.get("nodes")):
        node = deepcopy(row)
        node["id"] = _identifier(node.get("result_id", node.get("id")))
        record = damage_nodes.get(node["id"], {})
        if "state" in record:
            node["damage_state"] = record["state"]
            node["damage_label"] = DAMAGE_LABELS.get(record["state"], str(record["state"]))
        if record:
            node["damage"] = _pick(record, ("state", "function", "asset_type", "pga_g", "probabilities"))
        node["supply_mw"] = supply.get(node["id"])
        node["function"] = node_function.get(node["id"])
        node["source"] = _source_brief((node.get("properties") or {}).get("来源") or payload.get("source") or payload.get("geometry_source"))
        nodes.append(node)
    for row in _rows(payload.get("edges", payload.get("links"))):
        edge = deepcopy(row)
        edge["id"] = _identifier(edge.get("result_id", edge.get("id")))
        edge["source"] = _identifier(edge.get("from_node", edge.get("source")))
        edge["target"] = _identifier(edge.get("to_node", edge.get("target")))
        edge["from_node"], edge["to_node"] = edge["source"], edge["target"]
        if "geometry" not in edge and edge.get("coordinates"):
            edge["geometry"] = {"type": "LineString", "coordinates": edge.pop("coordinates")}
        record = damage_edges.get(edge["id"], {})
        if "state" in record:
            edge["damage_state"] = record["state"]
            edge["damage_label"] = DAMAGE_LABELS.get(record["state"], str(record["state"]))
        if record:
            edge["damage"] = _pick(record, ("state", "function", "asset_type", "pga_g", "probabilities"))
        edge["function"] = branch_function.get(edge["id"])
        edge["data_source"] = _source_brief((edge.get("properties") or {}).get("来源") or payload.get("source") or payload.get("geometry_source"))
        edges.append(edge)
    coordinates = [(node.get("longitude"), node.get("latitude")) for node in nodes]
    coordinates = [(x, y) for x, y in coordinates if isinstance(x, (int, float)) and isinstance(y, (int, float))]
    bounds = [min(x for x, _ in coordinates), min(y for _, y in coordinates),
              max(x for x, _ in coordinates), max(y for _, y in coordinates)] if coordinates else None
    return {"nodes": nodes, "edges": edges, "bounds": bounds,
            "coordinate_system": "WGS84", "source": deepcopy(payload.get("source", payload.get("geometry_source")))}


def case_scene(city: dict, source: dict | None = None):
    """Project an uncomputed case without inventing earthquake or supply states."""
    source = source or {}
    geo = deepcopy(city.get("geospatial") or {})
    nodes = {_identifier(row.get("result_id", row.get("id"))): row for row in _rows(geo.get("nodes"))}
    for row in _table(city, "变电站信息"):
        if len(row) >= 7:
            identifier = _identifier(row[0])
            nodes.setdefault(identifier, {"id": identifier}).update(
                name=row[1], type=row[2], longitude=row[3], latitude=row[4], demand_mw=row[5], voltage_kv=row[6])
    links = {_identifier(row.get("result_id", row.get("id"))): row for row in _rows(geo.get("links"))}
    for row in _table(city, "线路信息"):
        if len(row) >= 6:
            identifier = _identifier(row[0])
            links.setdefault(identifier, {"id": identifier}).update(
                from_node=_identifier(row[1]), to_node=_identifier(row[2]),
                reactance_ohm=row[3], capacity_mw=row[4], voltage_kv=row[5])
    geo["nodes"], geo["links"] = list(nodes.values()), list(links.values())
    network = _network(geo)
    region = city.get("region") or {}
    areas = []
    for row in _rows((city.get("power_impact") or {}).get("service_areas")):
        area = _pick(row, ("id", "name", "geometry", "node_ids", "node_weights", "source", "uncertainty", "assignment_basis"))
        area["properties"] = {key: deepcopy(value) for key, value in row.items() if key != "geometry"}
        # A source service-area is inventory, not a computed outage footprint.
        area["properties"]["status"] = "not_assessed"
        areas.append(area)
    case = {"title": city.get("title"), "city": region.get("city_name"), "region": region.get("region_name"),
            "dataset_id": source.get("dataset_id"), "version_id": source.get("version_id"), "revision": source.get("revision"),
            "dataset_fingerprint": source.get("city_file_sha256"), "source_note": city.get("source_note"),
            "assumptions": deepcopy(city.get("simulation_assumptions")), "source": deepcopy(geo.get("source")),
            "node_count": len(network["nodes"]), "branch_count": len(network["edges"]),
            "generator_count": len(_table(city, "发电站信息")), "coordinate_system": "WGS84"}
    return {"schema_version": SCHEMA_VERSION, "status": "case_only", "run_id": None, "iteration": None,
            "case": case, "network": network, "damage": {}, "function": {},
            "recovery": {"strategies": []}, "impact": {"areas": areas, "strategies": [], "computed": False},
            "provenance": {"geometry_basis": "bound_case_inventory", "engineering_recomputed": False}}


def _recovery(raw):
    result = _pick(raw, ("parameters", "recommended_strategy", "search_limits", "state_evaluations", "assumptions", "scenario_digest"))
    strategies = []
    for strategy in _rows(raw.get("strategies")):
        item = _pick(strategy, ("id", "name", "loss_area_days", "target_time_days", "total_days", "target_reached", "final_function",
                                "comparison_horizon_days", "resilience_index", "curve", "schedule", "unserved_energy_mwh_relative_to_intact"))
        curve = {point.get("time"): point.get("function") for point in _rows(strategy.get("curve"))}
        item["frames"] = []
        for frame in _rows(strategy.get("map_frames")):
            time_day = frame.get("time")
            saved = {"time_day": time_day, "time_hours": time_day * 24 if isinstance(time_day, (int, float)) else None,
                     "node_function": deepcopy((frame.get("node") or {}).get("function") or {}),
                     "branch_function": deepcopy((frame.get("pipe") or {}).get("function") or {}),
                     "node_damage": {key: _DAMAGE_CODES.get(value, value) for key, value in ((frame.get("node") or {}).get("damage") or {}).items()},
                     "branch_damage": {key: _DAMAGE_CODES.get(value, value) for key, value in ((frame.get("pipe") or {}).get("damage") or {}).items()}}
            if time_day in curve:
                saved["function_ratio"] = curve[time_day]
            item["frames"].append(saved)
        strategies.append(item)
    result["strategies"] = strategies
    result["damage_encoding"] = "state_codes_1_to_5"
    return result


def _impact(raw):
    """De-duplicate area geometry and provenance across all saved event frames."""
    result = _pick(raw, ("title", "recommended_strategy", "coverage", "metrics", "initial_summary", "analysis_mode", "assumptions", "scenario_digest"))
    result["model_provenance"] = _pick(raw.get("model_provenance") or {}, (
        "area_projection", "area_projection_method", "population_allocation", "overlap_policy", "integration",
        "population_coverage_precision", "input_source", "population_sources", "service_sources"))
    geometry = raw.get("geometry_by_id") or {}
    areas = OrderedDict()
    strategies = []
    for strategy in _rows(raw.get("strategies")):
        item = _pick(strategy, ("id", "name", "coverage", "metrics", "assumptions"))
        frames = []
        for index, frame in enumerate(_rows(strategy.get("frames"))):
            states = {}
            for feature in _rows(frame.get("features")):
                identifier = str(feature.get("id"))
                properties = feature.get("properties") or {}
                if identifier not in areas:
                    areas[identifier] = {"id": identifier, "name": feature.get("name"), "kind": feature.get("kind"),
                                         "geometry": deepcopy(feature.get("geometry") or geometry.get(feature.get("geometry_ref", identifier))),
                                         "properties": deepcopy(properties)}
                states[identifier] = _pick(properties, ("status", "supply_ratio", "affected_population_equivalent", "unknown_population"))
            summary = deepcopy(frame.get("summary") or {})
            if index == 0:
                item["initial_summary"] = summary
            frames.append({"time_hours": frame.get("time_hours"), "summary": summary, "area_states": states})
        for feature in _rows(strategy.get("coverage_features")):
            identifier = str(feature.get("id"))
            if identifier not in areas:
                areas[identifier] = {"id": identifier, "name": feature.get("name"), "kind": feature.get("kind"),
                    "geometry": deepcopy(feature.get("geometry") or geometry.get(feature.get("geometry_ref", identifier))),
                    "properties": deepcopy(feature.get("properties") or {}), "coverage_feature": True}
            # Unknown coverage remains unknown at every saved time, even after repairs.
        item["frames"] = frames
        strategies.append(item)
    result.update(areas=list(areas.values()), strategies=strategies, computed=True)
    return result


class PowerSceneStore:
    """Small read cache keyed by immutable run references and file signatures."""
    def __init__(self, workspace_root: Path, allowed_roots: list[Path]):
        self.workspace_root = Path(workspace_root).resolve()
        self.allowed_roots = [Path(root).resolve() for root in allowed_roots]
        self._cache = OrderedDict()
        self._case_cache = None
        self._lock = threading.RLock()

    def _path(self, reference):
        if not isinstance(reference, dict) or not reference.get("path"):
            return None
        path = Path(reference["path"]).expanduser().resolve()
        if not any(path.is_relative_to(root) for root in self.allowed_roots):
            raise PermissionError("Saved visualization artifact is outside the independent run roots")
        if not path.is_file():
            raise KeyError("Saved visualization artifact no longer exists")
        return path

    def _artifact(self, reference):
        path = self._path(reference)
        if path is None:
            return {}
        content = path.read_bytes()
        expected = reference.get("checksum_sha256")
        if expected and sha256(content).hexdigest() != expected:
            raise ValueError("Saved visualization artifact checksum does not match its registered output")
        return json.loads(content.decode("utf-8-sig"))

    def case(self):
        path = (self.workspace_root / "data/auckland/city.json").resolve()
        if not path.is_relative_to(self.workspace_root):
            raise PermissionError("The bound case is outside the independent workspace")
        if not path.is_file():
            raise KeyError("The bound Auckland case is not installed in this workspace")
        sidecar = path.with_name("source.json")
        signature = tuple((file.stat().st_size, file.stat().st_mtime_ns) for file in (path, sidecar) if file.is_file())
        with self._lock:
            if self._case_cache is None or self._case_cache[0] != signature:
                content = path.read_bytes()
                source = json.loads(sidecar.read_text(encoding="utf-8-sig")) if sidecar.is_file() else {}
                digest = sha256(content).hexdigest()
                expected = source.get("city_file_sha256")
                if expected and expected != digest:
                    raise ValueError("The bound case does not match its recorded dataset fingerprint")
                source["city_file_sha256"] = digest
                self._case_cache = signature, case_scene(json.loads(content.decode("utf-8-sig")), source)
            return self._case_cache[1]

    def scene(self, result: dict, iteration: int | None = None):
        data = result.get("data") or {}
        nodes = data.get("node_results") or {}
        stages = {}
        references = []
        for name in ("input_preparation", "damage_assessment", "function_assessment", "recovery_assessment", "recovery_optimization", "resilience_assessment", "outage_impact"):
            value = nodes.get("power_system." + name) or {}
            if isinstance(value, dict) and isinstance(value.get("data"), dict):
                value = value["data"]
            stages[name] = value
            for key, reference in value.items():
                if key.endswith("_artifact") and isinstance(reference, dict) and reference.get("path"):
                    path = self._path(reference)
                    stat = path.stat()
                    references.append((key, str(path), stat.st_size, stat.st_mtime_ns, reference.get("checksum_sha256")))
        if not nodes:
            raise KeyError("This session has no saved electrical computation")
        # Presentation-only report revisions reuse these immutable engineering refs.
        key = (result.get("run_id"), iteration, tuple(references))
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            prepared = stages["input_preparation"]
            inventory = deepcopy(prepared.get("inventory") or {})
            raw_input = self._artifact(prepared.get("dataset_artifact"))
            if isinstance(raw_input.get("inventory"), dict):
                inventory = raw_input["inventory"]
            damage = stages["damage_assessment"].get("damage") or {}
            function = stages["function_assessment"].get("function") or {}
            case = _pick(inventory, ("city", "region", "title", "dataset_id", "version_id", "revision", "node_count", "branch_count",
                                    "generator_count", "total_demand_mw", "source_note", "assumptions", "power_profile", "dataset_fingerprint"))
            case["coordinate_system"] = "WGS84"
            result_scene = {"schema_version": SCHEMA_VERSION, "status": "ready", "run_id": result.get("run_id"), "iteration": iteration,
                "case": case, "network": _network(inventory.get("network") or {}, damage, function),
                "scenario": _pick(stages["damage_assessment"].get("summary") or damage,
                    ("pga_g", "power_damage_mode", "seed", "dataset_fingerprint", "damage_scenario_fingerprint")),
                "damage": _pick(damage, ("node_count", "branch_count", "damaged_node_count", "damaged_branch_count", "damaged_count", "probabilities_valid")),
                "function": _pick(function, ("pre_supply_mw", "post_supply_mw", "function_ratio", "unserved_mw", "requested_demand_mw", "intact_unserved_mw", "node_supply_mw", "assumptions")),
                "basic_recovery": deepcopy(stages["recovery_assessment"].get("basic_recovery") or {}),
                "resilience": deepcopy(stages["resilience_assessment"].get("resilience") or {}),
                "recovery": {"strategies": []}, "impact": {"areas": [], "strategies": [], "computed": False},
                "provenance": {"engineering_recomputed": False, "geometry_basis": "saved_input_preparation_artifact",
                               "dataset_fingerprint": inventory.get("dataset_fingerprint"), "source_run_id": result.get("run_id")}}
            recovery = stages["recovery_optimization"]
            if recovery.get("recovery_artifact"):
                result_scene["recovery"] = _recovery(self._artifact(recovery["recovery_artifact"]))
            elif recovery.get("recovery"):
                result_scene["recovery"] = _recovery(recovery["recovery"])
            impact = stages["outage_impact"]
            if impact.get("impact_artifact"):
                result_scene["impact"] = _impact(self._artifact(impact["impact_artifact"]))
            result_scene["damage"]["state_labels"] = DAMAGE_LABELS
            self._cache[key] = result_scene
            while len(self._cache) > 3:
                self._cache.popitem(last=False)
            return result_scene
