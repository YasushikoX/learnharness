// An indexing package on another branch exports these same helpers from
// src/core/material-split.ts; unify the two modules when both branches land.
export const PAGE_MARKER_PATTERN = /^--- Page ([1-9]\d*) ---$/;

export function formatPageMarker(page: number): string {
	return `--- Page ${page} ---`;
}

export function escapePageMarkerLines(markdown: string): string {
	return markdown
		.split("\n")
		.map((line) => (PAGE_MARKER_PATTERN.test(line.replace(/^\\+/, "")) ? `\\${line}` : line))
		.join("\n");
}

export function unescapePageMarkerLines(markdown: string): string {
	return markdown
		.split("\n")
		.map((line) => (line.startsWith("\\") && PAGE_MARKER_PATTERN.test(line.replace(/^\\+/, "")) ? line.slice(1) : line))
		.join("\n");
}

export interface MarkedPage {
	page: number;
	markdown: string;
}

export function parsePageMarkedMarkdown(content: string): MarkedPage[] {
	const pages: MarkedPage[] = [];
	let current: MarkedPage | undefined;
	for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
		const marker = PAGE_MARKER_PATTERN.exec(line);
		if (marker) {
			current = { page: Number(marker[1]), markdown: "" };
			pages.push(current);
		} else if (current) {
			current.markdown += `${current.markdown ? "\n" : ""}${line}`;
		}
	}
	return pages.map((page) => ({ ...page, markdown: unescapePageMarkerLines(page.markdown) }));
}
