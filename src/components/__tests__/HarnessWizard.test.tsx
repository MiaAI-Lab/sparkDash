import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HarnessWizard } from "../HarnessWizard";
import type { SessionSources, SessionSourcesHealth } from "../../api/types";

// Mock the API client
vi.mock("../../api/client", () => ({
  fetchSessionSources: vi.fn(),
  testSessionSources: vi.fn(),
  updateSessionSources: vi.fn(),
}));

import { fetchSessionSources, testSessionSources, updateSessionSources } from "../../api/client";

const mockSources: SessionSources = {
  openclaw: [{
    id: "openclaw",
    enabled: false,
    mode: "url",
    url: "",
    stateDir: "",
    hasToken: false,
    conventionalStateDir: "~/.openclaw",
    kindLabel: "OpenClaw",
    urlPlaceholder: "http://127.0.0.1:18789",
    usesUsername: false,
    description: "Gateway state directory or HTTP API",
    remoteOnly: undefined,
    helperHuman: undefined,
    helperAgent: undefined,
  }],
  hermes: [{
    id: "hermes",
    enabled: false,
    mode: "url",
    url: "",
    stateDir: "",
    hasToken: false,
    conventionalStateDir: "~/.hermes",
    kindLabel: "Hermes Agent",
    urlPlaceholder: "http://127.0.0.1:8787",
    usesUsername: true,
    description: "Hermes home directory or HTTP API",
  }],
  opencode: [{
    id: "opencode",
    enabled: false,
    mode: "url",
    url: "",
    stateDir: "",
    hasToken: false,
    conventionalStateDir: "~/.local/share/opencode",
    kindLabel: "OpenCode",
    urlPlaceholder: "http://127.0.0.1:8788/occupancy",
    usesUsername: false,
    description: "Local SQLite database or remote helper",
    helperHuman: "OPENCODE_OCCUPANCY_BIND=... node scripts/opencode-occupancy-helper/index.js",
    helperAgent: "# Run on the machine that has OpenCode\nOPENCODE_OCCUPANCY_BIND=... node scripts/opencode-occupancy-helper/index.js",
  }],
  omp: [{
    id: "omp",
    enabled: false,
    mode: "url",
    url: "",
    stateDir: "",
    hasToken: false,
    conventionalStateDir: "~/.omp",
    kindLabel: "oh-my-pi",
    urlPlaceholder: "http://127.0.0.1:8789/occupancy",
    usesUsername: false,
    description: "Local state directory or remote helper",
    helperHuman: "OMP_OCCUPANCY_BIND=... node scripts/omp-occupancy-helper/index.js",
    helperAgent: "# Run on the machine that has oh-my-pi\nOMP_OCCUPANCY_BIND=... node scripts/omp-occupancy-helper/index.js",
  }],
  dsh: [{
    id: "dsh",
    enabled: false,
    mode: "url",
    url: "",
    stateDir: "",
    hasToken: false,
    conventionalStateDir: "",
    kindLabel: "DeepSeek Harness",
    urlPlaceholder: "http://127.0.0.1:8791/occupancy",
    usesUsername: false,
    description: "Remote web API — requires a helper",
    remoteOnly: true,
    helperHuman: "DSH_OCCUPANCY_TOKEN=... node scripts/dsh-occupancy-helper/index.js",
    helperAgent: "# Run on the machine that hosts dsh web\nDSH_OCCUPANCY_TOKEN=... node scripts/dsh-occupancy-helper/index.js",
  }],
};

const mockHealth: SessionSourcesHealth = {
  openclaw: [{ status: "ok", found: 3, mapped: 3, error: null }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchSessionSources).mockResolvedValue(mockSources);
  vi.mocked(testSessionSources).mockResolvedValue(mockHealth);
  vi.mocked(updateSessionSources).mockResolvedValue(mockSources);
});

