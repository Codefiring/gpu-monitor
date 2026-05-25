from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from app.timezone import now_utc, parse_iso_to_utc


METRIC_COLUMNS = (
    "timestamp",
    "gpu_index",
    "gpu_uuid",
    "name",
    "gpu_utilization",
    "memory_utilization",
    "memory_used_mb",
    "memory_total_mb",
    "temperature_c",
    "power_usage_w",
    "power_limit_w",
)


class MetricsStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self.init_schema()

    def init_schema(self) -> None:
        with self._lock:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS metrics (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    gpu_index INTEGER NOT NULL,
                    gpu_uuid TEXT NOT NULL,
                    name TEXT NOT NULL,
                    gpu_utilization REAL,
                    memory_utilization REAL,
                    memory_used_mb REAL,
                    memory_total_mb REAL,
                    temperature_c REAL,
                    power_usage_w REAL,
                    power_limit_w REAL
                );

                CREATE INDEX IF NOT EXISTS idx_metrics_timestamp
                    ON metrics(timestamp);

                CREATE INDEX IF NOT EXISTS idx_metrics_gpu_timestamp
                    ON metrics(gpu_index, timestamp);
                """
            )
            self._migrate_timestamps_to_utc_locked()
            self._conn.commit()

    def _migrate_timestamps_to_utc_locked(self) -> None:
        rows = self._conn.execute(
            """
            SELECT id, timestamp
            FROM metrics
            WHERE timestamp NOT LIKE '%+00:00'
            """
        ).fetchall()
        updates = []
        for row in rows:
            try:
                updates.append((parse_iso_to_utc(row["timestamp"]).isoformat(), row["id"]))
            except ValueError:
                continue
        if updates:
            self._conn.executemany(
                "UPDATE metrics SET timestamp = ? WHERE id = ?",
                updates,
            )

    def insert_many(self, metrics: list[dict[str, Any]]) -> None:
        if not metrics:
            return

        rows = [tuple(metric.get(column) for column in METRIC_COLUMNS) for metric in metrics]
        placeholders = ", ".join("?" for _ in METRIC_COLUMNS)
        columns = ", ".join(METRIC_COLUMNS)
        with self._lock:
            self._conn.executemany(
                f"INSERT INTO metrics ({columns}) VALUES ({placeholders})",
                rows,
            )
            self._conn.commit()

    def prune_older_than(self, days: int) -> int:
        cutoff = now_utc() - timedelta(days=days)
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM metrics WHERE timestamp < ?",
                (cutoff.isoformat(),),
            )
            self._conn.commit()
            return cursor.rowcount

    def latest(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT m.*
                FROM metrics m
                JOIN (
                    SELECT gpu_index, MAX(timestamp) AS timestamp
                    FROM metrics
                    GROUP BY gpu_index
                ) latest
                ON m.gpu_index = latest.gpu_index
                AND m.timestamp = latest.timestamp
                ORDER BY m.gpu_index
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def history(
        self,
        gpu_index: int,
        start: datetime,
        end: datetime,
        limit: int,
    ) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT *
                FROM metrics
                WHERE gpu_index = ?
                  AND timestamp >= ?
                  AND timestamp <= ?
                ORDER BY timestamp ASC
                LIMIT ?
                """,
                (gpu_index, start.isoformat(), end.isoformat(), limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def recent(self, gpu_index: int, limit: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT *
                FROM (
                    SELECT *
                    FROM metrics
                    WHERE gpu_index = ?
                    ORDER BY timestamp DESC
                    LIMIT ?
                )
                ORDER BY timestamp ASC
                """,
                (gpu_index, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def stats(self, gpu_index: int, start: datetime, end: datetime) -> dict[str, Any]:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT
                    COUNT(*) AS samples,
                    AVG(gpu_utilization) AS avg_gpu_utilization,
                    MAX(gpu_utilization) AS max_gpu_utilization,
                    AVG(memory_utilization) AS avg_memory_utilization,
                    MAX(memory_utilization) AS max_memory_utilization,
                    AVG(memory_used_mb) AS avg_memory_used_mb,
                    MAX(memory_used_mb) AS max_memory_used_mb,
                    AVG(temperature_c) AS avg_temperature_c,
                    MAX(temperature_c) AS max_temperature_c,
                    AVG(power_usage_w) AS avg_power_usage_w,
                    MAX(power_usage_w) AS max_power_usage_w
                FROM metrics
                WHERE gpu_index = ?
                  AND timestamp >= ?
                  AND timestamp <= ?
                """,
                (gpu_index, start.isoformat(), end.isoformat()),
            ).fetchone()
        return dict(row) if row else {"samples": 0}

    def close(self) -> None:
        with self._lock:
            self._conn.close()
