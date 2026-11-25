# PDF converters

Every uploaded PDF is converted once, when it is added, into page-marked Markdown (`content.md`, one `--- Page N ---` marker per page) that the tutor reads and cites. **Settings → PDF conversion** chooses who does the converting.

| Converter | Where the PDF goes | Notes |
| --- | --- | --- |
| **Built-in reader** (`pdfjs`, the default) | Nowhere: it runs on this computer | Reads the PDF's text layer. No OCR: scanned pages come out empty. |
| **Docling** (`docling`) | Your own Docling Serve | OCR and formula recognition (options in Settings). Its key is optional. |
| **Mistral OCR** (`mistral-ocr`, a preset) | `https://api.mistral.ai` (or the URL you set) | Hosted OCR, billed by Mistral. **Unverified**: written from Mistral's API reference without a real call; run **Test** first. |
| **Your own profile** (`custom:<id>`) | The URL you save for it | Any service a profile can describe (below). |

### Choosing a converter

Choosing an entry in the **Converter** list only shows its settings; nothing changes yet. Next to the line that says where PDFs will be sent is **Use for new PDFs**: that makes it the converter new uploads use. The one in use is marked "in use" in the list and "In use for new PDFs" next to that line.

**Use for new PDFs** is only available once the converter is set up: a service URL is saved for it and, if it takes a key, a key is saved for that URL. Until then the screen says what is missing ("Save its API key first.") and **nothing is sent** to the service. For a bundled preset such as Mistral OCR, its own address (shown on the screen) is saved as its URL when you save its key or choose **Use for new PDFs**. Your own profile has no address until you type one and press **Save**. A converter that was chosen some other way but is not set up sends nothing: PDFs are read by the built-in reader, with a warning on the material. A service URL that is this app's own address is refused.

**API keys** must be at least 8 characters long, and may contain only characters an HTTP header can carry (no line breaks, tabs or other control characters, nothing outside Latin-1). A shorter or malformed key is refused when you save it. Changing a service's URL removes the key saved for the old one; enter it again for the new address. The URL can only be changed on this screen (the generic settings API refuses to change it), so a key is never silently reused at another address.

If a service cannot be reached or times out, that PDF is read by the built-in reader instead, with a warning on the material. Any other failure (a refused key, a stored key that cannot be sent, a rate limit, an answer the app cannot use) is shown on the material; nothing is uploaded again unless you retry.

### Test

**Test** sends two small PDFs to the converter and checks the answers. It never falls back to the built-in reader.

1. Two pages, one known sentence on each: both pages must come back, each with its own sentence, as valid page-marked text.
2. Three pages with a **blank middle page**: three pages must come back, page 2 empty, and page 3's sentence on page 3. A converter that cannot place a blank page (for example a service that only writes page breaks between pages that have text) fails here with a reason that says so: with such a service, the text after any blank page in your PDFs could be cited on the wrong page.
3. The API key must not appear in any answer or error, in any form the app knows (as is, URL-encoded, base64).

The whole Test gives up after two minutes, and **Cancel** stops it. Its report is shown only for the converter it was started for: showing another converter cancels it.

## Your own service: a profile

A profile is a JSON file that describes a PDF or OCR service: how to send the PDF and where the text is in the answer. It is **data, not code**: the app reads it and makes the requests itself. Import it in Settings → PDF conversion (paste it or choose the file); it is stored as `<data folder>/converters/<id>.json` and validated every time it is used. An invalid file is listed with its reasons and never used. Importing a profile only adds it to the list: you then enter its service URL (and key) and choose **Use for new PDFs**.

A profile **does not contain the service's address**: you type that in Settings after importing. Only the presets that ship with the app carry their own address (`defaultBaseUrl`); a profile you import that contains `defaultBaseUrl` is refused, and such a file in the profiles folder is listed as invalid. This is so a profile, which may have been written by someone else (or, later, drafted by an AI from a web page), can never choose where your PDFs and key go.

An annotated example (comments are not allowed in the real file):

```jsonc
{
  "format": "learnharness.http-converter/1",   // always this
  "id": "acme-ocr",                            // lowercase letters, digits, hyphens; the file name is <id>.json
  "name": "Acme OCR",                          // shown in Settings and in messages
  "version": "1",                              // bump it when you change the profile (a change re-converts PDFs)
                                               // no address here: you enter https://ocr.acme.example in Settings
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

Rules the validator enforces: unknown fields are refused; no `defaultBaseUrl` (see above); at most 64 KB (measured on the compact JSON), nested at most 32 levels deep and at most 2,000 values in all; data is located only by [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901) (`/a/0/b`, `~1` for `/`, `~0` for `~`); the only placeholders are `{{API_KEY}}` (only in `auth.value`), `{{JOB_ID}}` (only in `poll.path` and `result.path`) and `{{DELIMITER}}` (only in submit body fields, and only with a random delimiter); paths start with `/`, contain no `//`, `\`, `.`/`..` segments or fragment, and stay under the base URL; the app sets `Host`, `Content-Type` and similar headers itself, and header names such as `__proto__`, `constructor` and `prototype` are refused; `Authorization`, `Cookie` and `Proxy-Authorization` can never be fixed headers in `submit.headers` (which also go with poll and result requests): a key goes only through `auth`, and the key header cannot be repeated in `submit.headers`; header values may not contain control characters or characters outside Latin-1. The full schema is `src/core/http-converter-spec.ts`.

### Page numbers are checked, never guessed

Wrong page numbers would silently corrupt every citation, so: a page array must have exactly one entry per PDF page, its numbers come from the field you declare, and the app refuses an answer with a missing, repeated or out-of-range page. A delimited answer must match the declared `placement` exactly, or the conversion fails with "did not mark every page":

- `between` (the default): exactly one segment per PDF page;
- `after`: a delimiter after every page, the last one included, so one more segment, and the last one must be empty;
- `before`: a delimiter before every page, so one more segment, and the first one must be empty.

Prefer `{ "random": true }`: a fixed delimiter that also appears in a page's text breaks the count, and a service that ignores the per-job delimiter is caught. Run **Test**: its blank-page check shows whether the service marks pages that have no text.

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
- **Where the key lives:** only in the credential store `auth.json` (mode 0600), bound to the base URL it was entered for. It is never in `settings.json`, never in `process.env` (so never in a child process), never in the key list, and never sent to a model. If you change a service's URL, the stored key is removed and must be entered again. The settings screen and its API never return a stored key: only whether one is stored and, for a key of 20 or more characters, its last four. Keys shorter than 8 characters are refused, so the app can always remove a key from text without mangling ordinary words.
- **What is sent where:** nothing is sent until you have saved the service's URL (a preset's own address once you choose it) and, if it takes one, its key. The PDF and the key then go only to that URL's origin, never to this app itself. Every URL is checked before its request; redirects are refused, not followed. The key goes only in the profile's one auth header. The app removes the key (as is, URL-encoded and base64-encoded) from everything that comes back from any converter, Docling included: error messages (before they are shortened), the converter version, warnings, page text and page reasons; Test fails if the service echoed it, and its report never contains it.
- **Limits:** answers are capped in size, the upload has its own timeout, every request has one, polling is bounded by a count and by the 15-minute job deadline, and an upload is never retried automatically. A page list longer than the PDF is refused before it is read, and a delimited answer is split with a limit. Profiles are checked for size and depth before anything reads them, and an import larger than 256 KB is refused before it is read. The Test has its own two-minute deadline.
