import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	HTTP_CONVERTER_PROFILE_FORMAT,
	customProfileIdOf,
	jsonPointerGet,
	jsonPointerSet,
	parseHttpConverterProfile,
	profileUrl,
	validateHttpConverterProfile,
	type HttpConverterProfile,
} from "../src/core/http-converter-spec.ts";
import { MISTRAL_OCR_PRESET, PRESET_PROFILES } from "../src/server/converters/presets.ts";

/** A good page-array profile with polling and a separate result request; each test breaks one thing. */
export function goodProfile(over: Partial<HttpConverterProfile> = {}): HttpConverterProfile {
	return {
		format: HTTP_CONVERTER_PROFILE_FORMAT,
		id: "acme-ocr",
		name: "Acme OCR",
		version: "1.0",
		auth: { header: "X-Api-Key", value: "{{API_KEY}}" },
		submit: { method: "POST", path: "/v2/jobs", body: { type: "multipart", fileField: "file", fields: { output: "markdown" } } },
		poll: { jobIdPointer: "/job/id", path: "/v2/jobs/{{JOB_ID}}", statusPointer: "/state", done: ["done"], running: ["queued", "running"], failed: ["error"], errorPointer: "/message" },
		result: { path: "/v2/jobs/{{JOB_ID}}/result" },
		extract: { type: "pages", pagesPointer: "/pages", numberPointer: "/page", numberBase: 1, markdownPointer: "/md" },
		...over,
	};
}

function errorsOf(value: unknown): string {
	const result = validateHttpConverterProfile(value);
	assert.equal(result.ok, false, "expected the profile to be refused");
	return result.ok ? "" : result.errors.join("\n");
}

describe("converter profile validation", () => {
	it("accepts every preset and good custom profiles (page array, delimiter with a random delimiter, keyless)", () => {
		for (const preset of PRESET_PROFILES) assert.equal(validateHttpConverterProfile(preset).ok, true, preset.id);
		assert.equal(validateHttpConverterProfile(goodProfile()).ok, true);
		const delimited = goodProfile({
			auth: undefined,
			poll: undefined,
			result: undefined,
			submit: { method: "PUT", path: "/convert?format=md", headers: { "X-Client": "learnharness" }, body: { type: "json-base64", filePointer: "/input/pdf", encoding: "base64", json: { options: { page_separator: "\n{{DELIMITER}}\n" } } } },
			extract: { type: "delimited", markdownPointer: "/output/markdown", delimiter: { random: true }, placement: "between" },
		});
		delete (delimited as Partial<HttpConverterProfile>).auth;
		delete (delimited as Partial<HttpConverterProfile>).poll;
		delete (delimited as Partial<HttpConverterProfile>).result;
		assert.deepEqual(validateHttpConverterProfile(delimited), { ok: true, profile: delimited });
	});

	it("parses text and reports invalid JSON and oversized profiles", () => {
		assert.equal(parseHttpConverterProfile(JSON.stringify(MISTRAL_OCR_PRESET)).ok, true);
		assert.match(errorsOfText("{not json"), /Not valid JSON/);
		assert.match(errorsOfText(" ".repeat(70 * 1024)), /at most 64 KB/);
	});

	it("rejects unknown fields, at any depth", () => {
		assert.match(errorsOf({ ...goodProfile(), script: "fetch('https://evil.example')" }), /additional|script/i);
		const nested = goodProfile();
		(nested.submit as unknown as Record<string, unknown>).onResponse = "x";
		assert.match(errorsOf(nested), /\/submit/);
	});

	it("rejects bad JSON Pointers", () => {
		assert.match(errorsOf(goodProfile({ extract: { type: "pages", pagesPointer: "pages", numberPointer: "/page", numberBase: 1, markdownPointer: "/md" } })), /pagesPointer: "pages" is not a JSON Pointer/);
		assert.match(errorsOf(goodProfile({ extract: { type: "pages", pagesPointer: "/pages", numberPointer: "/a~2b", numberBase: 1, markdownPointer: "/md" } })), /numberPointer/);
		const p = goodProfile();
		p.poll!.jobIdPointer = "$.job.id";
		assert.match(errorsOf(p), /jobIdPointer/);
	});

	it("rejects placeholders outside the fixed set, and known ones outside their places", () => {
		assert.match(errorsOf(goodProfile({ auth: { header: "X-Api-Key", value: "{{SECRET}}" } })), /\{\{SECRET\}\} is not a known placeholder/);
		const keyInPath = goodProfile();
		keyInPath.submit.path = "/v2/jobs?key={{API_KEY}}";
		assert.match(errorsOf(keyInPath), /API_KEY/);
		const keyInField = goodProfile();
		keyInField.submit.body = { type: "multipart", fileField: "file", fields: { token: "{{API_KEY}}" } };
		assert.match(errorsOf(keyInField), /\/submit\/body\/fields\/token: \{\{API_KEY\}\} is not allowed here/);
		const keyInHeader = goodProfile({ submit: { ...goodProfile().submit, headers: { "X-Other": "{{API_KEY}}" } } });
		assert.match(errorsOf(keyInHeader), /\{\{API_KEY\}\} is not allowed here/);
		const delimiterWithoutRandom = goodProfile();
		delimiterWithoutRandom.submit.body = { type: "multipart", fileField: "file", fields: { sep: "{{DELIMITER}}" } };
		assert.match(errorsOf(delimiterWithoutRandom), /DELIMITER\}\} is not allowed here/);
		assert.match(errorsOf(goodProfile({ description: "uses {{ braces" })), /unmatched/);
		assert.match(errorsOf(goodProfile({ auth: { header: "Authorization", value: "Bearer token" } })), /must contain \{\{API_KEY\}\}/);
		const noJob = goodProfile();
		noJob.poll!.path = "/v2/jobs/latest";
		assert.match(errorsOf(noJob), /poll\/path: must contain \{\{JOB_ID\}\}/);
	});

	it("rejects URLs that escape the base origin or path", () => {
		for (const path of ["https://evil.example/upload", "//evil.example/upload", "/v2/../../admin", "/v2/%2e%2e/admin", "/a\\b", "v2/jobs", "/v2//jobs", "/v2/%2fjobs", "/v2/jobs#frag"]) {
			const p = goodProfile();
			p.submit.path = path;
			assert.ok(!validateHttpConverterProfile(p).ok, `accepted ${path}`);
		}
		assert.match(errorsOf(goodProfile({ defaultBaseUrl: "https://user:pw@api.example" })), /defaultBaseUrl/);
	});

	it("rejects reserved and credential headers, overlapping statuses, a result without a poll, and a random delimiter that is never sent", () => {
		assert.match(errorsOf(goodProfile({ submit: { ...goodProfile().submit, headers: { Host: "evil.example" } } })), /set by the app/);
		assert.match(errorsOf(goodProfile({ submit: { ...goodProfile().submit, headers: { "x-api-key": "fixed" } } })), /credential header/);
		const overlap = goodProfile();
		overlap.poll!.failed = ["done"];
		assert.match(errorsOf(overlap), /listed twice/);
		const resultOnly = goodProfile();
		delete resultOnly.poll;
		assert.match(errorsOf(resultOnly), /needs a poll section/);
		assert.match(errorsOf(goodProfile({ extract: { type: "delimited", markdownPointer: "/md", delimiter: { random: true } } })), /must be sent to the service as \{\{DELIMITER\}\}/);
		const clash = goodProfile();
		clash.submit.body = { type: "json-base64", filePointer: "/document", encoding: "base64", json: { document: "fixed" } };
		assert.match(errorsOf(clash), /names a fixed field/);
	});

	it("custom converter ids are custom:<id> with a valid profile id", () => {
		assert.equal(customProfileIdOf("custom:acme-ocr"), "acme-ocr");
		assert.equal(customProfileIdOf("custom:../x"), undefined);
		assert.equal(customProfileIdOf("mistral-ocr"), undefined);
	});
});

