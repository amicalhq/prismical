// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { TagEditDialog } from './tag-edit-dialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${Object.values(vars).join(',')}` : key,
  }),
}));

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});
afterEach(cleanup);

const TAG = { id: 'tag_1', name: 'roadmap', color: '#7f77dd', createdAt: '2026-01-01' };

function submitButton(create: boolean): HTMLButtonElement {
  return screen.getByRole('button', {
    name: create ? 'dialogs.tag.create' : 'common.actions.save',
  }) as HTMLButtonElement;
}

it('seeds create with an empty name and the color the caller suggests', () => {
  const onSubmit = vi.fn();
  render(
    <TagEditDialog
      open
      mode="create"
      defaultColor="#f59e0b"
      onOpenChange={() => {}}
      onSubmit={onSubmit}
    />
  );
  expect((screen.getByLabelText('common.fields.name') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('common.fields.name'), { target: { value: 'roadmap' } });
  fireEvent.click(submitButton(true));
  expect(onSubmit).toHaveBeenCalledWith({ name: 'roadmap', color: '#f59e0b' });
});

// Creating a name that already exists REUSES the live tag, so the color the user just picked would
// be dropped without a word. The dialog has to refuse the name instead.
it('refuses a name another tag already has, case-insensitively', () => {
  const onSubmit = vi.fn();
  render(
    <TagEditDialog
      open
      mode="create"
      takenNames={['Roadmap']}
      onOpenChange={() => {}}
      onSubmit={onSubmit}
    />
  );
  fireEvent.change(screen.getByLabelText('common.fields.name'), { target: { value: 'roadmap' } });
  expect(submitButton(true).disabled).toBe(true);
  expect(screen.getByText('dialogs.tag.nameTaken:roadmap')).toBeTruthy();
  fireEvent.click(submitButton(true));
  expect(onSubmit).not.toHaveBeenCalled();
});

// The server answers a colliding rename with a 409, which reverts the optimistic write — the name
// changes on screen and then flips back under a generic toast.
it('refuses a rename onto another tag\'s name', () => {
  const onSubmit = vi.fn();
  render(
    <TagEditDialog
      open
      tag={TAG}
      takenNames={['calls']}
      onOpenChange={() => {}}
      onSubmit={onSubmit}
    />
  );
  fireEvent.change(screen.getByLabelText('common.fields.name'), { target: { value: 'Calls' } });
  expect(submitButton(false).disabled).toBe(true);
  expect(screen.getByText('dialogs.tag.nameTaken:Calls')).toBeTruthy();
  fireEvent.click(submitButton(false));
  expect(onSubmit).not.toHaveBeenCalled();
});

// `takenNames` is the caller's list of OTHER tags' names, so editing never trips over its own.
it('renames onto a free name', () => {
  const onSubmit = vi.fn();
  render(
    <TagEditDialog
      open
      tag={TAG}
      takenNames={['calls']}
      onOpenChange={() => {}}
      onSubmit={onSubmit}
    />
  );
  fireEvent.change(screen.getByLabelText('common.fields.name'), { target: { value: 'roadmaps' } });
  fireEvent.click(submitButton(false));
  expect(onSubmit).toHaveBeenCalledWith({ name: 'roadmaps' });
});

// A pure recolor must not re-send the name: a legacy name with characters the web charset no
// longer allows would be normalized by an edit that never touched it.
it('sends only what changed when editing', () => {
  const onSubmit = vi.fn();
  render(<TagEditDialog open tag={TAG} onOpenChange={() => {}} onSubmit={onSubmit} />);
  expect(submitButton(false).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('dialogs.tag.useColor:#f59e0b'));
  fireEvent.click(submitButton(false));
  expect(onSubmit).toHaveBeenCalledWith({ color: '#f59e0b' });
});


it('does not overwrite a remote recolor while renaming', () => {
  const onSubmit = vi.fn();
  const view = render(<TagEditDialog open tag={TAG} onOpenChange={() => {}} onSubmit={onSubmit} />);
  fireEvent.change(screen.getByLabelText('common.fields.name'), { target: { value: 'roadmaps' } });
  view.rerender(
    <TagEditDialog open tag={{ ...TAG, color: '#f59e0b' }} onOpenChange={() => {}} onSubmit={onSubmit} />
  );
  fireEvent.click(submitButton(false));
  expect(onSubmit).toHaveBeenCalledWith({ name: 'roadmaps' });
});

it('does not overwrite a remote rename while recoloring', () => {
  const onSubmit = vi.fn();
  const view = render(<TagEditDialog open tag={TAG} onOpenChange={() => {}} onSubmit={onSubmit} />);
  fireEvent.click(screen.getByLabelText('dialogs.tag.useColor:#f59e0b'));
  view.rerender(
    <TagEditDialog open tag={{ ...TAG, name: 'roadmaps' }} onOpenChange={() => {}} onSubmit={onSubmit} />
  );
  fireEvent.click(submitButton(false));
  expect(onSubmit).toHaveBeenCalledWith({ color: '#f59e0b' });
});


it('allows changing the case of its own name from the full tag-name list', () => {
  const onSubmit = vi.fn();
  render(
    <TagEditDialog open tag={TAG} takenNames={['roadmap', 'calls']} onOpenChange={() => {}} onSubmit={onSubmit} />
  );
  fireEvent.change(screen.getByLabelText('common.fields.name'), { target: { value: 'Roadmap' } });
  fireEvent.click(submitButton(false));
  expect(onSubmit).toHaveBeenCalledWith({ name: 'Roadmap' });
});
