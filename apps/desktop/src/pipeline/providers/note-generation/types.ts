export interface NoteGenerationInput {
  transcript: string;
  noteTitle?: string;
  eventTitle?: string;
}

export interface NoteGenerationResult {
  markdown: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface NoteGenerationProvider {
  readonly name: string;
  generateMarkdown(input: NoteGenerationInput): Promise<NoteGenerationResult>;
}
