import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-config", () => ({ useConfig: () => ({ appName: "Webmail" }) }));

const update = vi.hoisted(() => ({
  newerBuildId: vi.fn<() => Promise<string | null>>(),
  reloadToNewBuild: vi.fn(async () => {}),
}));
vi.mock("@/lib/app-update", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-update")>()),
  newerBuildId: update.newerBuildId,
  reloadToNewBuild: update.reloadToNewBuild,
}));

import { AppUpdatePrompt, UPDATE_CHECK_MS } from "../app-update-prompt";
import { useToastStore } from "@/stores/toast-store";

const toasts = () => useToastStore.getState().toasts;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AppUpdatePrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useToastStore.setState({ toasts: [] });
    update.newerBuildId.mockReset();
    update.reloadToNewBuild.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers a reload once the server runs another build", async () => {
    update.newerBuildId.mockResolvedValue(null);
    render(<AppUpdatePrompt />);
    await act(async () => { vi.advanceTimersByTime(UPDATE_CHECK_MS); });
    await flush();
    expect(update.newerBuildId).toHaveBeenCalledTimes(1);
    expect(toasts()).toHaveLength(0);

    update.newerBuildId.mockResolvedValue("build-b");
    await act(async () => { vi.advanceTimersByTime(UPDATE_CHECK_MS); });
    await flush();
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].title).toBe("ready");
    expect(toasts()[0].action?.label).toBe("reload");
    toasts()[0].action?.onClick();
    expect(update.reloadToNewBuild).toHaveBeenCalled();

    // The same build isn't offered twice.
    await act(async () => { vi.advanceTimersByTime(UPDATE_CHECK_MS); });
    await flush();
    expect(toasts()).toHaveLength(1);
  });

  it("keeps one toast when several builds go out while the tab is open", async () => {
    render(<AppUpdatePrompt />);
    for (const id of ["build-b", "build-c", "build-d"]) {
      update.newerBuildId.mockResolvedValue(id);
      await act(async () => { vi.advanceTimersByTime(UPDATE_CHECK_MS); });
      await flush();
    }
    expect(update.newerBuildId).toHaveBeenCalledTimes(3);
    expect(toasts()).toHaveLength(1);

    // Dismissed, the next build is offered again.
    act(() => { useToastStore.getState().removeToast(toasts()[0].id); });
    update.newerBuildId.mockResolvedValue("build-e");
    await act(async () => { vi.advanceTimersByTime(UPDATE_CHECK_MS); });
    await flush();
    expect(toasts()).toHaveLength(1);
  });

  it("checks when a chunk of this build fails to load", async () => {
    update.newerBuildId.mockResolvedValue("build-b");
    render(<AppUpdatePrompt />);
    const script = document.createElement("script");
    script.src = "http://localhost/_next/static/chunks/gone.js";
    document.body.appendChild(script);
    await act(async () => { script.dispatchEvent(new Event("error")); });
    await flush();
    expect(update.newerBuildId).toHaveBeenCalledTimes(1);
    expect(toasts()).toHaveLength(1);
  });

  it("checks on focus, at most once a minute", async () => {
    update.newerBuildId.mockResolvedValue(null);
    render(<AppUpdatePrompt />);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(update.newerBuildId).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(61_000); window.dispatchEvent(new Event("focus")); });
    await flush();
    expect(update.newerBuildId).toHaveBeenCalledTimes(1);
  });
});
