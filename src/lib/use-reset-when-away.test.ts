import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, type Mock, vi } from "vitest";

import { useResetWhenAway } from "@/lib/use-reset-when-away";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn<typeof invoke>() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn<typeof getCurrentWindow>(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn<typeof relaunch>(),
}));

const ONE_HOUR = 60 * 60 * 1000;
const T0 = new Date("2026-07-24T08:00:00Z").getTime();

// Captured from the hook's getCurrentWindow().onFocusChanged registration, so
// tests can simulate OS focus/blur by calling it directly.
let focusCb!: (event: { payload: boolean }) => void;
let unlisten: Mock<() => void>;
let reload: Mock<() => void>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  unlisten = vi.fn<() => void>();
  reload = vi.fn<() => void>();
  // the hook reloads via window.location.reload, which jsdom defines as a
  // non-configurable no-op; replace the whole location object with a spy-backed
  // stub (the hook only touches reload)
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { reload },
  });
  vi.mocked(getCurrentWindow).mockReturnValue({
    onFocusChanged: (cb: (event: { payload: boolean }) => void) => {
      focusCb = cb;
      return Promise.resolve(unlisten);
    },
  } as unknown as ReturnType<typeof getCurrentWindow>);
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.mocked(relaunch).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// Drain the invoke → reload / error promise chain. Real timers are faked, but
// microtasks still run; flush a few hops to settle the chain.
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function fire(focused: boolean) {
  await act(async () => {
    focusCb({ payload: focused });
    await flushMicrotasks();
  });
}

it("closes browsers then reloads after ≥1h away", async () => {
  renderHook(() => useResetWhenAway());
  vi.setSystemTime(T0);
  await fire(false); // blur
  vi.setSystemTime(T0 + ONE_HOUR); // exactly 1h → not < threshold, so resets
  await fire(true); // focus

  expect(invoke).toHaveBeenCalledWith("close_browsers");
  expect(reload).toHaveBeenCalledTimes(1);
  expect(relaunch).not.toHaveBeenCalled();
});

it("does not reset when away less than 1h", async () => {
  renderHook(() => useResetWhenAway());
  vi.setSystemTime(T0);
  await fire(false);
  vi.setSystemTime(T0 + ONE_HOUR - 1); // just under the threshold
  await fire(true);

  expect(invoke).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  expect(relaunch).not.toHaveBeenCalled();
});

it("ignores a focus with no preceding blur", async () => {
  renderHook(() => useResetWhenAway());
  vi.setSystemTime(T0 + 10 * ONE_HOUR);
  await fire(true); // focus without a recorded blur

  expect(invoke).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("retries a busy browser reset and reloads only after teardown succeeds", async () => {
  vi.mocked(invoke)
    .mockRejectedValueOnce(new Error("The headed browser is busy"))
    .mockResolvedValue(undefined);
  renderHook(() => useResetWhenAway());
  vi.setSystemTime(T0);
  await fire(false);
  vi.setSystemTime(T0 + ONE_HOUR);
  await fire(true);

  expect(invoke).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();

  await act(async () => {
    await vi.runAllTimersAsync();
    await flushMicrotasks();
  });

  expect(invoke).toHaveBeenCalledTimes(2);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(relaunch).not.toHaveBeenCalled();
});

it("bails safely after bounded retries and allows a later reset attempt", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("The headed browser is busy"));
  renderHook(() => useResetWhenAway());
  vi.setSystemTime(T0);
  await fire(false);
  vi.setSystemTime(T0 + ONE_HOUR);
  await fire(true);

  await act(async () => {
    await vi.runAllTimersAsync();
    await flushMicrotasks();
  });

  expect(invoke).toHaveBeenCalledTimes(3);
  expect(relaunch).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();

  vi.setSystemTime(T0 + 2 * ONE_HOUR);
  await fire(false);
  vi.setSystemTime(T0 + 3 * ONE_HOUR);
  await fire(true);
  await act(async () => {
    await vi.runAllTimersAsync();
    await flushMicrotasks();
  });

  expect(invoke).toHaveBeenCalledTimes(6);
  expect(relaunch).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("measures away time from the first blur, ignoring a spurious re-blur", async () => {
  renderHook(() => useResetWhenAway());
  vi.setSystemTime(T0);
  await fire(false); // first blur
  vi.setSystemTime(T0 + 30 * 60 * 1000);
  await fire(false); // spurious re-blur must not restart the clock
  vi.setSystemTime(T0 + ONE_HOUR + 5 * 60 * 1000); // 1h05 after the FIRST blur
  await fire(true);

  // measured from the first blur (1h05 ≥ 1h) → resets; from the second (35m)
  // it would not
  expect(invoke).toHaveBeenCalledWith("close_browsers");
  expect(reload).toHaveBeenCalledTimes(1);
});

it("unregisters the focus listener on unmount", async () => {
  const { unmount } = renderHook(() => useResetWhenAway());
  // let the async onFocusChanged registration store its unlisten fn
  await act(async () => {
    await flushMicrotasks();
  });
  unmount();

  expect(unlisten).toHaveBeenCalledTimes(1);
});
