/**
 * The notification card layer — a dumb view over the typed
 * notify IPC: renders the pushed card stack top-right, newest first, with the
 * same hover→interactive membrane the dock pill uses (the window is
 * click-through except while a card is hovered).
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { NotifyStateView } from '@prismical/desktop-contracts';
import { NotifyCardRow } from './card';

export function NotifyApp({ initialState }: { initialState: NotifyStateView }) {
  const [state, setState] = useState<NotifyStateView>(initialState);
  const interactiveRef = useRef(false);

  useEffect(() => window.notify.onState(setState), []);

  const syncInteractive = useCallback((next: boolean) => {
    if (interactiveRef.current === next) return;
    interactiveRef.current = next;
    window.notify.setInteractive(next);
  }, []);

  // Cards vanished while hovered (expiry/dismiss): drop interactivity so the
  // now-empty transparent panel never eats clicks.
  useEffect(() => {
    if (state.cards.length === 0) syncInteractive(false);
  }, [state.cards.length, syncInteractive]);

  const handleMouseMove = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const target = event.target as HTMLElement | null;
      syncInteractive(target?.closest("[data-card='true']") !== null && target !== null);
    },
    [syncInteractive]
  );
  const handleMouseLeave = useCallback(() => syncInteractive(false), [syncInteractive]);

  const handleAction = useCallback((cardId: string, actionId: string) => {
    window.notify.action(cardId, actionId);
  }, []);

  return (
    <main
      className="h-screen w-screen bg-transparent"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* pr/pt-2: shadow/ring breathing room so card chrome never clips at the
          window edge (computeNotifyBounds compensates so the visual gap from
          the screen corner stays NOTIFY_MARGIN). */}
      <div className="flex flex-col items-end gap-2.5 pr-2 pt-2">
        {state.cards.map(card => (
          <NotifyCardRow key={card.id} card={card} onAction={handleAction} />
        ))}
      </div>
    </main>
  );
}
