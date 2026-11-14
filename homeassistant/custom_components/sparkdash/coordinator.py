"""Data coordinator for a sparkDash hub."""

from __future__ import annotations

import asyncio
from datetime import timedelta
import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import auth_headers

_LOGGER = logging.getLogger(__name__)


class SparkDashCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Poll sparkDash for the fleet and per-spark metrics."""

    def __init__(self, hass: HomeAssistant, url: str, token: str = "") -> None:
        self.url = url.rstrip("/")
        self._token = token or ""
        super().__init__(
            hass,
            _LOGGER,
            name="sparkDash",
            update_interval=timedelta(seconds=30),
        )

    async def _async_update_data(self) -> dict[str, Any]:
        session = async_get_clientsession(self.hass)
        headers = auth_headers(self._token)
        try:
            async with asyncio.timeout(25):
                async with session.get(
                    f"{self.url}/api/sparks", headers=headers, allow_redirects=False
                ) as resp:
                    if resp.status == 401:
                        raise UpdateFailed("sparkDash rejected the access token")
                    if resp.status == 403:
                        raise UpdateFailed("sparkDash refused the request (host or remote-access guard)")
                    resp.raise_for_status()
                    listing = await resp.json(content_type=None)
                sparks = listing.get("sparks") or []
                metrics: dict[str, Any] = {}
                for spark in sparks:
                    sid = spark.get("id")
                    if not sid:
                        continue
                    try:
                        async with session.get(
                            f"{self.url}/api/sparks/{sid}/metrics",
                            headers=headers,
                            allow_redirects=False,
                        ) as mresp:
                            mresp.raise_for_status()
                            metrics[sid] = await mresp.json(content_type=None)
                    except Exception as err:  # noqa: BLE001 - one dead spark must not drop the fleet
                        _LOGGER.debug("metrics failed for %s: %s", sid, err)
                        metrics[sid] = {
                            "id": sid,
                            "name": spark.get("name") or sid,
                            "online": False,
                            "error": str(err),
                        }
        except UpdateFailed:
            raise
        except TimeoutError as err:
            raise UpdateFailed("sparkDash timed out") from err
        except Exception as err:
            raise UpdateFailed(f"sparkDash unreachable: {err}") from err
        return {"url": self.url, "sparks": sparks, "metrics": metrics}
