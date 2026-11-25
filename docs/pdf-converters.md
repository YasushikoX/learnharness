# PDF converters

Every uploaded PDF is converted once, when it is added, into page-marked Markdown (`content.md`, one `--- Page N ---` marker per page) that the tutor reads and cites. **Settings → PDF conversion** chooses who does the converting.

| Converter | Where the PDF goes | Notes |
| --- | --- | --- |
| **Built-in reader** (`pdfjs`, the default) | Nowhere: it runs on this computer | Reads the PDF's text layer. No OCR: scanned pages come out empty. |
| **Docling** (`docling`) | Your own Docling Serve | OCR and formula recognition (options in Settings). Its key is optional. |
| **Mistral OCR** (`mistral-ocr`, a preset) | `https://api.mistral.ai` (or the URL you set) | Hosted OCR, billed by Mistral. **Unverified**: written from Mistral's API reference without a real call; run **Test** first. |
| **Your own profile** (`custom:<id>`) | The URL you set for it | Any service a profile can describe (below). |

If a service cannot be reached or times out, that PDF is read by the built-in reader instead, with a warning on the material. Any other failure (a refused key, a rate limit, an answer the app cannot use) is shown on the material; nothing is uploaded again unless you retry.

**Test** sends a small two-page PDF (one known sentence per page) to the converter and checks that both pages come back, each with its own sentence, as valid page-marked text, and that the API key is not echoed. It never falls back to the built-in reader.

## Your own service: a profile

A profile is a JSON file that describes a PDF or OCR service: where to send the PDF, how, and where the text is in the answer. It is **data, not code**: the app reads it and makes the requests itself. Import it in Settings → PDF conversion (paste it or choose the file); it is stored as `<data folder>/converters/<id>.json` and validated every time it is used. An invalid file is listed with its reasons and never used.

An annotated example (comments are not allowed in the real file):

```jsonc
{
  "format": "learnharness.http-converter/1",   // always this
  "id": "acme-ocr",                            // lowercase letters, digits, hyphens; the file name is <id>.json
  "name": "Acme OCR",                          // shown in Settings and in messages
  "version": "1",                              // bump it when you change the profile (a change re-converts PDFs)
  "defaultBaseUrl": "https://ocr.acme.example",// optional; Settings can set another URL
  "auth": { "header": "X-Api-Key", "value": "{{API_KEY}}" },   // the ONE header that carries the key; omit for no key
  "limits": { "maxBytes": 52428800, "maxPages": 500 },         // optional: the service's own limits
  "submit": {                                  // the one upload, never sent twice
    "method": "POST",
    "path": "/v2/jobs",                        // relative to the base URL; must stay under it
    "headers": { "X-Client": "learnharness" }, // optional fixed headers, sent with every request of the job
    "body": { "type": "multipart", "fileField": "file", "fields": { "output": "markdown" } }
    // or: { "type": "json-base64", "filePointer": "/document/data", "encoding": "base64" | "data-url",
    //       "json": { …fixed fields… } }
  },
  "poll": {                                    // optional, for services that answer with a job id
    "jobIdPointer": "/job/id",                 // JSON Pointer into the submit answer
    "path": "/v2/jobs/{{JOB_ID}}",
    "statusPointer": "/state",
    "done": ["done"], "running": ["queued", "running"], "failed": ["error"],
    "errorPointer": "/message",                // the service's failure reason
    "intervalMs": 2000                         // 500–60000; "maxPolls" caps the count (default: until the 15-minute job deadline)
  },
  "result": { "path": "/v2/jobs/{{JOB_ID}}/result" },   // optional separate request for the finished answer
  "extract": {                                 // where the text is in the final answer
    "type": "pages", "pagesPointer": "/pages",
    "numberPointer": "/page", "numberBase": 1, // 0 if the service counts pages from 0
    "markdownPointer": "/markdown"
  }
  // or one Markdown string split at a page delimiter:
  // "extract": { "type": "delimited", "markdownPointer": "/markdown",
  //              "delimiter": { "random": true },          // the app makes one per job and sends it as {{DELIMITER}}
  //              "placement": "between" }                  // or "after" / "before" every page
  // with { "literal": "\f" } instead when the service always writes the same separator.
}
```

Rules the validator enforces: unknown fields are refused; data is located only by [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901) (`/a/0/b`, `~1` for `/`, `~0` for `~`); the only placeholders are `{{API_KEY}}` (only in `auth.value`), `{{JOB_ID}}` (only in `poll.path` and `result.path`) and `{{DELIMITER}}` (only in submit body fields, and only with a random delimiter); paths start with `/`, contain no `//`, `\`, `.`/`..` segments or fragment, and stay under the base URL; the app sets `Host`, `Content-Type`, `Cookie` and similar headers itself; the key header cannot be repeated in `submit.headers`. The full schema is `src/core/http-converter-spec.ts`.

### Page numbers are checked, never guessed

Wrong page numbers would silently corrupt every citation, so: page-array numbers come from the field you declare, and the app refuses an answer with a missing, repeated or out-of-range page. A delimited answer must have exactly one segment per PDF page, or the conversion fails with "did not mark every page". Prefer `{ "random": true }`: a fixed delimiter that also appears in a page's text breaks the count.

### What a profile cannot express

- multi-step uploads (ask for a presigned URL, upload there, then start the job), or uploads to another host;
- answers that are ZIP archives, or anything other than JSON;
- services with no reliable page separation (one text for the whole document, or page breaks only between pages that have content);
- page markers that contain the page number (`--- 3 ---`), page ranges, or several requests per page;
- poll URLs handed back by the service instead of a job id, a job id outside the JSON answer (a header), or a different host for results;
- authentication other than one header (OAuth, signed requests, a key in the URL);
- any computation: there is no expression language, templating beyond the three placeholders, or scripting.

A later "Draft with AI" helper will write profiles from a service's documentation and say when a service does not fit.

## Security model

- **Never put a key in a profile file:** a profile names where the key goes (`{{API_KEY}}` in `auth.value`); the key itself is entered in Settings and stored apart from the profile.
- **What runs:** only the app's own code. Profiles are validated data; nothing in a profile, a downloaded file or a generated draft is executed.
- **Where the key lives:** only in the credential store `auth.json` (mode 0600), bound to the base URL it was entered for. It is never in `settings.json`, never in `process.env` (so never in a child process), never in the key list, and never sent to a model. If you change a service's URL, the stored key is removed and must be entered again. The settings screen and its API never return a stored key: only whether one is stored and, for a key of 20 or more characters, its last four.
- **What is sent where:** the PDF and the key go only to the configured base URL's origin. Every URL is checked before its request; redirects are refused, not followed. The key goes only in the profile's one auth header. The app removes the key from any text, warning or error that comes back, and Test fails if the service echoed it.
- **Limits:** answers are capped in size, the upload has its own timeout, every request has one, polling is bounded by a count and by the 15-minute job deadline, and an upload is never retried automatically.
