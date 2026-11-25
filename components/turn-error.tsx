"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { FallbackTarget } from "@/src/core";
import { turnErrorDisplay } from "@/src/core";
import { updateChatSettings } from "@/components/chat-settings-client";

/**
 * The chat banner's text for a failed turn (owner, 2026-11-13). A provider failure used to show as its raw JSON; a
 * recognised cause (out of credit, quota, a rejected key, the provider down, a timeout) reads as a phrase, with the
 * provider's own words one click away. Anything else is shown as before.
 */
export function TurnErrorText({ message }: { message: string }) {
	const { phrase, detail } = turnErrorDisplay(message);
	if (!phrase) return <span>Something went wrong: {message}</span>;
	return (
		<span data-testid="turn-error-text">
			Something went wrong: the model provider reports {phrase}.
			<details className="mt-1 text-xs text-muted-foreground">
				<summary className="cursor-pointer">Details</summary>
				<span className="break-words">{detail}</span>
			</details>
		</span>
	);
}

/** "Retry on <model>": moves this session to the fallback model (the rest of its settings kept), then retries. Never
 *  automatic (src/core/turn-fallback.ts). */
export function RetryOnFallback({ chatId, target, onSwitched }: { chatId: string; target: FallbackTarget; onSwitched: (model: string) => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const press = async () => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await updateChatSettings(chatId, (current) => ({
				...current,
				model: { provider: target.provider, id: target.id },
			}));
			if (!res.ok) {
				setError(res.networkError ? "Could not reach the server — try again." : (res.error ?? `rejected (${res.status})`));
				return;
			}
			onSwitched(`${target.provider}:${target.id}`);
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<Button variant="outline" size="xs" data-testid="retry-on-fallback" disabled={busy} onClick={() => void press()}>
				Retry on {target.id}
			</Button>
			{error && <span role="alert" className="text-xs text-destructive">{error}</span>}
		</>
	);
}
