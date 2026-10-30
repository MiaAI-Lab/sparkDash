import test from "node:test";
import assert from "node:assert/strict";
import { PowerMeterProvider, assertProviderClass } from "../providers/PowerMeterProvider.js";
import { HomeAssistantProvider } from "../providers/HomeAssistantProvider.js";
import { createProvider, providerClass, providerTypes, registerProvider } from "../providers/index.js";

test("the base class is abstract and its defaults describe a live-only meter", () => {
  assert.throws(() => new PowerMeterProvider({}), /abstract/);
  class Plug extends PowerMeterProvider {
    static type = "plug";
    static label = "Smart plug";
    async readPower(channels) {
      return new Map(channels.map((c) => [c, { watts: 1, atMs: 0 }]));
    }
  }
  const plug = new Plug({ type: "plug" });
  assert.equal(plug.type, "plug");
  assert.equal(plug.label, "Smart plug");
  assert.deepEqual(plug.historyPeriods, []);
  assert.equal(plug.supportsHistory, false);
  assert.deepEqual(plug.describe(), { type: "plug", target: null });
  assert.deepEqual(Plug.validate({}), []);
  assert.equal(Plug.validateChannel("anything"), null);
  assert.equal(assertProviderClass(Plug), Plug);
});

test("a provider class must satisfy the interface to be registered", () => {
  class NoType extends PowerMeterProvider {
    async readPower() {
      return new Map();
    }
  }
  class NoRead extends PowerMeterProvider {
    static type = "noread";
    static label = "No read";
  }
  class NoLabel extends PowerMeterProvider {
    static type = "nolabel";
    async readPower() {
      return new Map();
    }
  }
  class ClaimsHistory extends PowerMeterProvider {
    static type = "claims";
    static label = "Claims";
    static historyPeriods = ["hour"];
    async readPower() {
      return new Map();
    }
  }
  class HidesHistory extends PowerMeterProvider {
    static type = "hides";
    static label = "Hides";
    async readPower() {
      return new Map();
    }
    async readHistory() {
      return new Map();
    }
  }
  class OddPeriod extends PowerMeterProvider {
    static type = "odd";
    static label = "Odd";
    static historyPeriods = ["week"];
    async readPower() {
      return new Map();
    }
  }
  assert.throws(() => assertProviderClass({ type: "duck", readPower() {} }), /must extend PowerMeterProvider/);
  assert.throws(() => assertProviderClass(NoType), /type must be a lowercase provider name/);
  assert.throws(() => assertProviderClass(NoLabel), /label must name the meter/);
  assert.throws(() => assertProviderClass(NoRead), /must implement readPower/);
  assert.throws(() => assertProviderClass(ClaimsHistory), /does not implement readHistory/);
  assert.throws(() => assertProviderClass(HidesHistory), /lists no historyPeriods/);
  assert.throws(() => assertProviderClass(OddPeriod), /historyPeriods may only contain/);
});

test("the registry knows Home Assistant and refuses duplicates and unknown types", () => {
  assert.deepEqual(providerTypes(), ["homeassistant"]);
  assert.equal(providerClass("homeassistant"), HomeAssistantProvider);
  assert.equal(providerClass("nope"), null);
  assert.throws(() => registerProvider(HomeAssistantProvider), /already registered/);
  assert.throws(() => createProvider({ type: "nope" }), /unknown power-meter type/);
  const ha = createProvider({ type: "homeassistant", url: "https://ha.lan" }, { env: { HOME_ASSISTANT_TOKEN: "t" } });
  assert.ok(ha instanceof HomeAssistantProvider);
  assert.equal(ha.label, "Home Assistant");
});