function errorsOfText(text: string): string {
	const result = parseHttpConverterProfile(text);
	assert.equal(result.ok, false);
	return result.ok ? "" : result.errors.join("\n");
}

describe("JSON Pointer and URLs", () => {
	it("reads RFC 6901 pointers, including escapes and array indices", () => {
		const doc = { a: [{ "b/c": 1, "m~n": 2 }], "": 3 };
		assert.equal(jsonPointerGet(doc, "/a/0/b~1c"), 1);
		assert.equal(jsonPointerGet(doc, "/a/0/m~0n"), 2);
		assert.equal(jsonPointerGet(doc, "/"), 3);
		assert.equal(jsonPointerGet(doc, "/a/01"), undefined);
		assert.equal(jsonPointerGet(doc, "/missing/x"), undefined);
		assert.deepEqual(jsonPointerGet(doc, ""), doc);
	});

	it("sets the PDF into a body without overwriting fixed fields or the prototype", () => {
		const body: Record<string, unknown> = { document: { type: "document_url" } };
		jsonPointerSet(body, "/document/document_url", "data:x");
		assert.deepEqual(body, { document: { type: "document_url", document_url: "data:x" } });
		assert.throws(() => jsonPointerSet(body, "/document/type", "x"), /fixed field/);
		assert.throws(() => jsonPointerSet({}, "/__proto__/polluted", "x"), /reserved/);
		assert.equal(({} as Record<string, unknown>).polluted, undefined);
	});

	it("builds URLs under the base URL and refuses job ids that would leave it", () => {
		assert.equal(profileUrl("https://api.example/base", "/v1/jobs/{{JOB_ID}}", "a b/c"), "https://api.example/base/v1/jobs/a%20b%2Fc");
		assert.throws(() => profileUrl("https://api.example/base", "/v1/jobs/{{JOB_ID}}", ".."), /job id/);
		assert.throws(() => profileUrl("https://api.example", "//evil.example/x"), /another host/);
	});
});
