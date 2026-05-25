from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.db import MetricsStore
from app.gpu import GpuCollector
from app.timezone import normalize_to_cst, now_cst


BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "app" / "static"
DB_PATH = Path(os.getenv("GPU_MONITOR_DB", BASE_DIR / "data" / "gpu_metrics.sqlite3"))
SAMPLE_INTERVAL_SECONDS = int(os.getenv("GPU_MONITOR_SAMPLE_INTERVAL", "5"))
RETENTION_DAYS = int(os.getenv("GPU_MONITOR_RETENTION_DAYS", "30"))
DEFAULT_HISTORY_MINUTES = int(os.getenv("GPU_MONITOR_DEFAULT_HISTORY_MINUTES", "10"))

logger = logging.getLogger("gpu-monitor")
store = MetricsStore(DB_PATH)
collector = GpuCollector()


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop_event = asyncio.Event()
    task = asyncio.create_task(_collector_loop(stop_event))
    try:
        yield
    finally:
        stop_event.set()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        collector.shutdown()
        store.close()


app = FastAPI(title="GPU Monitor", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/gpus")
def gpus() -> dict:
    try:
        return {"gpus": collector.list_gpus(), "error": None}
    except RuntimeError as exc:
        return {"gpus": [], "error": str(exc)}


@app.get("/api/metrics/latest")
def latest_metrics() -> dict:
    metrics = store.latest()
    collector_error = collector.last_error
    if not metrics:
        collector_error = _collect_once()
        metrics = store.latest()
    return {"metrics": metrics, "collector_error": collector_error}


@app.get("/api/metrics/history")
def history(
    gpu: Annotated[int, Query(ge=0)],
    start: Annotated[datetime | None, Query(alias="from")] = None,
    end: Annotated[datetime | None, Query(alias="to")] = None,
    limit: Annotated[int, Query(ge=1, le=10000)] = 2000,
) -> dict:
    end = _normalize_datetime(end) if end else now_cst()
    start = _normalize_datetime(start) if start else end - timedelta(minutes=DEFAULT_HISTORY_MINUTES)
    metrics = store.history(gpu, start, end, limit)
    collector_error = collector.last_error

    # The browser asks for history up to its current time. On a cold start, the
    # first on-demand sample can land milliseconds after that upper bound. Widen
    # the bound only for near-real-time empty windows so the first sample appears.
    if not metrics and abs((now_cst() - end).total_seconds()) <= SAMPLE_INTERVAL_SECONDS * 2:
        collector_error = _collect_once()
        end = now_cst()
        metrics = store.history(gpu, start, end, limit)

    return {
        "gpu": gpu,
        "from": start.isoformat(),
        "to": end.isoformat(),
        "metrics": metrics,
        "collector_error": collector_error,
    }


@app.get("/api/metrics/window")
def metrics_window(
    gpu: Annotated[int, Query(ge=0)],
    minutes: Annotated[int, Query(ge=1, le=43200)] = DEFAULT_HISTORY_MINUTES,
    limit: Annotated[int, Query(ge=1, le=10000)] = 2000,
) -> dict:
    end = now_cst()
    start = end - timedelta(minutes=minutes)
    metrics = store.history(gpu, start, end, limit)
    collector_error = collector.last_error

    if not metrics:
        collector_error = _collect_once()
        end = now_cst()
        start = end - timedelta(minutes=minutes)
        metrics = store.history(gpu, start, end, limit)

    return {
        "gpu": gpu,
        "minutes": minutes,
        "from": start.isoformat(),
        "to": end.isoformat(),
        "metrics": metrics,
        "collector_error": collector_error,
    }


@app.get("/api/metrics/recent")
def recent_metrics(
    gpu: Annotated[int, Query(ge=0)],
    limit: Annotated[int, Query(ge=1, le=10000)] = 200,
) -> dict:
    metrics = store.recent(gpu, limit)
    collector_error = collector.last_error
    if not metrics:
        collector_error = _collect_once()
        metrics = store.recent(gpu, limit)
    return {
        "gpu": gpu,
        "metrics": metrics,
        "collector_error": collector_error,
    }


@app.get("/api/stats")
def stats(
    gpu: Annotated[int, Query(ge=0)],
    start: Annotated[datetime | None, Query(alias="from")] = None,
    end: Annotated[datetime | None, Query(alias="to")] = None,
) -> dict:
    end = _normalize_datetime(end) if end else now_cst()
    start = _normalize_datetime(start) if start else end - timedelta(hours=1)
    return {
        "gpu": gpu,
        "from": start.isoformat(),
        "to": end.isoformat(),
        "stats": store.stats(gpu, start, end),
    }


async def _collector_loop(stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            metrics = await asyncio.to_thread(collector.sample)
            await asyncio.to_thread(store.insert_many, metrics)
            await asyncio.to_thread(store.prune_older_than, RETENTION_DAYS)
        except Exception as exc:
            logger.warning("GPU metric collection failed: %s", exc)

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=SAMPLE_INTERVAL_SECONDS)
        except asyncio.TimeoutError:
            continue


def _collect_once() -> str | None:
    try:
        metrics = collector.sample()
        store.insert_many(metrics)
        store.prune_older_than(RETENTION_DAYS)
        return None
    except RuntimeError as exc:
        logger.warning("GPU metric collection failed: %s", exc)
        return str(exc)


def _normalize_datetime(value: datetime) -> datetime:
    return normalize_to_cst(value)
