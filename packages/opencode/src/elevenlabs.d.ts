declare module "@elevenlabs/elevenlabs-js" {
  export class ElevenLabsClient {
    constructor(opts?: { apiKey?: string })
    textToSpeech: {
      stream: (
        voiceId: string,
        opts: {
          modelId: string
          text: string
          voice_settings: Record<string, unknown>
          outputFormat: string
          pronunciation_dictionary_locators?: unknown
        },
      ) => Promise<AsyncIterable<Uint8Array>>
    }
  }
}
