/**
 * Idle pill — a thin sliver that
 * expands on hover to the locked `[〜][📓]` pair: icon-only flat buttons with
 * native tooltips ("Record" / "Note"), 〜 slightly brighter as the primary.
 * 〜 starts a fresh recording; 📓 opens the float slot.
 */
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NotesIconButton, RecordButton } from './widget-buttons';

// Floating dock surface pill:
// opaque raised surface + hairline + deep drop, system-theme aware via the
// widget.css token subset.
export const PILL_SHELL_CLASS =
  'relative pointer-events-auto bg-[var(--dock-surface)] border border-[var(--dock-line)] [box-shadow:var(--dock-shadow-raised),0_16px_40px_-12px_rgba(0,0,0,0.4)]';

export interface IdlePillProps {
  hovered: boolean;
  onRecord: () => void;
  onOpenNote: () => void;
  recordPending: boolean;
  /** A start attempt silently died (permission-denied etc.) — flash a warning
   * affordance; clicking it opens the float note where the error banner lives. */
  startFailed?: boolean;
}

export function IdlePill({
  hovered,
  onRecord,
  onOpenNote,
  recordPending,
  startFailed = false,
}: IdlePillProps) {
  const { t } = useTranslation();
  return (
    <div
      data-hit-zone="true"
      style={{ width: hovered ? (startFailed ? 216 : 84) : 8, height: hovered ? 42 : 56 }}
      className={`${PILL_SHELL_CLASS} flex items-center justify-center overflow-hidden whitespace-nowrap transition-all duration-200 ease-out ${
        hovered ? 'rounded-[14px]' : 'rounded-full'
      }`}
    >
      {hovered && (
        <div className="flex items-center gap-[6px] whitespace-nowrap">
          {/* Record STAYS on failure — it is the retry. The warning is an
              ADDITIONAL details chip, not a takeover: it names the failure and
              opens the float note, whose banner carries the specific error and
              the troubleshooting-docs link. Tooltip = the full explanation. */}
          <RecordButton onClick={onRecord} loading={recordPending} disabled={recordPending} />
          {startFailed ? (
            <button
              type="button"
              onClick={onOpenNote}
              title={t('desktop.widget.startFailedHint')}
              className="flex h-7 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-lg bg-[color-mix(in_srgb,var(--rec)_12%,var(--dock-surface))] px-2 text-[11.5px] font-medium text-[var(--dock-ink)] hover:bg-[color-mix(in_srgb,var(--rec)_18%,var(--dock-surface))]"
            >
              <AlertTriangle className="size-[12px] shrink-0 text-[var(--rec)]" />
              {t('desktop.widget.startFailed')}
              <span className="text-[var(--dock-ink-3)]">·</span>
              <span className="text-[var(--dock-ink-2)]">
                {t('desktop.widget.startFailedDetails')}
              </span>
            </button>
          ) : (
            <NotesIconButton onClick={onOpenNote} />
          )}
        </div>
      )}
    </div>
  );
}
