export { VoicePlugin, AUDIO_TAG_VOCABULARY } from "./plugin"
export type { VoiceConfig } from "./plugin"
export {
  parseConfig,
  getMode,
  getTextParts,
  resetState,
  getConfig,
  stripTags,
  setV2Client,
  getTTS,
  setAudioSink,
} from "./plugin"
export { VoiceTTS } from "./elevenlabs"
export type { AudioChunk, AudioSink, BusEmit, Client, ClientFactory, StreamOpts, VoiceTTSOpts } from "./elevenlabs"
