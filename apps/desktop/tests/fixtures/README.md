# Test fixtures

- `two-speaker.wav` — 19.69-second, 16 kHz mono PCM16 clip with alternating English
  speakers. It is used by the local-ASR integration test (`pnpm test:local-asr`),
  `scripts/transcribe-fixture.ts`, and the whisper wrapper's VAD smoke
  (`packages/whisper-wrapper/scripts/test-vad.js`).
  - Source: [En-us-Frank and Alice dialogue](https://commons.wikimedia.org/wiki/File:En-us-Frank_and_Alice_dialogue.ogg),
    recorded by DroEsperanto and Merpin in 2009 and released into the public domain.
  - Conversion: `ffmpeg -i En-us-Frank_and_Alice_dialogue.ogg -ar 16000 -ac 1 -c:a pcm_s16le two-speaker.wav`
  - Committed WAV SHA-256: `bcbd5f26a5c6d9e7882cb660274cc783a66a9d14abc485aaf98899beb3f6c124`
