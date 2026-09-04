/**
 * The vocabulary row shape the hint and replacement passes consume.
 *
 * Declared here, away from storage adapters, so the pure passes can run
 * wherever a transcript is produced.
 */
export interface VocabularyTerm {
  id: string;
  /** Which vocabulary scope supplied the row. */
  scope: 'personal' | 'team';
  /** What the transcriber tends to produce (a replacement's LEFT side), or the term to teach. */
  word: string;
  /** The correct spelling (a replacement's RIGHT side); null for teach-only entries. */
  replacementWord: string | null;
  isReplacement: boolean;
}
