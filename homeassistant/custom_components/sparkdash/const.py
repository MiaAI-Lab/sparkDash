"""Constants for the sparkDash integration."""

from __future__ import annotations

DOMAIN = "sparkdash"
DEFAULT_URL = "http://127.0.0.1:5555"


def auth_headers(token: str | None) -> dict[str, str]:
    """Bearer header for SPARKDASH_TOKEN, or nothing when the hub is open."""
    cleaned = (token or "").strip()
    if not cleaned:
        return {}
    return {"Authorization": f"Bearer {cleaned}"}
