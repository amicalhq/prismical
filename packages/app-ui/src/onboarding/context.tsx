'use client';
import * as React from 'react';
import type { Walkthrough, WalkthroughEvent } from './state';
export const WalkthroughContext = React.createContext<(event: WalkthroughEvent) => void>(() => {});
export const WalkthroughStageContext = React.createContext<Extract<
  Walkthrough,
  { status: 'active' }
> | null>(null);
export const useWalkthroughEvent = () => React.useContext(WalkthroughContext);
export const useWalkthroughStage = () => React.useContext(WalkthroughStageContext);
