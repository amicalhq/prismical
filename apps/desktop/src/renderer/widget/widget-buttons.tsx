/**
 * Widget pill buttons use lucide-react without @tabler/icons-react or an
 * `assets/icon.svg` image glyph. Visual classes are preserved; only the icon
 * source and the framer-motion-free structure differ.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AudioLines, Loader2, NotebookPen, Pause, Play, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Pill controls use flat, borderless icon
 * buttons with a soft hover wash and 30px hit areas, the in-app
 * NoteRecordingDock's own treatment.
 * Every flat button stops propagation: the pill BODY click opens the app,
 * and a control press must never double as a body click.
 */
const FLAT_BUTTON_CLASS =
  'flex size-7 flex-none items-center justify-center rounded-lg bg-transparent text-[var(--dock-ink-3)] transition-colors hover:bg-[var(--dock-hover)] hover:text-[var(--dock-ink)] disabled:cursor-not-allowed disabled:opacity-60';

export interface FlatIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
}

export const FlatIconButton = forwardRef<HTMLButtonElement, FlatIconButtonProps>(
  function FlatIconButton({ children, className, onClick, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        data-hit-zone="true"
        {...props}
        onClick={event => {
          event.stopPropagation();
          onClick?.(event);
        }}
        className={`${FLAT_BUTTON_CLASS} ${className ?? ''}`}
      >
        {children}
      </button>
    );
  }
);

/** Idle 〜 Record — the primary action, slightly brighter than its sibling. */
export const RecordButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }
>(function RecordButton({ loading, disabled, ...props }, ref) {
  const { t } = useTranslation();
  return (
    <FlatIconButton
      ref={ref}
      aria-label={t('desktop.widget.record')}
      title={t('desktop.widget.record')}
      disabled={disabled || loading}
      className="text-[var(--dock-ink-2)]"
      {...props}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : <AudioLines className="size-4" />}
    </FlatIconButton>
  );
});

export const PauseButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function PauseButton(props, ref) {
    const { t } = useTranslation();
    return (
      <FlatIconButton
        ref={ref}
        aria-label={t('desktop.widget.pauseRecording')}
        title={t('desktop.widget.pause')}
        className="text-[var(--dock-ink-2)]"
        {...props}
      >
        <Pause className="size-[18px] fill-current" />
      </FlatIconButton>
    );
  }
);

export const ResumeButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function ResumeButton(props, ref) {
    const { t } = useTranslation();
    return (
      <FlatIconButton
        ref={ref}
        aria-label={t('desktop.widget.resumeRecording')}
        title={t('desktop.widget.resume')}
        className="text-[var(--dock-ink-2)]"
        {...props}
      >
        <Play className="size-[18px] fill-current" />
      </FlatIconButton>
    );
  }
);

export interface TakeNotesButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
}

export const TakeNotesButton = forwardRef<HTMLButtonElement, TakeNotesButtonProps>(
  function TakeNotesButton({ loading, disabled, className, ...props }, ref) {
    const { t } = useTranslation();
    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled || loading}
        data-hit-zone="true"
        {...props}
        className={`flex h-8 items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.08] pl-1 pr-3 text-[12px] font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors hover:border-white/25 hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-60 ${className ?? ''}`}
      >
        {/* The widget bundle has no app-icon asset, so use a lucide glyph in the same chip. */}
        <span className="flex size-[22px] flex-none items-center justify-center rounded-md bg-white/[0.12] text-white">
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <NotebookPen className="size-3.5" />
          )}
        </span>
        <span>{t('desktop.widget.takeNotes')}</span>
      </button>
    );
  }
);

export interface OutlinedIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
}

export const OutlinedIconButton = forwardRef<HTMLButtonElement, OutlinedIconButtonProps>(
  function OutlinedIconButton({ children, className, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        data-hit-zone="true"
        {...props}
        className={`flex size-8 items-center justify-center rounded-full border border-white/20 bg-transparent text-white/70 transition-colors hover:border-white/35 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 ${className ?? ''}`}
      >
        {children}
      </button>
    );
  }
);

export const StopButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function StopButton({ className, ...props }, ref) {
    const { t } = useTranslation();
    return (
      <FlatIconButton
        ref={ref}
        aria-label={t('desktop.widget.stopRecording')}
        title={t('desktop.widget.stop')}
        className={`text-[var(--rec)] hover:text-[var(--rec)] ${className ?? ''}`}
        {...props}
      >
        <Square className="size-[13px] fill-current text-current" />
      </FlatIconButton>
    );
  }
);

export interface DragHandleProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Fade/slide the grip in only while the cluster is hovered or being dragged. */
  shown: boolean;
}

/**
 * The drag grip — a small dotted handle left of the pill
 * cluster. It is a hit-zone; onPointerDown starts a drag session (see app.tsx).
 * framer-motion opacity/x springs replaced with a CSS transition (port convention).
 */
export const DragHandle = forwardRef<HTMLButtonElement, DragHandleProps>(function DragHandle(
  { shown, className, ...props },
  ref
) {
  const { t } = useTranslation();
  return (
    <button
      ref={ref}
      type="button"
      data-hit-zone="true"
      aria-label={t('desktop.widget.drag')}
      {...props}
      className={`flex h-[34px] w-[18px] flex-none touch-none items-center justify-center rounded-full border border-[var(--dock-line)] bg-[var(--dock-surface)] text-[var(--dock-ink-3)] [box-shadow:var(--dock-shadow-raised)] transition-all duration-150 ease-out hover:text-[var(--dock-ink-2)] ${
        shown
          ? 'pointer-events-auto translate-x-0 opacity-100'
          : 'pointer-events-none translate-x-1.5 opacity-0'
      } ${className ?? ''}`}
    >
      <div className="grid grid-cols-2 gap-[3px]">
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} className="size-[3px] rounded-full bg-current" />
        ))}
      </div>
    </button>
  );
});

/**
 * The 📓 Note button — icon semantics (locked): the notebook on the pill means
 * "open the floating note". The caller decides whether to focus the float or
 * the main app.
 */
export const NotesIconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(function NotesIconButton({ className, ...props }, ref) {
  const { t } = useTranslation();
  return (
    <FlatIconButton
      ref={ref}
      aria-label={t('desktop.widget.note')}
      title={t('desktop.widget.note')}
      className={`${className ?? ''}`}
      {...props}
    >
      <NotebookPen className="size-4" />
    </FlatIconButton>
  );
});
