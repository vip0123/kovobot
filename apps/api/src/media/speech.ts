import { GoogleGenAI } from "@google/genai";
import OpenAI, { toFile } from "openai";
import type { Config } from "@kovobot/config";

// Voice notes: what the Customer says, heard as text by a speech-to-text model, and a Bot's reply
// read aloud by a text-to-speech model (ADR 0011). One HTTP attempt each (ADR 0004).

/** The recordings a voice note may be, as browsers record them. */
export type AudioType = "audio/webm" | "audio/ogg" | "audio/mp4" | "audio/mpeg" | "audio/wav";

/** A Model provider's speech-to-text model. */
export interface Transcriber {
  /** Which recordings it can hear. */
  readonly hears: ReadonlySet<AudioType>;
  /** What the recording says, as text; empty when it heard no words. Throws SpeechError when it fails. */
  transcribe(audio: { bytes: Buffer; mediaType: AudioType }): Promise<string>;
}

/** A Model provider's text-to-speech model. */
export interface Speaker {
  /** The text, read aloud. Throws SpeechError when it fails. */
  speak(text: string): Promise<{ mediaType: "audio/wav"; bytes: Buffer }>;
}

/** Why a recording wasn't heard, or a reply wasn't read aloud. Its message is ours, safe to show the Customer. */
export class SpeechError extends Error {
  override name = "SpeechError";
}

const SPEECH_TIMEOUT_MS = 120_000;
const EXTENSIONS: Record<AudioType, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav" };

/** The speech-to-text model voice notes are heard with: OpenAI's when its key is set, else Google's; null when neither is. */
export function createTranscriber({ modelKeys }: Pick<Config, "modelKeys">): Transcriber | null {
  if (modelKeys.openai) return createOpenAITranscriber({ apiKey: modelKeys.openai });
  if (modelKeys.google) return createGoogleTranscriber({ apiKey: modelKeys.google });
  return null;
}

/** The text-to-speech model replies are read aloud with: Google's, the one with a plain speech API that lasts; null without its key. */
export function createSpeaker({ modelKeys }: Pick<Config, "modelKeys">): Speaker | null {
  return modelKeys.google ? createGoogleSpeaker({ apiKey: modelKeys.google }) : null;
}

/** OpenAI's transcription model. It hears every format a browser records but Ogg. */
export function createOpenAITranscriber({ apiKey, baseURL, model = "gpt-transcribe" }: { apiKey: string; baseURL?: string; model?: string }): Transcriber {
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: SPEECH_TIMEOUT_MS });
  return {
    hears: new Set<AudioType>(["audio/webm", "audio/mp4", "audio/mpeg", "audio/wav"]),
    async transcribe({ bytes, mediaType }) {
      try {
        const file = await toFile(bytes, `voice-note.${EXTENSIONS[mediaType]}`, { type: mediaType });
        const heard = await client.audio.transcriptions.create({ file, model });
        return heard.text.trim();
      } catch (error) {
        throw new SpeechError(NOT_HEARD, { cause: error });
      }
    },
  };
}

/** Google's transcription model, through its Interactions API. */
export function createGoogleTranscriber({ apiKey, baseURL, model = "gemini-3.5-transcribe" }: { apiKey: string; baseURL?: string; model?: string }): Transcriber {
  const client = googleClient(apiKey, baseURL);
  return {
    hears: new Set<AudioType>(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav"]),
    async transcribe({ bytes, mediaType }) {
      let heard: { output_text?: string };
      try {
        heard = (await client.interactions.create(
          {
            model,
            input: [
              { type: "text", text: "Transcribe this recording word for word, in the language spoken. Reply with the transcript alone, or nothing if no one speaks." },
              // Google names MP4 audio by its file kind.
              { type: "audio", data: bytes.toString("base64"), mime_type: mediaType === "audio/mp4" ? "audio/m4a" : mediaType },
            ],
            store: false,
            automatic_continuation: false,
          },
          ONE_ATTEMPT,
        )) as { output_text?: string };
      } catch (error) {
        throw new SpeechError(NOT_HEARD, { cause: error });
      }
      return (heard.output_text ?? "").trim();
    },
  };
}

/** Google's text-to-speech model, which answers with a WAV file. */
export function createGoogleSpeaker({ apiKey, baseURL, model = "gemini-3.8-flash-tts", voice = "Kore" }: { apiKey: string; baseURL?: string; model?: string; voice?: string }): Speaker {
  const client = googleClient(apiKey, baseURL);
  return {
    async speak(text) {
      let spoken: { output_audio?: { data?: string } };
      try {
        spoken = (await client.interactions.create(
          { model, input: text, response_format: { type: "audio" }, generation_config: { speech_config: [{ voice }] }, store: false, automatic_continuation: false },
          ONE_ATTEMPT,
        )) as { output_audio?: { data?: string } };
      } catch (error) {
        throw new SpeechError(NOT_SPOKEN, { cause: error });
      }
      const bytes = Buffer.from(spoken.output_audio?.data ?? "", "base64");
      if (audioType(bytes) !== "audio/wav") throw new SpeechError(NOT_SPOKEN);
      return { mediaType: "audio/wav", bytes };
    },
  };
}

const NOT_HEARD = "Your voice note couldn't be heard just now. Try again, or type it.";
const NOT_SPOKEN = "That reply couldn't be read aloud just now. Try again in a moment.";
/** Google's Interactions API retries four times and continues long answers on its own unless told not to. */
const ONE_ATTEMPT = { retries: { strategy: "none" as const }, timeout_ms: SPEECH_TIMEOUT_MS };

function googleClient(apiKey: string, baseURL: string | undefined): GoogleGenAI {
  return new GoogleGenAI({ apiKey, httpOptions: { baseUrl: baseURL, retryOptions: { attempts: 1 } } });
}

/** What a recording is, from its first bytes: one a browser records, or null. */
export function audioType(bytes: Buffer): AudioType | null {
  const ascii = (from: number, to: number) => bytes.subarray(from, to).toString("latin1");
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "audio/webm";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(4, 8) === "ftyp") return "audio/mp4";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mpeg";
  return null;
}

/**
 * A reply as words to read aloud: its Markdown's marks dropped, links read by their words, code
 * blocks and addresses skipped, cut at a sentence once it's long.
 */
export function spokenText(markdown: string, limit = 4_000): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
  return end > limit / 2 ? cut.slice(0, end + 1) : cut;
}