describe("HarnessWizard", () => {
  it("renders the pick step with all five harness kinds", async () => {
    render(<HarnessWizard open={true} onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("OpenClaw")).toBeInTheDocument();
    });

    expect(screen.getByText("Hermes Agent")).toBeInTheDocument();
    expect(screen.getByText("OpenCode")).toBeInTheDocument();
    expect(screen.getByText("oh-my-pi")).toBeInTheDocument();
    expect(screen.getByText("DeepSeek Harness")).toBeInTheDocument();
  });

  it("shows 'Connect your harnesses' title with no 'occupancy' or 'session source' text", async () => {
    render(<HarnessWizard open={true} onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Connect your harnesses")).toBeInTheDocument();
    });

    // AE6: no user-facing string contains "occupancy" or "session source"
    const body = document.body.textContent || "";
    expect(body).not.toMatch(/occupancy source/i);
    expect(body).not.toMatch(/session source/i);
  });

  it("disables Next when no harness is selected", async () => {
    render(<HarnessWizard open={true} onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Next")).toBeInTheDocument();
    });

    expect(screen.getByText("Next")).toBeDisabled();
  });

  it("enables Next after selecting a harness and navigates to configure step", async () => {
    const user = userEvent.setup();
    render(<HarnessWizard open={true} onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("OpenClaw")).toBeInTheDocument();
    });

    await user.click(screen.getByText("OpenClaw"));
    expect(screen.getByText("Next")).not.toBeDisabled();

    await user.click(screen.getByText("Next"));
    expect(screen.getByText(/Where does OpenClaw run/)).toBeInTheDocument();
  });

  it("AE1: switching OpenCode from remote to local replaces URL/token with state-dir field", async () => {
    const user = userEvent.setup();
    render(<HarnessWizard open={true} onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("OpenCode")).toBeInTheDocument();
    });

    await user.click(screen.getByText("OpenCode"));
    await user.click(screen.getByText("Next"));

    // OpenCode defaults to remote (mode=url in mock), so URL field should be visible
    expect(screen.getByPlaceholderText("http://127.0.0.1:8788/occupancy")).toBeInTheDocument();

    // Switch to local
    await user.click(screen.getByText("This machine"));

    // URL field should be gone, state-dir field should appear
    await waitFor(() => {
      expect(screen.queryByPlaceholderText("http://127.0.0.1:8788/occupancy")).not.toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("~/.local/share/opencode")).toBeInTheDocument();
  });

  it("AE2: dsh skips local/remote toggle and shows remote fields directly", async () => {
    const user = userEvent.setup();
    render(<HarnessWizard open={true} onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("DeepSeek Harness")).toBeInTheDocument();
    });

    await user.click(screen.getByText("DeepSeek Harness"));
    await user.click(screen.getByText("Next"));

    // No local/remote toggle should appear
    expect(screen.queryByText("This machine")).not.toBeInTheDocument();
    expect(screen.queryByText("Another machine")).not.toBeInTheDocument();

    // URL field should be visible (remote mode by default for remoteOnly)
    expect(screen.getByPlaceholderText("http://127.0.0.1:8791/occupancy")).toBeInTheDocument();
  });

  it("AE3: OpenClaw remote mode shows URL field with no helper snippet", async () => {
    const user = userEvent.setup();
    render(<HarnessWizard open={true} onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("OpenClaw")).toBeInTheDocument();
    });

    await user.click(screen.getByText("OpenClaw"));
    await user.click(screen.getByText("Next"));

    // OpenClaw defaults to remote — URL field visible
    expect(screen.getByPlaceholderText("http://127.0.0.1:18789")).toBeInTheDocument();

    // No helper snippet toggle (OpenClaw has no helperHuman)
    expect(screen.queryByText("Run it yourself")).not.toBeInTheDocument();
    expect(screen.queryByText("Have an agent set it up")).not.toBeInTheDocument();
  });

  it("AE4: failed check shows error but does not block advancing", async () => {
    vi.mocked(testSessionSources).mockRejectedValueOnce(new Error("Connection refused"));

    const user = userEvent.setup();
    render(<HarnessWizard open={true} onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("OpenClaw")).toBeInTheDocument();
    });

    await user.click(screen.getByText("OpenClaw"));
    await user.click(screen.getByText("Next"));

    // Enter a URL so Check is enabled
    await user.type(screen.getByPlaceholderText("http://127.0.0.1:18789"), "http://10.0.0.1:18789");
    await user.click(screen.getByText("Check connection"));

    await waitFor(() => {
      expect(screen.getByText(/Connection refused/)).toBeInTheDocument();
    });

    // Can still advance to review
    expect(screen.getByText("Next")).not.toBeDisabled();
  });

  it("AE5: review step lists configured harnesses with mode and check status", async () => {
    const user = userEvent.setup();
    render(<HarnessWizard open={true} onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("OpenClaw")).toBeInTheDocument();
    });

    await user.click(screen.getByText("OpenClaw"));
    await user.click(screen.getByText("Next"));
    await user.click(screen.getByText("Next")); // skip configure, go to review

    // Review step should show OpenClaw
    expect(screen.getByText("Review and save")).toBeInTheDocument();
    expect(screen.getByText("OpenClaw")).toBeInTheDocument();
    expect(screen.getByText("Not checked")).toBeInTheDocument();
  });

  it("save calls updateSessionSources and closes wizard", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<HarnessWizard open={true} onClose={onClose} onSaved={onSaved} />);

    await waitFor(() => {
      expect(screen.getByText("OpenClaw")).toBeInTheDocument();
    });

    await user.click(screen.getByText("OpenClaw"));
    await user.click(screen.getByText("Next"));
    await user.click(screen.getByText("Next")); // skip to review
    await user.click(screen.getByText("Save harnesses"));

    await waitFor(() => {
      expect(updateSessionSources).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("save failure keeps wizard open and shows error", async () => {
    vi.mocked(updateSessionSources).mockRejectedValueOnce(new Error("Server error"));
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<HarnessWizard open={true} onClose={onClose} onSaved={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("OpenClaw")).toBeInTheDocument();
    });

    await user.click(screen.getByText("OpenClaw"));
    await user.click(screen.getByText("Next"));
    await user.click(screen.getByText("Next"));
    await user.click(screen.getByText("Save harnesses"));

    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeInTheDocument();
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("back button navigates to previous step without losing draft", async () => {
    const user = userEvent.setup();
    render(<HarnessWizard open={true} onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("OpenClaw")).toBeInTheDocument();
    });

    await user.click(screen.getByText("OpenClaw"));
    await user.click(screen.getByText("Next"));

    // On configure step
    expect(screen.getByText(/Where does OpenClaw run/)).toBeInTheDocument();

    // Enter a label
    await user.type(screen.getByPlaceholderText("e.g. theshop"), "my-label");

    // Go back to pick step
    await user.click(screen.getByText("Back"));
    expect(screen.getByText("Connect your harnesses")).toBeInTheDocument();

    // Navigate forward again — the label should be preserved
    await user.click(screen.getByText("Next"));
    expect(screen.getByDisplayValue("my-label")).toBeInTheDocument();
  });

  it("helper harnesses show both Run it yourself and Have an agent set it up toggle", async () => {
    const user = userEvent.setup();
    render(<HarnessWizard open={true} onClose={() => {}} onSaved={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("OpenCode")).toBeInTheDocument();
    });

    await user.click(screen.getByText("OpenCode"));
    await user.click(screen.getByText("Next"));

    expect(screen.getByText("Run it yourself")).toBeInTheDocument();
    expect(screen.getByText("Have an agent set it up")).toBeInTheDocument();
  });
});
