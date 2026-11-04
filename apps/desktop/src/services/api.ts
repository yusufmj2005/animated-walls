export const api = window.animatedWalls;

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Electron prefixes IPC failures with its own plumbing text, which helps nobody.
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
