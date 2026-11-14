"""Sensors for sparks reported by sparkDash."""

from __future__ import annotations

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import (
    PERCENTAGE,
    UnitOfPower,
    UnitOfTemperature,
    UnitOfTime,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import SparkDashConfigEntry
from .const import DOMAIN
from .coordinator import SparkDashCoordinator

SENSORS: tuple[SensorEntityDescription, ...] = (
    SensorEntityDescription(
        key="gpu_temperature",
        name="GPU temperature",
        translation_key="gpu_temperature",
        native_unit_of_measurement=UnitOfTemperature.CELSIUS,
        device_class=SensorDeviceClass.TEMPERATURE,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=0,
    ),
    SensorEntityDescription(
        key="gpu_usage",
        name="GPU usage",
        translation_key="gpu_usage",
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=0,
    ),
    SensorEntityDescription(
        key="gpu_power",
        name="GPU power",
        translation_key="gpu_power",
        native_unit_of_measurement=UnitOfPower.WATT,
        device_class=SensorDeviceClass.POWER,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=1,
    ),
    SensorEntityDescription(
        key="system_power",
        name="System power",
        translation_key="system_power",
        native_unit_of_measurement=UnitOfPower.WATT,
        device_class=SensorDeviceClass.POWER,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=0,
    ),
    SensorEntityDescription(
        key="vram_percent",
        name="VRAM",
        translation_key="vram_percent",
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=0,
    ),
    SensorEntityDescription(
        key="cpu_usage",
        name="CPU usage",
        translation_key="cpu_usage",
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=0,
    ),
    SensorEntityDescription(
        key="cpu_temperature",
        name="CPU temperature",
        translation_key="cpu_temperature",
        native_unit_of_measurement=UnitOfTemperature.CELSIUS,
        device_class=SensorDeviceClass.TEMPERATURE,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=1,
    ),
    SensorEntityDescription(
        key="ram_percent",
        name="Memory",
        translation_key="ram_percent",
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=0,
    ),
    SensorEntityDescription(
        key="oom_risk",
        name="OOM risk",
        translation_key="oom_risk",
    ),
    SensorEntityDescription(
        key="llm_model",
        name="Model",
        translation_key="llm_model",
    ),
    SensorEntityDescription(
        key="llm_generation_tps",
        name="Decode speed",
        translation_key="llm_generation_tps",
        native_unit_of_measurement="tok/s",
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=1,
    ),
    SensorEntityDescription(
        key="llm_slots_active",
        name="Active slots",
        translation_key="llm_slots_active",
        state_class=SensorStateClass.MEASUREMENT,
    ),
    SensorEntityDescription(
        key="uptime",
        name="Uptime",
        translation_key="uptime",
        native_unit_of_measurement=UnitOfTime.SECONDS,
        device_class=SensorDeviceClass.DURATION,
        state_class=SensorStateClass.MEASUREMENT,
    ),
)


def _dig(data: dict, *path: str):
    cur = data
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _value(metrics: dict, key: str):
    gpu = _dig(metrics, "metrics", "gpu") or {}
    cpu = _dig(metrics, "metrics", "cpu") or {}
    ram = _dig(metrics, "metrics", "ram") or {}
    unified = _dig(metrics, "metrics", "unifiedMemory") or {}
    llms = _dig(metrics, "metrics", "llm") or []
    llm = llms[0] if isinstance(llms, list) and llms else {}
    # The server reports an unavailable GPU reading as 0 and flags it in
    # metricAvailability; keep those unknown instead of recording a zero.
    availability = gpu.get("metricAvailability") or {}

    def gpu_reading(flag: str, value):
        return None if availability.get(flag) is False else value

    # An engine the probe could not reach or measure must not read as 0 tok/s.
    llm_unavailable = llm.get("available") is False
    llm_unmeasured = llm_unavailable or llm.get("measurementValid") is False
    return {
        "gpu_temperature": gpu_reading("temperature", gpu.get("temperature")),
        "gpu_usage": gpu_reading("usage", gpu.get("usage")),
        "gpu_power": gpu_reading("powerDraw", _dig(gpu, "power", "draw")),
        "system_power": _dig(gpu, "power", "systemDraw"),
        "vram_percent": _dig(gpu, "vram", "percentage"),
        "cpu_usage": cpu.get("usage"),
        "cpu_temperature": cpu.get("temperature"),
        "ram_percent": ram.get("percentage"),
        "oom_risk": unified.get("oomRisk"),
        "llm_model": None if llm_unavailable else llm.get("modelId"),
        "llm_generation_tps": None if llm_unmeasured else llm.get("generationTps"),
        "llm_slots_active": None if llm_unavailable else llm.get("slotsActive"),
        "uptime": metrics.get("uptime"),
    }.get(key)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SparkDashConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    entities: list[SparkSensor] = []
    for spark in coordinator.data.get("sparks") or []:
        sid = spark.get("id")
        if not sid:
            continue
        entities.extend(
            SparkSensor(coordinator, sid, description) for description in SENSORS
        )
    async_add_entities(entities)


class SparkSensor(CoordinatorEntity[SparkDashCoordinator], SensorEntity):
    """One metric from one Spark."""

    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: SparkDashCoordinator,
        spark_id: str,
        description: SensorEntityDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        self._spark_id = spark_id
        self._attr_unique_id = f"{spark_id}_{description.key}"

    @property
    def _metrics(self) -> dict:
        return (self.coordinator.data.get("metrics") or {}).get(self._spark_id) or {}

    @property
    def available(self) -> bool:
        return bool(self._metrics) and self._metrics.get("online") is not False

    @property
    def native_value(self):
        return _value(self._metrics, self.entity_description.key)

    @property
    def device_info(self) -> DeviceInfo:
        hardware = self._metrics.get("hardware") or {}
        name = self._metrics.get("name") or self._spark_id
        return DeviceInfo(
            identifiers={(DOMAIN, self._spark_id)},
            name=name,
            manufacturer="NVIDIA",
            model=hardware.get("device") or "DGX Spark",
            configuration_url=self.coordinator.url,
        )
