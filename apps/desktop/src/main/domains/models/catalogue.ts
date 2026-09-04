/**
 * The local model catalogue. Link-only: every entry points at
 * the upstream Hugging Face `resolve/main` file with a pinned SHA-1 — Prismical
 * never redistributes weights, and the pin turns a silently swapped upstream
 * file into a typed checksum-mismatch rather than a corrupt install.
 *
 * The six multilingual ggml entries define the local catalogue (id / name /
 * filename / URL / SHA-1 / approximate size — their sizes are UI
 * figures, rounded here to whole bytes; the downloader prefers the response's
 * content-length and only falls back to `sizeBytes`). `whisper-base-en` is the
 * English-only model verified end to end and the desktop's recommended
 * default (`language: 'en'` is the desktop constant); its size is exact.
 *
 * The one `kind: 'vad'` entry is whisper.cpp's own ggml Silero conversion
 * (ggml-silero-v5.1.2.bin from the ggml-org/whisper-vad repo — NOT under
 * ggerganov/whisper.cpp): downloaded/reconciled exactly like a whisper model,
 * auto-fetched beside the first whisper install (live.ts), and enabled by the
 * local lane whenever `installedPath(VAD_MODEL_ID)` answers. Its size is
 * exact; the SHA-1 pin doubles as the SIGABRT defense — whisper.cpp aborts the
 * process on a non-Silero ggml passed as a VAD model, so only verified bytes
 * ever reach `vad_model_path`.
 */
import type { ModelKind } from '@prismical/desktop-contracts';

export interface ModelCatalogueEntry {
  readonly id: string;
  /** Display name (the renderer routes it through i18n / a catalogue literal). */
  readonly name: string;
  /** On-disk filename under AppConfig.modelsDir (also the `.part` stem). */
  readonly filename: string;
  readonly downloadUrl: string;
  /** SHA-1 hex the downloaded (or adopted) file must match. */
  readonly sha1: string;
  /** Approximate or exact size — progress fallback + free-space check. */
  readonly sizeBytes: number;
  readonly kind: ModelKind;
  /** The one the settings screen suggests when nothing is installed. */
  readonly recommended?: boolean;
}

const HF_WHISPER_CPP = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const HF_WHISPER_VAD = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main';

/** The desktop's suggested first download (English-only base). */
export const RECOMMENDED_MODEL_ID = 'whisper-base-en';

/** The one VAD entry — what the local lane resolves to enable whisper.cpp's VAD. */
export const VAD_MODEL_ID = 'silero-vad-v5';

export const MODEL_CATALOGUE: ReadonlyArray<ModelCatalogueEntry> = [
  {
    id: 'whisper-base-en',
    name: 'Whisper Base (English)',
    filename: 'ggml-base.en.bin',
    downloadUrl: `${HF_WHISPER_CPP}/ggml-base.en.bin`,
    sha1: '137c40403d78fd54d454da0f9bd998f78703390c',
    sizeBytes: 147_964_211,
    kind: 'whisper',
    recommended: true,
  },
  {
    id: 'whisper-tiny',
    name: 'Whisper Tiny',
    filename: 'ggml-tiny.bin',
    downloadUrl: `${HF_WHISPER_CPP}/ggml-tiny.bin`,
    sha1: 'bd577a113a864445d4c299885e0cb97d4ba92b5f',
    sizeBytes: Math.round(77.7 * 1024 * 1024),
    kind: 'whisper',
  },
  {
    id: 'whisper-base',
    name: 'Whisper Base',
    filename: 'ggml-base.bin',
    downloadUrl: `${HF_WHISPER_CPP}/ggml-base.bin`,
    sha1: '465707469ff3a37a2b9b8d8f89f2f99de7299dac',
    sizeBytes: 148 * 1024 * 1024,
    kind: 'whisper',
  },
  {
    id: 'whisper-small',
    name: 'Whisper Small',
    filename: 'ggml-small.bin',
    downloadUrl: `${HF_WHISPER_CPP}/ggml-small.bin`,
    sha1: '55356645c2b361a969dfd0ef2c5a50d530afd8d5',
    sizeBytes: 488 * 1024 * 1024,
    kind: 'whisper',
  },
  {
    id: 'whisper-medium',
    name: 'Whisper Medium',
    filename: 'ggml-medium.bin',
    downloadUrl: `${HF_WHISPER_CPP}/ggml-medium.bin`,
    sha1: 'fd9727b6e1217c2f614f9b698455c4ffd82463b4',
    sizeBytes: Math.round(1.53 * 1024 * 1024 * 1024),
    kind: 'whisper',
  },
  {
    id: 'whisper-large-v3',
    name: 'Whisper Large v3',
    filename: 'ggml-large-v3.bin',
    downloadUrl: `${HF_WHISPER_CPP}/ggml-large-v3.bin`,
    sha1: 'ad82bf6a9043ceed055076d0fd39f5f186ff8062',
    sizeBytes: Math.round(3.1 * 1024 * 1024 * 1024),
    kind: 'whisper',
  },
  {
    id: 'whisper-large-v3-turbo',
    name: 'Whisper Large v3 Turbo',
    filename: 'ggml-large-v3-turbo.bin',
    downloadUrl: `${HF_WHISPER_CPP}/ggml-large-v3-turbo.bin`,
    sha1: '4af2b29d7ec73d781377bfd1758ca957a807e941',
    sizeBytes: Math.round(1.5 * 1024 * 1024 * 1024),
    kind: 'whisper',
  },
  {
    id: VAD_MODEL_ID,
    name: 'Silero VAD',
    filename: 'ggml-silero-v5.1.2.bin',
    downloadUrl: `${HF_WHISPER_VAD}/ggml-silero-v5.1.2.bin`,
    sha1: 'a372f48dcf0bd9e4330eef2802bc46e061c19634',
    sizeBytes: 885_098,
    kind: 'vad',
  },
];

export const findCatalogueEntry = (modelId: string): ModelCatalogueEntry | undefined =>
  MODEL_CATALOGUE.find(entry => entry.id === modelId);
