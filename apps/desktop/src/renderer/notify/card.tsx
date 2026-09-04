/**
 * One notification card: a uniform 336px slim
 * horizontal row — identity LEFT (28px gradient app badge for call-detected;
 * inset calendar-color bar for upcoming-meeting; amber bar for auto-pause) →
 * flexing 2-line content (title + platform glyph, meta subtitle, both
 * ellipsized) → actions RIGHT. No ✕ — clicking the card body dismisses. A 2px
 * bottom progress loader shows time to the auto behavior (white/35 dismiss,
 * amber auto-pause countdown); the animation is cosmetic — expiry authority is
 * main-side (the sweeper), the bar just matches it visually.
 */
import { memo } from 'react';
import { Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NotifyCard } from '@prismical/desktop-contracts';

/** The pill shell chrome, card-shaped (shared visual language with the dock). */
const CARD_SHELL_CLASS =
  "relative pointer-events-auto overflow-hidden rounded-xl bg-black/80 dark:bg-black/70 backdrop-blur-md ring-[1px] ring-black/60 shadow-[0px_0px_15px_0px_rgba(0,0,0,0.40)] before:content-[''] before:absolute before:inset-[1px] before:rounded-[11px] before:outline before:outline-white/15 before:pointer-events-none";

/** The detection-pill badge treatment: 22→28px gradient tile + app initial. */
function AppBadge({ appName }: { appName: string }) {
  return (
    <span
      className="flex size-7 flex-none items-center justify-center rounded-md text-[13px] font-semibold text-white"
      style={{ background: 'linear-gradient(135deg, rgb(45,140,255), rgb(30,111,217))' }}
    >
      {appName.charAt(0).toUpperCase()}
    </span>
  );
}

/** Platform glyph for a joinUrl (brand glyphs land later; Video is the fallback). */
function PlatformGlyph() {
  return <Video className="size-[14px] flex-none text-white/45" />;
}

export interface NotifyCardRowProps {
  readonly card: NotifyCard;
  readonly onAction: (cardId: string, actionId: string) => void;
}

/**
 * Memoized: a stack push for ANOTHER card must not re-render this row — the
 * loader's animation shorthand embeds time, and a re-render would restart it.
 */
export const NotifyCardRow = memo(function NotifyCardRow({ card, onAction }: NotifyCardRowProps) {
  const { t } = useTranslation();
  const amber = card.accent === 'amber';
  const remainingMs = card.expiresAtMs !== null ? Math.max(0, card.expiresAtMs - Date.now()) : null;

  return (
    <div
      data-card="true"
      role="button"
      aria-label={t('desktop.notify.dismiss', { title: card.title })}
      onClick={() => onAction(card.id, 'dismiss')}
      className={`${CARD_SHELL_CLASS} flex w-[336px] cursor-pointer items-center gap-2.5 px-3 py-2.5`}
    >
      {/* Identity — the app's OWN language: badge / calendar bar / amber bar. */}
      {card.kind === 'call-detected' && card.appName !== null ? (
        <AppBadge appName={card.appName} />
      ) : (
        <span
          className="h-8 w-1.5 flex-none rounded-sm"
          style={{
            background: amber ? '#fbbf24' : (card.calendarColor ?? 'rgba(255,255,255,0.25)'),
          }}
        />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-white/90">{card.title}</span>
          {card.kind === 'upcoming-meeting' && <PlatformGlyph />}
        </div>
        <div className="truncate text-[12px] text-white/50">{card.subtitle}</div>
      </div>

      <div className="flex flex-none items-center gap-1.5">
        {card.actions.map(action => (
          <button
            key={action.id}
            type="button"
            onClick={event => {
              event.stopPropagation();
              onAction(card.id, action.id);
            }}
            className={
              action.primary
                ? 'rounded-full bg-white/[0.12] px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-white/20'
                : 'rounded-full px-3 py-1.5 text-[12px] font-medium text-white/65 transition-colors hover:bg-white/10 hover:text-white'
            }
          >
            {action.label}
          </button>
        ))}
      </div>

      {/* 2px bottom loader. Full-duration animation with a NEGATIVE delay =
          start mid-keyframe at the card's true TTL position — a (memo-miss)
          re-render resumes at the right spot instead of restarting, and the
          animation alone owns transform (no inline transform to fight it). */}
      {remainingMs !== null && card.durationMs !== null && card.durationMs > 0 && (
        <span className="absolute inset-x-0 bottom-0 h-[2px] bg-white/[0.07]">
          <span
            className={`block h-full origin-left ${amber ? 'bg-amber-400/80' : 'bg-white/35'}`}
            style={{
              animationName: 'notify-loader',
              animationDuration: `${card.durationMs}ms`,
              animationDelay: `-${card.durationMs - remainingMs}ms`,
              animationTimingFunction: 'linear',
              animationFillMode: 'forwards',
            }}
          />
        </span>
      )}
    </div>
  );
});
