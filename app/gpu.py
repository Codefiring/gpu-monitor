from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pynvml


class GpuCollector:
    def __init__(self) -> None:
        self._initialized = False
        self._last_error: str | None = None

    @property
    def last_error(self) -> str | None:
        return self._last_error

    def init(self) -> None:
        if self._initialized:
            return
        try:
            pynvml.nvmlInit()
            self._initialized = True
            self._last_error = None
        except pynvml.NVMLError as exc:
            self._last_error = f"NVML init failed: {exc}"
            raise RuntimeError(self._last_error) from exc

    def shutdown(self) -> None:
        if not self._initialized:
            return
        try:
            pynvml.nvmlShutdown()
        finally:
            self._initialized = False

    def gpu_count(self) -> int:
        self.init()
        return pynvml.nvmlDeviceGetCount()

    def list_gpus(self) -> list[dict[str, Any]]:
        self.init()
        gpus = []
        for index in range(self.gpu_count()):
            handle = pynvml.nvmlDeviceGetHandleByIndex(index)
            memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
            gpus.append(
                {
                    "index": index,
                    "uuid": _decode(pynvml.nvmlDeviceGetUUID(handle)),
                    "name": _decode(pynvml.nvmlDeviceGetName(handle)),
                    "memory_total_mb": round(memory.total / 1024 / 1024, 1),
                }
            )
        return gpus

    def sample(self) -> list[dict[str, Any]]:
        self.init()
        timestamp = datetime.now(UTC).isoformat()
        metrics = []
        for index in range(self.gpu_count()):
            handle = pynvml.nvmlDeviceGetHandleByIndex(index)
            utilization = pynvml.nvmlDeviceGetUtilizationRates(handle)
            memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
            power_usage_w = _read_power_usage_w(handle)
            power_limit_w = _read_power_limit_w(handle)
            metrics.append(
                {
                    "timestamp": timestamp,
                    "gpu_index": index,
                    "gpu_uuid": _decode(pynvml.nvmlDeviceGetUUID(handle)),
                    "name": _decode(pynvml.nvmlDeviceGetName(handle)),
                    "gpu_utilization": float(utilization.gpu),
                    "memory_utilization": float(utilization.memory),
                    "memory_used_mb": round(memory.used / 1024 / 1024, 1),
                    "memory_total_mb": round(memory.total / 1024 / 1024, 1),
                    "temperature_c": _read_temperature_c(handle),
                    "power_usage_w": power_usage_w,
                    "power_limit_w": power_limit_w,
                }
            )
        self._last_error = None
        return metrics


def _decode(value: bytes | str) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def _read_temperature_c(handle: Any) -> float | None:
    try:
        return float(pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU))
    except pynvml.NVMLError:
        return None


def _read_power_usage_w(handle: Any) -> float | None:
    try:
        return round(pynvml.nvmlDeviceGetPowerUsage(handle) / 1000, 2)
    except pynvml.NVMLError:
        return None


def _read_power_limit_w(handle: Any) -> float | None:
    try:
        return round(pynvml.nvmlDeviceGetEnforcedPowerLimit(handle) / 1000, 2)
    except pynvml.NVMLError:
        return None
