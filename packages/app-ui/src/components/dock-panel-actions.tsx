'use client';

import * as React from 'react';
import { ChevronDown, Maximize2, Minimize2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { DOCK_CTL_INK2, DOCK_PANEL_ACTIONS_CHROME } from './dock-chrome';
import { useTranslation } from 'react-i18next';

/**
 * The hover-revealed floating action cluster of a dock panel: one bordered,
 * slightly-elevated container pinned top-right INSIDE the panel face, visible
 * only while the panel is hovered or holds focus. Callers put panel-specific actions first;
 * maximize + collapse are appended here so every panel gets them in the same
 * place with the same copy.
 */
export function DockPanelActions({
  isMaximized,
  onToggleMaximized,
  collapseLabel,
  onCollapse,
  forceVisible = false,
  children,
}: {
  isMaximized: boolean;
  onToggleMaximized: () => void;
  /** Copy for the collapse-to-pill control — panel-specific ("Hide transcription",
   * "Collapse"), so it stays honest about what the chevron puts away. */
  collapseLabel: string;
  onCollapse: () => void;
  /** Keep the cluster visible without hover — e.g. while it carries the
   * recording-continues chip, which must never hide. */
  forceVisible?: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`${DOCK_PANEL_ACTIONS_CHROME} ${
        forceVisible ? 'pointer-events-auto opacity-100' : ''
      }`}
    >
      {children}
      <DockPanelAction
        label={
          isMaximized ? t('recording.actions.collapsePanel') : t('recording.actions.expandPanel')
        }
        onClick={onToggleMaximized}
      >
        {isMaximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
      </DockPanelAction>
      <DockPanelAction label={collapseLabel} onClick={onCollapse}>
        <ChevronDown className="size-4" />
      </DockPanelAction>
    </div>
  );
}

/** One 28px control in the cluster, with a tooltip. */
export function DockPanelAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={DOCK_CTL_INK2}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
