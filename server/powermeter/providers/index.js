import { HomeAssistantProvider } from "./HomeAssistantProvider.js";
import { PowerMeterProvider, assertProviderClass } from "./PowerMeterProvider.js";

/** @type {Map<string, typeof PowerMeterProvider>} */
const registry = new Map();

/**
 * Make a provider class available as a `type` in power-meters.json.
 * @param {typeof PowerMeterProvider} Provider
 */
export function registerProvider(Provider) {
  assertProviderClass(Provider);
  if (registry.has(Provider.type)) throw new Error(`power-meter type "${Provider.type}" is already registered`);
  registry.set(Provider.type, Provider);
  return Provider;
}

registerProvider(HomeAssistantProvider);

/** @returns {string[]} */
export function providerTypes() {
  return [...registry.keys()];
}

/** @returns {typeof PowerMeterProvider | null} */
export function providerClass(type) {
  return registry.get(type) ?? null;
}

/**
 * Instantiate the provider for a validated meter entry.
 * @param {{ type: string }} spec
 * @param {object} [deps]
 * @returns {PowerMeterProvider}
 */
export function createProvider(spec, deps = {}) {
  const Provider = registry.get(spec?.type);
  if (!Provider) throw new Error(`unknown power-meter type "${spec?.type}"`);
  return new Provider(spec, deps);
}

export { PowerMeterProvider };
