from __future__ import annotations

import numpy as np


def quantify_functionality_curves(
    functionality: np.ndarray,
    times: np.ndarray,
    threshold: float,
    monotonic_tolerance: float = 1e-9,
) -> dict[str, np.ndarray]:
    values = np.asarray(functionality, dtype=float)
    time = np.asarray(times, dtype=float).reshape(-1)
    if values.shape[-1] != time.size:
        raise ValueError("Functionality curve length must match the time axis")
    if time.size < 2 or np.any(np.diff(time) <= 0):
        raise ValueError("Time axis must contain at least two strictly increasing values")
    if np.any(~np.isfinite(values)) or np.any((values < 0.0) | (values > 1.0)):
        raise ValueError("Functionality values must be finite and within [0, 1]")
    horizon = float(time[-1] - time[0])
    area = np.trapezoid(values, x=time, axis=-1)
    resilience = np.clip(area / horizon, 0.0, 1.0)
    loss_area = np.maximum(horizon - area, 0.0)
    monotonic_violations = np.sum(np.diff(values, axis=-1) < -monotonic_tolerance, axis=-1)

    flat = values.reshape(-1, values.shape[-1])
    downtime = np.full(flat.shape[0], np.nan, dtype=float)
    reached = np.zeros(flat.shape[0], dtype=np.int8)
    for row_idx, row in enumerate(flat):
        if row[0] >= threshold:
            downtime[row_idx] = 0.0
            reached[row_idx] = 1
            continue
        crossing = np.flatnonzero(row >= threshold)
        if crossing.size == 0:
            continue
        right = int(crossing[0])
        left = right - 1
        delta = row[right] - row[left]
        fraction = 0.0 if abs(delta) < 1e-15 else (threshold - row[left]) / delta
        downtime[row_idx] = float(time[left] + np.clip(fraction, 0.0, 1.0) * (time[right] - time[left]))
        reached[row_idx] = 1

    shape = values.shape[:-1]
    return {
        "resilience_index": np.asarray(resilience, dtype=float),
        "functionality_loss_area": np.asarray(loss_area, dtype=float),
        "downtime_to_threshold": downtime.reshape(shape),
        "threshold_reached": reached.reshape(shape),
        "monotonic_violations": np.asarray(monotonic_violations, dtype=np.int32),
        "initial_functionality": values[..., 0],
        "final_functionality": values[..., -1],
    }
