import type { AnimatedWallsApi } from '@animated-walls/shared-types';

declare global {
  interface Window {
    /** Exposed by the preload script. This is the renderer's only route to the system. */
    readonly animatedWalls: AnimatedWallsApi;
  }
}

export {};
