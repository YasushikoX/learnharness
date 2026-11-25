"use client";

/**
 * The auto-update banner (Wave C, owner 2026-10-10: silent download +
 * restart-banner UX). The shell pushes "lh:update-status" once a staged
 * update exists (electron/main.cjs update-downloaded). Snapshot retrieval
 * also covers a late load. The card offers Restart alongside Settings.
 * Browser builds have no window.lh and never see a push: renders null.
 *
 * Dismissing hides this version for the mounted window only; the update
 * still installs on quit (autoInstallOnAppQuit) or via Settings.
 */

import { useState } from "react";
import { XIcon } from "lucide-react";
import { useUpdateState } from "@/components/settings/update-settings.tsx";
import { Button } from "@/components/ui/button";

export default function UpdateBanner() {
	const { state: ready } = useUpdateState();
	const [dismissedVersion, setDismissedVersion] = useState<string | null>();
	if (ready?.status !== "downloaded" || ready.version === dismissedVersion) return null;
	return (
		<div
			data-testid="update-banner"
			// positioned by the layout's notice stack (fork: shared with the
			// upstream release notice)
			className="pointer-events-auto flex items-center gap-2 lh-popover p-3 pl-4 text-sm"
		>
			<div className="text-sm">
				<span className="font-medium">LearnHarness {ready.version ?? "update"} is ready</span>
				<span className="text-muted-foreground"> — restart to finish installing.</span>
			</div>
			<Button
				type="button"
				onClick={() => window.lh?.installUpdate?.()}
				size="sm"
			>
				Restart
			</Button>
			<Button
				type="button"
				aria-label="Dismiss update notification"
				onClick={() => setDismissedVersion(ready.version)}
				variant="ghost"
				size="icon-sm"
				className="text-muted-foreground hover:text-foreground"
			>
				<XIcon className="size-4" aria-hidden="true" />
			</Button>
		</div>
	);
}
