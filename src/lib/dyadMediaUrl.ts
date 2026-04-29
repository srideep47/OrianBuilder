/**
 * Builds an orian-media:// protocol URL for serving media files in Electron.
 */
export function buildDyadMediaUrl(appPath: string, fileName: string): string {
  return `orian-media://media/${encodeURIComponent(appPath)}/.dyad/media/${encodeURIComponent(fileName)}`;
}
