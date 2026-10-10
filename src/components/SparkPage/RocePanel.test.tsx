import { describe, expect, it } from "vitest";
import type { RoceDevice, RoceMetrics } from "../../api/types";
import { RocePanel, pfcLabel } from "./RocePanel";
import { render } from "../../testing/render";

const device = (over: Partial<RoceDevice> = {}): RoceDevice => ({
  name: "rocep1s0f0",
  netdev: "enp1s0f0np0",
  state: "ACTIVE",
  physState: "LinkUp",
  active: true,
  everActive: true,
  rateGbps: 200,
  linkLayer: "Ethernet",
  operstate: "up",
  mtu: 9000,
  speedMbps: 200000,
  rxBps: 1_048_576,
  txBps: 2_097_152,
  rxErrors: 0,
  txErrors: 0,
  rxDropped: 3,
  txDropped: 0,
  counters: { out_of_buffer: 12, packet_seq_err: 0, np_cnp_sent: 7 },
  deltas: { out_of_buffer: 4 },
  loss: { rising: ["out_of_buffer"], streak: 1 },
  eth: { rx_discards_phy: 2, rx_crc_errors_phy: 0 },
  flowControl: { rx: true, tx: true },
  qos: { trust: "pcp", pfcPriorities: [], cableLen: 7, dscpMap: null },
  ...over,
});

const metrics = (devices: RoceDevice[]): RoceMetrics => ({ available: true, sampledAt: 1, devices });

describe("RocePanel", () => {
  it("renders nothing without RDMA devices", () => {
    const { container } = render(<RocePanel roce={null} />);
    expect(container.textContent).toBe("");
    expect(render(<RocePanel roce={metrics([])} />).container.textContent).toBe("");
  });

  it("shows link, speed, MTU, traffic, PFC and a rising-loss hint per port", () => {
    const { container } = render(<RocePanel roce={metrics([device()])} />);
    const text = container.textContent ?? "";
    expect(text).toContain("RoCE / RDMA");
    expect(text).toContain("enp1s0f0np0");
    expect(text).toContain("ACTIVE");
    expect(text).toContain("200 Gb/s");
    expect(text).toContain("MTU 9000");
    expect(text).toContain("1.0 MB/s");
    expect(text).toContain("PFC off");
    expect(text).toContain("trust pcp");
    expect(text).toContain("loss rising");
    expect(text).toContain("1/1 up");
    // counters are in the collapsible section, with the change since the last sample
    expect(text).toContain("Out of buffer");
    expect(text).toContain("+4");
    expect(text).toContain("RX discards");
  });

  it("marks a port that was up and is down, and lists never-connected ports separately", () => {
    const down = device({ state: "DOWN", physState: "Disabled", active: false, rxBps: null, txBps: null });
    const idle = device({ name: "rocep9", netdev: "enp9", state: "DOWN", active: false, everActive: false });
    const { container } = render(<RocePanel roce={metrics([down, idle])} />);
    expect(container.querySelector('[data-testid="roce-rocep1s0f0"]')?.className).toContain("is-down");
    expect(container.textContent).toContain("1 port not connected: enp9");
    expect(container.textContent).toContain("0/2 up");
  });

  it("describes PFC from mlnx_qos", () => {
    expect(pfcLabel(device({ qos: { trust: "dscp", pfcPriorities: [3], cableLen: 7, dscpMap: null } }))?.text).toBe("PFC on: 3");
    expect(pfcLabel(device({ qos: null }))).toBeNull();
  });
});
