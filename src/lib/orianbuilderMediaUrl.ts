/**
 * Builds an orian-media:// protocol URL for serving media files in Electron.
 */
export function buildOrianBuilderMediaUrl(
  appPath: string,
  fileName: string,
): string {
  return `orian-media://media/${encodeURIComponent(appPath)}/.orianbuilder/media/${encodeURIComponent(fileName)}`;
}
