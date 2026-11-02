/**
 * The public entry point of services/speech: the names other modules import, and nothing else.
 * Every import from outside this folder goes through here; see docs/contributor/code-quality.md.
 */
export { fetchPreview, fetchVoices, synthesize, testSpeech } from "./speech-client";
export type { SpeechEndpoint, SpokenAudio } from "./speech-client";
export {
  CURATED_VOICES,
  MAX_MAX_CHARS,
  MIN_MAX_CHARS,
  SPEAK_MODES,
  resolveSpeechFor,
  speechSettings,
} from "./speech-settings";
export type { ResolvedSpeech, SpeakMode, SpeechSettings } from "./speech-settings";
export { MAX_VOICE_SECONDS, testTranscription } from "./transcription-client";
export type { Transcriber, Transcript } from "./transcription-client";
export {
  MAX_MAX_SECONDS,
  MIN_MAX_SECONDS,
  resolveTranscriptionFor,
  transcriberFor,
  transcriptionSettings,
} from "./transcription-settings";
export type { ResolvedTranscription, TranscriptionSettings } from "./transcription-settings";
