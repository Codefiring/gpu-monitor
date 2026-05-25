from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo


CST = ZoneInfo("Asia/Shanghai")


def now_cst() -> datetime:
    return datetime.now(CST)


def normalize_to_cst(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=CST)
    return value.astimezone(CST)


def parse_iso_to_cst(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    return normalize_to_cst(parsed)
