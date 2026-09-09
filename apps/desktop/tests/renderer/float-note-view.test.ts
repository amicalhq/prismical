// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FloatNoteView } from '../../src/renderer/main/app/float-note-view';

const state = vi.hoisted(() => ({
  nextSynced: false,
  firstDoc: {},
  nextDoc: {},
  firstEditor: { setEditable: vi.fn() },
  nextEditor: { setEditable: vi.fn() },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../src/renderer/telemetry', () => ({ captureRendererException: vi.fn() }));
vi.mock('@prismical/app-client', () => ({
  startLoadingTiming: () => ({ mark: vi.fn(), finish: vi.fn() }),
  useDeviceSettings: () => ({ has: () => false }),
  useCreateNote: () => ({ isPending: false, mutate: vi.fn() }),
  useNote: (noteId: string) => ({ data: { id: noteId, title: noteId } }),
  useNotes: () => ({ data: [] }),
  useRecording: () => ({ state: 'idle' }),
  useNoteCollab: (noteId: string) => ({
    doc: noteId === 'first' ? state.firstDoc : state.nextDoc,
    synced: noteId === 'first' || state.nextSynced,
    status: 'connected',
    scope: 'read-write',
    error: null,
  }),
  buildWebEditorExtensions: () => [],
  useSkillDiffDecorations: vi.fn(),
}));
// TipTap belongs to app-ui, not the native desktop package.
vi.mock('../../../../packages/app-ui/node_modules/@tiptap/react', () => ({
  useEditor: (_options: unknown, dependencies: unknown[]) =>
    dependencies[0] === state.firstDoc ? state.firstEditor : state.nextEditor,
  EditorContent: () => null,
}));
vi.mock('@prismical/app-ui/components/note-title-field', () => ({ NoteTitleField: () => null }));
vi.mock('@prismical/app-ui/components/inline-skill-popover', () => ({
  InlineSkillPopover: () => null,
}));
vi.mock('@prismical/app-ui/components/recording-bottom-cluster', async () => {
  const { useCurrentNoteEditor } = await import('@prismical/app-ui/shell/current-editor-context');
  return {
    RecordingBottomCluster: () => {
      const { editorNoteId } = useCurrentNoteEditor();
      return createElement('output', null, editorNoteId ?? 'waiting-for-body');
    },
  };
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  state.nextSynced = false;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('waits for the next floating note body before exposing its editor to skill review', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(FloatNoteView, { noteId: 'first' })));
  expect(container.querySelector('output')?.textContent).toBe('first');

  // The previous note synced already; that readiness must not transfer to a
  // replacement Y.Doc whose body is still loading in this same floating window.
  await act(async () => root!.render(createElement(FloatNoteView, { noteId: 'next' })));
  expect(container.querySelector('output')?.textContent).toBe('waiting-for-body');
  state.nextSynced = true;
  await act(async () => root!.render(createElement(FloatNoteView, { noteId: 'next' })));
  expect(container.querySelector('output')?.textContent).toBe('next');
});
