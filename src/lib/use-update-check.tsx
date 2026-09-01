import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";

import { toastError } from "./utils";

// The release the updater found is published under its own tag, so its notes
// are the change log for exactly the version being offered.
const releaseNotesUrl = (version: string) =>
  `https://github.com/tasjen/flexireport/releases/tag/v${version}`;

export function useUpdateCheck() {
  useEffect(() => {
    if (import.meta.env.DEV) {
      return;
    }
    check()
      .then((update) => {
        if (!update) {
          return;
        }
        const version = update.version;
        toast.info(i18n._(msg`Update available: v${version}`), {
          duration: Number.POSITIVE_INFINITY,
          closeButton: true,
          description: (
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1 font-semibold hover:underline"
              onClick={() => {
                openUrl(releaseNotesUrl(version)).catch(toastError);
              }}
            >
              {i18n._(msg`View change log`)}
              <ExternalLinkIcon className="size-3" />
            </button>
          ),
          action: {
            label: i18n._(msg`Update & restart`),
            onClick: () => {
              // On Windows the NSIS installer exits the app itself before
              // relaunch() is reached; the relaunch matters on macOS.
              toast.promise(update.downloadAndInstall().then(relaunch), {
                loading: i18n._(msg`Downloading update…`),
                success: i18n._(msg`Restarting…`),
                error: (error) => i18n._(msg`Update failed: ${String(error)}`),
              });
            },
          },
        });
      })
      .catch(() => {
        // Offline or the release endpoint is unreachable — a launch-time
        // update check is not worth surfacing errors for.
      });
  }, []);
}
