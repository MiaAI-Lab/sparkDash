import { useTranslation } from "react-i18next";

export type ServerMessageDescriptor = { key: string; params?: Record<string, string | number> };

/** Render only the finite descriptor vocabulary; unknown or incomplete values stay raw. */
export function renderServerMessage(t: (key: string, options?: Record<string, unknown>) => string, meta: ServerMessageDescriptor | undefined, fallback: string): string {
  if (!meta) return fallback;
  switch (meta.key) {
    case "server.error.sparkNotFound": return t("error.sparkNotFound");
    case "server.error.invalidUrl": return t("error.invalidUrl");
    case "server.error.authenticationRequired": return t("error.authenticationRequired");
    case "server.error.remoteTokenRequired": return t("error.remoteTokenRequired");
    case "server.error.hostRequired": return t("error.hostRequired");
    case "server.error.passwordRequired": return t("error.passwordRequired");
    case "server.error.promptIdRequired": return t("error.promptIdRequired");
    case "server.error.orderArray": return t("error.orderArray");
    case "server.error.disabledDevicesArray": return t("error.disabledDevicesArray");
    case "server.error.disabledInterfacesArray": return t("error.disabledInterfacesArray");
    case "server.error.llmPortsArray": return t("error.llmPortsArray");
    case "server.error.invalidPort": return t("error.invalidPort");
    case "server.error.portRequired": return t("error.portRequired");
    case "server.error.portUnconfigured": return t("error.portUnconfigured");
    case "server.error.primaryPort": return t("error.primaryPort");
    case "server.error.lastPort": return t("error.lastPort");
    case "server.error.workerApi": return t("error.workerApi");
    case "server.error.llmDisabled": return t("error.llmDisabled");
    case "server.error.comfyDisabled": return t("error.comfyDisabled");
    case "server.error.categoryRequired": return t("error.categoryRequired");
    case "server.error.benchmarkNotFound": return t("error.benchmarkNotFound");
    case "server.error.showcaseNotFound": return t("error.showcaseNotFound");
    case "server.error.modelNotFound": return t("error.modelNotFound");
    case "server.error.jobNotFound": return t("error.jobNotFound");
    case "server.error.cancelled": return t("error.cancelled");
    case "server.message.shutdownInitiated": return t("message.shutdownInitiated");
    case "server.message.gpuCapRemoved": return t("message.gpuCapRemoved");
    case "health.thermal.title.warn": return t("health.thermal.titleWarn");
    case "health.thermal.title.critical": return t("health.thermal.titleCritical");

    case "health.thermal.detail": return typeof meta.params?.temperature === "string" && typeof meta.params?.warn === "string" && typeof meta.params?.critical === "string" ? t("health.thermal.detail", meta.params) : fallback;
    case "health.low-power.detail": return typeof meta.params?.util === "string" && typeof meta.params?.power === "string" && typeof meta.params?.samples === "string" ? t("health.lowPower.detail", meta.params) : fallback;
    case "health.memory.detail": return typeof meta.params?.available === "string" && typeof meta.params?.total === "string" ? t("health.memory.detail", meta.params) : fallback;
    case "health.xid.detail": return typeof meta.params?.count === "string" ? t("health.xid.detail", meta.params) + (meta.params?.last ? t("health.xid.latest", { last: meta.params.last }) : "") : fallback;
    case "health.oom.detail": return typeof meta.params?.count === "string" ? t("health.oom.detail", meta.params) : fallback;
    case "health.concurrency.detail": return typeof meta.params?.count === "string" && typeof meta.params?.percent === "string" ? t("health.concurrency.detail", meta.params) : fallback;
    case "health.link-speed.detail": return typeof meta.params?.device === "string" && typeof meta.params?.speed === "string" ? t("health.linkSpeed.detail", meta.params) : fallback;
    case "health.thermal.hint": return t("health.thermal.hint");
    case "health.low-power.title.warn": return t("health.lowPower.title");
    case "health.low-power.hint": return t("health.lowPower.hint");
    case "health.memory.title.warn": return t("health.memory.titleWarn");
    case "health.memory.title.critical": return t("health.memory.titleCritical");
    case "health.memory.hint": return t("health.memory.hint");
    case "health.xid.title.critical": return t("health.xid.title");
    case "health.xid.hint": return t("health.xid.hint");
    case "health.oom.title.critical": return t("health.oom.title");
    case "health.oom.hint": return t("health.oom.hint");
    case "health.concurrency.title.warn": return t("health.concurrency.title");
    case "health.concurrency.hint": return t("health.concurrency.hint");
    case "health.link-speed.title.warn": return t("health.linkSpeed.title");
    case "health.link-speed.hint": return t("health.linkSpeed.hint");
    case "health.roce-link.title.critical": return t("health.roceLink.title", { count: meta.params?.count });
    case "health.roce-link.hint": return t("health.roceLink.hint");
    case "health.roce-loss.title.warn": return t("health.roceLoss.title");
    case "health.roce-loss.hint": return t("health.roceLoss.hint");
    case "event.sparkOnline": return t("event.sparkOnline", { name: meta.params?.name });
    case "event.sparkOffline": return t("event.sparkOffline", { name: meta.params?.name });
    case "event.sparkAdded": return t("event.sparkAdded", { name: meta.params?.name });
    case "event.sparkRemoved": return t("event.sparkRemoved", { name: meta.params?.name });
    case "event.shutdownRequested": return t("event.shutdownRequested", { name: meta.params?.name });
    case "event.wakeSent": return t("event.wakeSent", { name: meta.params?.name });
    default: return fallback;
  }
}

export function useServerMessage() {
  const { t } = useTranslation("serverMessages");
  return (meta: ServerMessageDescriptor | undefined, fallback: string) => renderServerMessage(t, meta, fallback);
}
