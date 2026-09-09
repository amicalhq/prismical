// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoteEmojiPicker } from './note-emoji-picker';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// Exercise the app's popover lifecycle independently of Frimousse's remote dataset.
vi.mock('./note-emoji-picker-content', () => ({
  default: ({ onSelect }: { onSelect: (emoji: string) => void }) => (
    <button onClick={() => onSelect('🚀')}>Rocket</button>
  ),
}));

afterEach(cleanup);

describe('note emoji picker', () => {
  it('selects an emoji, closes the popover, and returns focus to the trigger', async () => {
    const onChange = vi.fn();
    render(<NoteEmojiPicker onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'notes.actions.changeEmoji' });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Rocket' }));
    expect(onChange).toHaveBeenCalledWith('🚀');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Rocket' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('clears an existing emoji and closes the popover', async () => {
    const onChange = vi.fn();
    render(<NoteEmojiPicker value="🚀" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'notes.actions.changeEmoji' }));
    fireEvent.click(await screen.findByRole('button', { name: 'common.actions.remove' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'common.actions.remove' })).toBeNull());
  });

  it('does not open or modify the icon when disabled', () => {
    const onChange = vi.fn();
    render(<NoteEmojiPicker disabled onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'notes.actions.changeEmoji' });
    expect(trigger.hasAttribute('disabled')).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
