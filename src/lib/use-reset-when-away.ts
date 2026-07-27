import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";

import { toastError } from "./utils";

const IDLE_RESET_MS = 60 * 60 * 1000; // 1 hour unfocused → reset on return
const CLOSE_RETRY_ATTEMPTS = 3;
const CLOSE_RETRY_DELAY_MS = 500;

async function closeBrowsersWithRetry() {
  let lastError: unknown;
  for (let attempt = 0; attempt < CLOSE_RETRY_ATTEMPTS; attempt++) {
    try {
      await invoke("close_browsers");
      return;
    } catch (error) {
      lastError = error;
      if (attempt < CLOSE_RETRY_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, CLOSE_RETRY_DELAY_MS),
        );
      }
    }
  }
  throw lastError;
}

/**
 * Resets the app "as if restarted" when the window has been unfocused
 * (minimized or switched away from) for at least {@link IDLE_RESET_MS} and is
 * then focused again — without closing/reopening the OS window (unlike
 * `relaunch()`). Tears down both browser sessions so the next command relaunches
 * fresh, then reloads the webview to rebuild all UI/react-query state from
 * `store.json` + the backend.
 */
export function useResetWhenAway() {
  const blurredAt = useRef<number | null>(null);
  const isResetting = useRef(false);

  useEffect(() => {
    let cleanedUp = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) {
          // First blur wins: a spurious re-blur (e.g. a lock-screen
          // transition just before the user returns) must not shrink the
          // measured away time.
          blurredAt.current ??= Date.now();
          return;
        }
        const since = blurredAt.current;
        blurredAt.current = null;
        if (since === null || isResetting.current) return;
        if (Date.now() - since < IDLE_RESET_MS) return;

        isResetting.current = true;
        // Reload only after teardown settles, so the reloaded frontend's
        // first get_task_parameters starts against a clean backend. A busy
        // session leaves backend state untouched, so retry briefly and bail
        // safely rather than racing a whole-process relaunch.
        closeBrowsersWithRetry().then(
          () => window.location.reload(),
          (error) => {
            isResetting.current = false;
            toastError(error);
          },
        );
      })
      .then((fn) => {
        // The listener registers async; if the effect was cleaned up before
        // the promise resolved, unregister immediately instead of leaking.
        if (cleanedUp) fn();
        else unlisten = fn;
      })
      .catch(toastError);
    return () => {
      cleanedUp = true;
      unlisten?.();
    };
  }, []);
}
