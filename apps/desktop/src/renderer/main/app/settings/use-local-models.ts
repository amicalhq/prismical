import { useEffect, useState } from 'react';
import { useDesktopCapabilities } from '@prismical/app-client';
import type { LocalModelsState } from '@prismical/app-contracts';

/** Share the live catalogue between model selection and download management. */
export function useLocalModels(): LocalModelsState | null {
  const caps = useDesktopCapabilities();
  const [state, setState] = useState<LocalModelsState | null>(null);
  useEffect(() => caps.localModels.subscribe(setState), [caps]);
  return state;
}
