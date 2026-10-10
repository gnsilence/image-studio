'use client';

import { useState, type ReactNode } from 'react';

/**
 * Mounts its children on the first activation and keeps them mounted afterwards, so heavy workspaces load on
 * first visit instead of at startup but keep their state when the user switches tabs.
 */
export function MountOnFirstVisit({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  // Render-phase update derived from a prop change (React's "adjusting state when a prop changes" pattern).
  if (active && !visited) setVisited(true);
  return visited ? children : null;
}
