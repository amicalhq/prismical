// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { currentLauncherIntent, setLauncherIntent } from '../../src/renderer/main/app/launcher-intent';
import { FloatNoteView } from '../../src/renderer/main/app/float-note-view';

const state = vi.hoisted(() => ({
  create: vi.fn(),
  recording: 'idle',
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
  usePorts: () => ({}),
  useUpdateNote: () => ({ mutate: vi.fn() }),
  useCreateNote: () => ({ isPending: false, mutate: state.create }),
  useNote: (noteId: string) => ({ data: { id: noteId, title: noteId } }),
  useNotes: () => ({ data: [] }),
  useRecording: () => ({ state: state.recording }),
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
vi.mock('@prismical/app-ui/components/note-emoji-picker', () => ({ NoteEmojiPicker: () => null }));
vi.mock('@prismical/app-ui/components/note-history-controls', () => ({
  NoteHistoryControls: () => null,
}));
vi.mock('@prismical/app-ui/components/note-formatting-toolbar', () => ({
  NoteFormattingToolbar: () => null,
}));
vi.mock('@prismical/app-ui/components/note-slash-menu', () => ({ NoteSlashMenu: () => null }));
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
  state.recording = 'idle';
  setLauncherIntent(undefined);
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

it('a replacement launcher navigation ignores old validation and creates its own note', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let finishOld!: (value: boolean) => void;
  const oldValidation = new Promise<boolean>(resolve => { finishOld = resolve; });
  const validate = vi.fn().mockReturnValueOnce(oldValidation).mockResolvedValue(true);
  const open = vi.fn();
  Object.defineProperty(window, 'desktop', { configurable: true, value: { float: { validateLauncherIntent: validate, open } } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(createElement(FloatNoteView, { fresh: true, autoStart: true, launcherIntent: 'old' })));
  expect(state.create).not.toHaveBeenCalled();
  await act(async () => root!.render(createElement(FloatNoteView, { fresh: true, autoStart: true, launcherIntent: 'new' })));
  expect(state.create).toHaveBeenCalledTimes(1);
  await act(async () => finishOld(false));
  expect(currentLauncherIntent()).toBe('new');
  await act(async () => state.create.mock.calls[0]![1].onSuccess({ id: 'new-note' }));
  expect(open).toHaveBeenCalledExactlyOnceWith('new-note');
});
it('a canceled resolver clears its token so manual recording is not contaminated', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'desktop', { configurable: true, value: { float: { validateLauncherIntent: vi.fn().mockResolvedValue(false) } } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(createElement(FloatNoteView, { fresh: true, autoStart: true, launcherIntent: 'canceled' })));
  expect(state.create).not.toHaveBeenCalled();
  expect(currentLauncherIntent()).toBeUndefined();
  expect(container.textContent).toContain('recording.errors.couldNotStart');
  expect(container.textContent).not.toContain('desktop.float.opening');
  expect(container.querySelector('button')?.textContent).toBe('desktop.float.close');
});

it('discarding auto-start while another note records clears its launcher token', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.recording = 'recording';
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(createElement(FloatNoteView, { noteId: 'first', autoStart: true, launcherIntent: 'superseded' })));
  expect(currentLauncherIntent()).toBeUndefined();
});
