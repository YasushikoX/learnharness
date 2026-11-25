import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { resolveSettings, slotsConfigured } from "@/src/core";
import { compactionInFlight, getChat, isTurnRunning, readSettingsRecord, sessionCoverage, turnFailure } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function ChatPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ prompt?: string }>;
}) {
	const [{ id }, { prompt }] = await Promise.all([params, searchParams]);
	const chat = getChat(id);
	if (!chat) notFound();
	// The persistent setup CTA's seed (BYOK, owner 2026-09-22): slotsConfigured
	// over the settings record, server-read — the same gate home/new read. The
	// server's 503 stays the truth; this only decides whether the pill rides.
	const record = readSettingsRecord();
	const kind = chat.kind ?? "teach";
	// an Ask conversation (2026-11-25) never extracts, so it has no coverage to seed
	const needsCoverage = kind !== "practice" && chat.course?.mode !== "placement" && chat.course?.mode !== "ask";
	const graph = resolveSettings(record).graph;
	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			kind={kind}
			courseMode={chat.course?.mode}
			// Wave D: the record IS native agent history — the client view is
			// derived app-side (core/view.ts projectView; GET serves the same
			// native messages).
			initialMessages={chat.messages}
			initialSession={{ settings: chat.settings, kind, course: chat.course }}
			initialModels={record?.models}
			initialGraph={{ enabled: graph.enabled, chunkTokens: graph.extractionChunkTokens }}
			initialCoverage={needsCoverage ? sessionCoverage(chat.id) : null}
			initialError={turnFailure(chat.id)}
			initialConfigured={slotsConfigured(record?.models)}
			initialPrompt={prompt}
			// A teacher turn that outlived its client: the remounted view must
			// attach (busy shimmer + poll), never resurrect the stale record.
			initiallyInFlight={isTurnRunning(chat.id)}
			initiallyCompacting={compactionInFlight(chat.id)}
		/>
	);
}
