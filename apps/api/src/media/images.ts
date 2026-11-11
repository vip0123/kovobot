import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { Config } from "@kovobot/config";

// Pictures a Bot makes with a Model provider's image model, independent of its chat model
// (ADR 0011). One HTTP attempt per picture, as for every model call (ADR 0004).

/** A picture's shape. */
export type ImageShape = "square" | "portrait" | "landscape";
export const IMAGE_SHAPES: readonly ImageShape[] = ["square", "portrait", "landscape"];

/** A picture an image model made. */
export interface MadeImage {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Buffer;
}

/** One Model provider's image model. */
export interface ImageMaker {
  /** Makes one picture from a description; throws ImageError when it can't. */
  make(request: { prompt: string; shape: ImageShape }): Promise<MadeImage>;
}

/** Why no picture came: refused, failed, or not a picture. Its message is ours, safe to show the model. */
export class ImageError extends Error {
  override name = "ImageError";
}

/** How long one picture may take: image models can take a minute or more. */
const IMAGE_TIMEOUT_MS = 180_000;

/** The image model a Bot uses: OpenAI's when its key is set, else Google's; null when neither is. */
export function createImageMaker({ modelKeys }: Pick<Config, "modelKeys">): ImageMaker | null {
  if (modelKeys.openai) return createOpenAIImageMaker({ apiKey: modelKeys.openai });
  if (modelKeys.google) return createGoogleImageMaker({ apiKey: modelKeys.google });
  return null;
}

const OPENAI_SIZES: Record<ImageShape, "1024x1024" | "1024x1536" | "1536x1024"> = {
  square: "1024x1024",
  portrait: "1024x1536",
  landscape: "1536x1024",
};

/** OpenAI's Image API. Flare is its model for fast everyday pictures. */
export function createOpenAIImageMaker({ apiKey, baseURL, model = "gpt-image-2.6-flare" }: { apiKey: string; baseURL?: string; model?: string }): ImageMaker {
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: IMAGE_TIMEOUT_MS });
  return {
    async make({ prompt, shape }) {
      let result: OpenAI.Images.ImagesResponse;
      try {
        result = await client.images.generate({ model, prompt, size: OPENAI_SIZES[shape], n: 1, output_format: "png" });
      } catch (error) {
        const refused = (error as { code?: unknown }).code === "moderation_blocked";
        throw new ImageError(refused ? REFUSED : FAILED, { cause: error });
      }
      return picture(result.data?.[0]?.b64_json);
    },
  };
}

const GOOGLE_ASPECTS: Record<ImageShape, string> = { square: "1:1", portrait: "2:3", landscape: "3:2" };

/** Google's image model, through its Interactions API. */
export function createGoogleImageMaker({ apiKey, baseURL, model = "gemini-nano-banana-2.1" }: { apiKey: string; baseURL?: string; model?: string }): ImageMaker {
  const client = new GoogleGenAI({ apiKey, httpOptions: { baseUrl: baseURL, retryOptions: { attempts: 1 } } });
  return {
    async make({ prompt, shape }) {
      let interaction: Awaited<ReturnType<typeof client.interactions.create>>;
      try {
        interaction = await client.interactions.create(
          {
            model,
            input: prompt,
            // JPEG is the one format it makes, whatever its docs' examples show (checked 2026-11-11).
            response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: GOOGLE_ASPECTS[shape], image_size: "1K" },
            // Not kept at Google, and one HTTP attempt: no automatic continuation or retries.
            store: false,
            automatic_continuation: false,
          },
          { retries: { strategy: "none" }, timeout_ms: IMAGE_TIMEOUT_MS },
        );
      } catch (error) {
        throw new ImageError(FAILED, { cause: error });
      }
      if (!("output_image" in interaction) && !("output_text" in interaction)) throw new ImageError(FAILED);
      const made = interaction as { output_image?: { data?: string }; output_text?: string };
      // A model that won't draw something says so in words instead.
      if (!made.output_image?.data && made.output_text) throw new ImageError(REFUSED);
      return picture(made.output_image?.data);
    },
  };
}

const FAILED = "The image model couldn't make that picture. Try again, or describe it differently.";
const REFUSED = "The image model wouldn't make that picture under its Model provider's usage policy.";

/** A picture from base64, checked by its own bytes. */
function picture(data: string | undefined): MadeImage {
  if (!data) throw new ImageError(FAILED);
  const bytes = Buffer.from(data, "base64");
  const mediaType = imageType(bytes);
  if (!mediaType) throw new ImageError(FAILED);
  return { mediaType, bytes };
}

function imageType(bytes: Buffer): MadeImage["mediaType"] | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
