import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SparkSnapshot } from "../../api/types";
import { setLocale } from "../../i18n";
import { flush, render } from "../../testing/render";
import { fetchShutdownHelperPolicy, installShutdownHelper, shutdownSpark, wakeSpark } from "../../api/client";
import { isHelperInstallError, SparkActions } from "./SparkActions";

vi.mock("../../api/client", () => ({
  shutdownSpark: vi.fn(),
  wakeSpark: vi.fn(),
  installShutdownHelper: vi.fn(),
  fetchShutdownHelperPolicy: vi.fn(),
}));

function spark(): SparkSnapshot {
  return { id: "spark-one", name: "SparkOne", kind: "host", online: true, metrics: {}, llmPorts: [], hermes: null } as unknown as SparkSnapshot;
}

/** Open the shutdown dialog, type the confirm phrase, acknowledge and submit. */
async function confirmShutdown() {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(() =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Shut down")!
      .click()
  );
  await flush();
  const phrase = document.querySelector<HTMLInputElement>(".field-input--mono")!;
  await act(() => {
    setter.call(phrase, "poweroff");
    phrase.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  });
  await act(() => document.querySelector<HTMLButtonElement>(".modal-sheet__footer .btn--danger")!.click());
  await flush();
}

function helperPolicy() {
  return { passwordAllowed: true, plainPasswordAllowed: false, directPowerOff: false, installSupported: true };
}

beforeEach(async () => {
  await setLocale("en");
});

afterEach(async () => {
  await act(() => setLocale("en"));
});

it("detects the helper and sudo failures the installer can fix", () => {
  expect(isHelperInstallError("SSH to 100.78.243.41:22 failed: missing /usr/local/bin/spark-shutdown")).toBe(true);
  expect(isHelperInstallError("passwordless sudo required for /usr/local/bin/spark-shutdown")).toBe(true);
  expect(isHelperInstallError("passwordless sudo for /usr/local/bin/spark-shutdown is required — check the sudoers rule for the helper")).toBe(true);
  expect(isHelperInstallError("Spark unreachable: connection refused")).toBe(false);
  expect(isHelperInstallError("")).toBe(false);
});

it("offers the helper install when a shutdown fails on the missing helper", async () => {
  vi.mocked(shutdownSpark).mockRejectedValueOnce(new Error("SSH to 100.78.243.41:22 failed: missing /usr/local/bin/spark-shutdown"));
  vi.mocked(fetchShutdownHelperPolicy).mockResolvedValue(helperPolicy());
  render(<SparkActions spark={spark()} />);
  await confirmShutdown();
  await flush();

  expect(fetchShutdownHelperPolicy).toHaveBeenCalledWith("spark-one");
  expect(document.querySelector("#shutdown-helper-sudo-password")).not.toBeNull();
  expect(document.body.textContent).toContain("Install shutdown helper");
  expect(document.body.textContent).toContain("Sudo password for SparkOne");
});

it("leaves the actions unchanged when a shutdown fails for another reason", async () => {
  vi.mocked(shutdownSpark).mockRejectedValueOnce(new Error("Spark unreachable: connection refused"));
  render(<SparkActions spark={spark()} />);
  await confirmShutdown();
  await flush();

  expect(fetchShutdownHelperPolicy).not.toHaveBeenCalled();
  expect(document.querySelector("#shutdown-helper-sudo-password")).toBeNull();
});

it("installs with the typed sudo password and retries the shutdown", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(shutdownSpark)
      .mockRejectedValueOnce(new Error("SSH to 100.78.243.41:22 failed: missing /usr/local/bin/spark-shutdown"))
      .mockResolvedValueOnce({ success: true, message: "Shutdown initiated" });
    vi.mocked(fetchShutdownHelperPolicy).mockResolvedValue(helperPolicy());
    vi.mocked(installShutdownHelper).mockResolvedValue({ success: true, message: "spark-shutdown helper installed" });
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SparkActions spark={spark()} />);
    await confirmShutdown();

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const pw = document.querySelector<HTMLInputElement>("#shutdown-helper-sudo-password")!;
    await act(() => {
      setter.call(pw, "s3cret");
      pw.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const install = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Install shutdown helper")!;
    await act(() => install.click());
    await flush();

    expect(confirmation).toHaveBeenCalledWith(expect.stringContaining("spark-shutdown helper"));
    expect(installShutdownHelper).toHaveBeenCalledWith("spark-one", "s3cret");
    // The panel closes and the original shutdown is retried on a timer.
    expect(document.querySelector("#shutdown-helper-sudo-password")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1200);
    });
    expect(shutdownSpark).toHaveBeenCalledTimes(2);
    confirmation.mockRestore();
  } finally {
    vi.useRealTimers();
  }
});

it("shows the installer's failure inside the panel and keeps it open", async () => {
  vi.mocked(shutdownSpark).mockRejectedValueOnce(new Error("SSH to 100.78.243.41:22 failed: missing /usr/local/bin/spark-shutdown"));
  vi.mocked(fetchShutdownHelperPolicy).mockResolvedValue(helperPolicy());
  vi.mocked(installShutdownHelper).mockRejectedValue(new Error("shutdown helper installation failed: sudo password was rejected"));
  const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<SparkActions spark={spark()} />);
  await confirmShutdown();
  await flush();

  const install = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Install shutdown helper")!;
  await act(() => install.click());
  await flush();

  expect(installShutdownHelper).toHaveBeenCalledWith("spark-one", undefined);
  const result = document.querySelector(".modal-sheet__error")!;
  expect(result.textContent).toContain("sudo password was rejected");
  expect(document.querySelector("#shutdown-helper-sudo-password")).not.toBeNull();
  confirmation.mockRestore();
});

it("hides the password field when the connection cannot carry one", async () => {
  vi.mocked(shutdownSpark).mockRejectedValueOnce(new Error("SSH to 100.78.243.41:22 failed: missing /usr/local/bin/spark-shutdown"));
  vi.mocked(fetchShutdownHelperPolicy).mockResolvedValue({ ...helperPolicy(), passwordAllowed: false });
  render(<SparkActions spark={spark()} />);
  await confirmShutdown();
  await flush();

  expect(document.querySelector("#shutdown-helper-sudo-password")).toBeNull();
  expect(document.body.textContent).toContain("A sudo password requires HTTPS");
});
