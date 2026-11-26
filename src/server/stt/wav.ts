/**
 * Raw dictation PCM → a WAV file (Android plan M4). whisper.cpp's server
 * takes an audio FILE; the browser records 16 kHz mono Int16 little-endian
 * PCM with no header. Pure: the 44-byte canonical PCM header + the samples.
 */

export const PCM_SAMPLE_RATE = 16_000;

/** `sampleRate`: the PCM's rate in Hz (dictation records 16 kHz; Gemini TTS answers 24 kHz, src/server/tts/). */
export function wavFromPcm(pcm: Uint8Array, sampleRate = PCM_SAMPLE_RATE): Uint8Array<ArrayBuffer> {
	// an odd trailing byte is half a sample: dropped, never read past
	const dataBytes = pcm.byteLength - (pcm.byteLength % 2);
	const out = new Uint8Array(44 + dataBytes);
	const view = new DataView(out.buffer);
	const ascii = (at: number, s: string) => {
		for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	ascii(36, "data");
	view.setUint32(40, dataBytes, true);
	out.set(pcm.subarray(0, dataBytes), 44);
	return out;
}
