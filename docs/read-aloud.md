# Read aloud

A question can be read aloud with the **Read aloud** button beside it (or its keyboard shortcut), or automatically when it appears (Settings → General → Read aloud → *Read questions aloud automatically*). Only what is on screen is read: the question, its details and the options shown, with formulas spoken or called "formula" (`src/core/speech-text.ts`).

There are two kinds of voices (fork addition WP10, 2026-11-26):

- **Google (natural, online):** Google's Gemini text-to-speech voices, through a free Google AI Studio key. This is the default once a key is available.
- **System voices:** the voices installed on your computer, offline. They are also the fallback whenever Google cannot read: no key, no network, an error, or the free limit reached.

## Setting up Google voices

Settings → General → Read aloud:

1. **Voices:** Google (natural, online).
2. **Google AI Studio key.** The key is the same one Settings → PDF conversion → Google AI Studio (Gemini) uses, stored in the same place on this computer (`auth.json`, never synced). If you saved one there, or set up a Google key under model providers (`GEMINI_API_KEY`), it is used here and the row says where it comes from. Otherwise paste one (create it at <https://aistudio.google.com/apikey>); saving it also sets it up for PDF conversion. The key never reaches the app's window: only the app's server sends it, in the `x-goog-api-key` header.
3. **Test.** One real call with an English sentence. The row shows *Not set*, *Testing…*, *Working*, *Not tried yet* or *Failed* (with the reason and Try again). Until a call has worked on this computer, the section says the voices are **unverified**: they were written from Google's documentation without a real call.
4. **Quality:** *Natural* (`gemini-3.8-flash-tts`, the default) or *Faster* (`gemini-3.8-flash-lite-tts`).
5. **A voice per lesson language** (English, Norwegian), each with a ▶ button that plays one sentence. The defaults are Erinome (English) and Iapetus (Norwegian), both "Clear" in Google's list; any of Google's 30 voices can read either language, since the model detects the language itself.

The **Speech rate** applies to every voice (Google's audio is played faster or slower). The **System voice** is used for system voices and for the fallback.

## Your text and Google's free tier

With Google voices on, the text read aloud (the question and its options) is sent to Google. On the free tier, Google may use what is sent to improve its products, and people may review it (Gemini API terms, "Unpaid Services"; the pricing page says free-tier content is "used to improve our products"). On a billed project it is not used that way. Choose System voices to keep everything on this computer.

The free tier has **rate limits** per Google Cloud project: requests per minute and per day (the numbers are shown in AI Studio; the daily quota resets at midnight Pacific time). When Google answers that a limit is reached, the rest of that read uses system voices, the question shows a quiet notice once ("Google's free limit was reached; using system voices until it resets"), and the app does not call Google again until the limit has passed (the reset time for a daily quota, the wait Google gives for a per-minute one, else a minute). Audio already made still plays from the cache.

## How it works

- **Server only.** `POST /api/tts/speak { text, language, voice?, model? }` answers a WAV file. It calls the Gemini **Interactions API** (`POST /v1beta/interactions`) with the model, the text, one prebuilt voice and a short delivery style (`speech_metadata.style`: calm, clear and unhurried), with `store: false`. Google answers base64 audio: a WAV (24 kHz, mono, 16-bit) by default, or raw 24 kHz PCM, which the app wraps as WAV (`src/server/tts/gemini-tts.ts`). Errors map to: `no_key`, `quota` (daily), `rate_limit` (per minute), `auth`, `offline`, `timeout`, `bad_request`, `bad_response`, `unavailable`.
- **Cache.** Each WAV is kept in `<data>/tts-cache/` under a hash of model, voice, style and text, so reading a question again, or a preview, makes no call. The cache is capped at 200 MB; the files used longest ago are removed first. It is never synced.
- **Speed.** The lines of a question are packed into chunks of whole sentences: a short first chunk (about 200 characters), so playback starts after one quick call, then larger chunks (about 700 characters), fetched one at a time behind the one playing. Once you have used read aloud in a session, the first chunk of each new question is made as the question appears, so pressing the button plays at once. With automatic reading the question is read as it appears anyway.
- **Fallback.** Any failure of a chunk (no key, offline, an error, a refused key, a limit, a chunk that takes longer than 30 seconds) hands the rest of the read, from that chunk, to system voices. A chunk that plays longer than its length allows is stopped, so the button never stays on Stop. One controller holds both engines (`components/read-aloud-controller.ts`) behind the same interface as the system-voice controller (`components/speech-controller.ts`).

## Trying it without the app

`node scripts/tts-sample.mjs <folder>` with `GEMINI_API_KEY` set writes `sample-en.wav` and `sample-nb.wav` there, using the app's own client, the default model and the default voices. `TTS_MODEL`, `TTS_VOICE_EN` and `TTS_VOICE_NB` choose others.

## Not done yet

- A Read aloud control for the tutor's own explanations (the last reply); only questions are read.
- Google's extended voice library and custom voices; only the 30 prebuilt voices are offered.
- The Google voices have not been tried with a real key; they are marked unverified in Settings until Test succeeds.
