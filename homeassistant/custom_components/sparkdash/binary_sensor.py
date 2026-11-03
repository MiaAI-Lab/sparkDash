"""Online flag for each Spark."""

from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import SparkDashConfigEntry
from .const import DOMAIN
from .coordinator import SparkDashCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SparkDashConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    async_add_entities(
        [
            SparkOnlineSensor(coordinator, spark["id"])
            for spark in coordinator.data.get("sparks") or []
            if spark.get("id")
        ]
    )


class SparkOnlineSensor(CoordinatorEntity[SparkDashCoordinator], BinarySensorEntity):
    _attr_has_entity_name = True
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_translation_key = "online"
    _attr_name = "Online"

    def __init__(self, coordinator: SparkDashCoordinator, spark_id: str) -> None:
        super().__init__(coordinator)
        self._spark_id = spark_id
        self._attr_unique_id = f"{spark_id}_online"

    @property
    def _metrics(self) -> dict:
        return (self.coordinator.data.get("metrics") or {}).get(self._spark_id) or {}

    @property
    def is_on(self) -> bool | None:
        online = self._metrics.get("online")
        if online is None:
            return None
        return bool(online)

    @property
    def device_info(self) -> DeviceInfo:
        hardware = self._metrics.get("hardware") or {}
        return DeviceInfo(
            identifiers={(DOMAIN, self._spark_id)},
            name=self._metrics.get("name") or self._spark_id,
            manufacturer="NVIDIA",
            model=hardware.get("device") or "DGX Spark",
            configuration_url=self.coordinator.url,
        )
