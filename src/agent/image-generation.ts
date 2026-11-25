import type { Models, Usage } from "@earendil-works/pi-ai";
import { piModels } from "./models.ts";
import { learnerImageFromBytes, type LearnerImage } from "./tools/learner-image.ts";
import type { GeneratedVisualProvenance } from "../core/contracts.ts";
import { workerRequest } from "./worker-request-admission.ts";

export interface ImageModelSelection {
	provider: string;
	id: string;
}

export interface GeneratedVisualImage {
	image: LearnerImage;
	generated: GeneratedVisualProvenance;
	usage?: Usage;
}

export async function generateVisualImage(
	prompt: string,
	selection: ImageModelSelection | undefined,
	options: { signal?: AbortSignal; models?: Pick<Models, "getModelOfType" | "generateImages"> } = {},
): Promise<GeneratedVisualImage> {
	if (!selection) throw new Error("Image generation is not configured — choose an image model in Settings → Agent → Models.");
	options.signal?.throwIfAborted();
	const models = options.models ?? piModels();
	const model = models.getModelOfType("image", selection.provider, selection.id);
	if (!model) throw new Error(`No image model "${selection.id}" in the ${selection.provider} catalog — update the image-generation model in Settings.`);
	const result = await workerRequest(
		(signal) => models.generateImages(model, { input: [{ type: "text", text: prompt }] }, { signal }),
		options.signal,
	);
	if (result.stopReason === "aborted") throw options.signal?.reason ?? new Error("Image generation was aborted.");
	if (result.stopReason === "error") throw new Error(result.errorMessage || `Image generation with ${selection.provider}:${selection.id} failed.`);
	const block = result.output.find((part) => part.type === "image");
	if (!block) throw new Error("The image model returned no image.");
	const image = await learnerImageFromBytes(Buffer.from(block.data, "base64"), "Generated illustration", options.signal);
	return {
		image,
		generated: { provider: selection.provider, model: selection.id, prompt },
		...(result.usage ? { usage: result.usage } : {}),
	};
}
