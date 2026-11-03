"""sparkDash hub for Home Assistant."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .coordinator import SparkDashCoordinator

PLATFORMS = [Platform.SENSOR, Platform.BINARY_SENSOR]

type SparkDashConfigEntry = ConfigEntry[SparkDashCoordinator]


async def async_setup_entry(hass: HomeAssistant, entry: SparkDashConfigEntry) -> bool:
    coordinator = SparkDashCoordinator(
        hass, entry.data["url"], entry.data.get("token") or ""
    )
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: SparkDashConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
