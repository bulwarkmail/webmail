import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUSH_NOTIFICATION_PROMPT_DELAY_MS, PushNotificationPrompt } from "../push-notification-prompt";
import { PWA_INSTALL_PROMPT_VISIBILITY_EVENT } from "../pwa-install-prompt";

const mocks = vi.hoisted(() => ({
  pathname: "/en",
  enabled: false,
  supported: true,
  enableWebPush: vi.fn(),
  isWebPushEnabled: vi.fn(),
  authState: {
    client: { getAccountId: () => "account-1" } as {
      getAccountId: () => string;
    },
    username: "alice@example.com",
    isAuthenticated: true,
    isDemoMode: false,
  },
  settingsState: { emailNotificationsEnabled: true, pushRelayUrl: "" },
  policyState: {
    loaded: true,
    policy: {
      pushRelayUrl: "https://notifications.relay.bulwarkmail.org",
      pushRelays: [] as { label: string; url: string }[],
      pushRelayUrlLocked: false,
    },
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (state: typeof mocks.authState) => unknown) =>
    selector(mocks.authState),
}));

vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: (
    selector: (state: typeof mocks.settingsState) => unknown,
  ) => selector(mocks.settingsState),
}));

vi.mock("@/stores/policy-store", () => ({
  usePolicyStore: (selector: (state: typeof mocks.policyState) => unknown) =>
    selector(mocks.policyState),
}));

vi.mock("@/lib/web-push", () => ({
  DEFAULT_RELAY_BASE_URL: "https://notifications.relay.bulwarkmail.org",
  enableWebPush: mocks.enableWebPush,
  isWebPushSupported: () => mocks.supported,
  isWebPushEnabled: mocks.isWebPushEnabled,
}));

function setNotificationPermission(permission: NotificationPermission) {
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: { permission },
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: { permission },
  });
}

async function advancePromptDelay() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PUSH_NOTIFICATION_PROMPT_DELAY_MS);
  });
}

describe("PushNotificationPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    mocks.pathname = "/en";
    mocks.supported = true;
    mocks.enabled = false;
    mocks.authState.client = { getAccountId: () => "account-1" };
    mocks.authState.username = "alice@example.com";
    mocks.authState.isAuthenticated = true;
    mocks.authState.isDemoMode = false;
    mocks.settingsState.emailNotificationsEnabled = true;
    mocks.settingsState.pushRelayUrl = "";
    mocks.policyState.loaded = true;
    mocks.policyState.policy.pushRelayUrl =
      "https://notifications.relay.bulwarkmail.org";
    mocks.policyState.policy.pushRelays = [];
    mocks.policyState.policy.pushRelayUrlLocked = false;
    mocks.enableWebPush.mockReset().mockResolvedValue({ subscriptionId: "sub-1" });
    mocks.isWebPushEnabled.mockReset().mockImplementation(async () => mocks.enabled);
    setNotificationPermission("default");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("offers onboarding when the current account has no push subscription", async () => {
    render(<PushNotificationPrompt />);
    await advancePromptDelay();

    expect(screen.getByText("title")).toBeInTheDocument();
    expect(mocks.isWebPushEnabled).toHaveBeenCalledWith("account-1");
  });

  it("enables push through the existing web-push flow", async () => {
    render(<PushNotificationPrompt />);
    await advancePromptDelay();

    await act(async () => {
      fireEvent.click(screen.getByText("enable"));
      await Promise.resolve();
    });

    expect(mocks.enableWebPush).toHaveBeenCalledWith({
      client: mocks.authState.client,
      relayBaseUrl: "https://notifications.relay.bulwarkmail.org",
      accountLabel: "alice@example.com",
    });
    expect(screen.queryByText("title")).not.toBeInTheDocument();
  });

  it("registers with the relay the user picked from the admin list", async () => {
    mocks.policyState.policy.pushRelays = [
      { label: "Company", url: "https://push.company.example" },
    ];
    mocks.settingsState.pushRelayUrl = "https://push.company.example";

    render(<PushNotificationPrompt />);
    await advancePromptDelay();

    await act(async () => {
      fireEvent.click(screen.getByText("enable"));
      await Promise.resolve();
    });

    expect(mocks.enableWebPush).toHaveBeenCalledWith(
      expect.objectContaining({ relayBaseUrl: "https://push.company.example" }),
    );
  });

  it("falls back to the default relay when the user's pick is no longer offered", async () => {
    mocks.settingsState.pushRelayUrl = "https://push.removed.example";

    render(<PushNotificationPrompt />);
    await advancePromptDelay();

    await act(async () => {
      fireEvent.click(screen.getByText("enable"));
      await Promise.resolve();
    });

    expect(mocks.enableWebPush).toHaveBeenCalledWith(
      expect.objectContaining({
        relayBaseUrl: "https://notifications.relay.bulwarkmail.org",
      }),
    );
  });

  it("does not render when push is already enabled", async () => {
    mocks.enabled = true;
    render(<PushNotificationPrompt />);
    await advancePromptDelay();

    expect(screen.queryByText("title")).not.toBeInTheDocument();
  });

  it("does not render when browser notifications are blocked", async () => {
    setNotificationPermission("denied");
    render(<PushNotificationPrompt />);
    await advancePromptDelay();

    expect(mocks.isWebPushEnabled).not.toHaveBeenCalled();
    expect(screen.queryByText("title")).not.toBeInTheDocument();
  });

  it("does not render on the settings route", async () => {
    mocks.pathname = "/en/settings";
    render(<PushNotificationPrompt />);
    await advancePromptDelay();

    expect(mocks.isWebPushEnabled).not.toHaveBeenCalled();
  });

  it("persists the per-account don't-remind choice", async () => {
    const { unmount } = render(<PushNotificationPrompt />);
    await advancePromptDelay();
    fireEvent.click(screen.getByText("dont_remind"));

    expect(
      localStorage.getItem("bulwark.push.onboarding.dismissed.v1.account-1"),
    ).toBe("1");

    unmount();
    mocks.isWebPushEnabled.mockClear();
    render(<PushNotificationPrompt />);
    await advancePromptDelay();
    expect(mocks.isWebPushEnabled).not.toHaveBeenCalled();
  });

  it("keeps the session dismissal of every account that was dismissed", async () => {
    const { rerender } = render(<PushNotificationPrompt />);
    await advancePromptDelay();
    fireEvent.click(screen.getByText("not_now"));

    mocks.authState.client = { getAccountId: () => "account-2" };
    rerender(<PushNotificationPrompt />);
    await advancePromptDelay();
    expect(screen.getByText("title")).toBeInTheDocument();
    fireEvent.click(screen.getByText("not_now"));

    mocks.authState.client = { getAccountId: () => "account-1" };
    rerender(<PushNotificationPrompt />);
    await advancePromptDelay();
    expect(screen.queryByText("title")).not.toBeInTheDocument();
  });

  it("defers push onboarding until the PWA install prompt is closed", async () => {
    render(<PushNotificationPrompt />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent(PWA_INSTALL_PROMPT_VISIBILITY_EVENT, {
          detail: { visible: true },
        }),
      );
    });
    await advancePromptDelay();

    expect(mocks.isWebPushEnabled).not.toHaveBeenCalled();
    expect(screen.queryByText("title")).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(PWA_INSTALL_PROMPT_VISIBILITY_EVENT, {
          detail: { visible: false },
        }),
      );
    });
    await advancePromptDelay();

    expect(mocks.isWebPushEnabled).toHaveBeenCalledWith("account-1");
    expect(screen.getByText("title")).toBeInTheDocument();
  });
});
