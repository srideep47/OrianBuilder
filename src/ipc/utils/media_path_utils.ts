import path from "node:path";

/**
 * The root ".orianbuilder" directory within each app that holds OrianBuilder-managed files.
 */
export const ORIANBUILDER_INTERNAL_DIR_NAME = ".orianbuilder";

/**
 * The ".orianbuilder"-relative subdir for uploaded media files.
 */
export const ORIANBUILDER_MEDIA_SUBDIR = "media";

/**
 * The ".orianbuilder"-relative subdir for screenshot files.
 */
export const ORIANBUILDER_SCREENSHOT_SUBDIR = "screenshot";

/**
 * The subdirectory within each app where uploaded media files are stored.
 */
export const ORIANBUILDER_MEDIA_DIR_NAME = `${ORIANBUILDER_INTERNAL_DIR_NAME}/${ORIANBUILDER_MEDIA_SUBDIR}`;

/**
 * The subdirectory within each app where screenshot files are stored.
 */
export const ORIANBUILDER_SCREENSHOT_DIR_NAME = `${ORIANBUILDER_INTERNAL_DIR_NAME}/${ORIANBUILDER_SCREENSHOT_SUBDIR}`;

/**
 * Maximum number of per-commit screenshots retained per app.
 */
export const MAX_SCREENSHOTS_PER_APP = 100;

/**
 * Matches a screenshot filename keyed by a 40-char hex SHA-1 commit hash.
 */
export const SCREENSHOT_FILENAME_REGEX = /^[0-9a-f]{40}\.png$/;

/**
 * Check if an absolute path falls within the app's .orianbuilder/media directory.
 * Used to validate that file copy operations only read from the allowed media dir.
 */
export function isWithinOrianBuilderMediaDir(
  absPath: string,
  appPath: string,
): boolean {
  const resolved = path.resolve(absPath);
  const resolvedMediaDir = path.resolve(
    path.join(appPath, ORIANBUILDER_MEDIA_DIR_NAME),
  );
  const relativePath = path.relative(resolvedMediaDir, resolved);
  return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

/**
 * Check if an absolute path is a file inside a .orianbuilder/media directory
 * (without requiring a known app path). Validates by finding consecutive
 * ".orianbuilder" + "media" path segments with at least one segment (filename) after,
 * then confirms the resolved path doesn't escape via ".." traversal.
 */
export function isFileWithinAnyOrianBuilderMediaDir(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  const segments = resolved.split(path.sep);

  let mediaIdx = -1;
  for (let i = 0; i < segments.length - 2; i++) {
    if (segments[i] === ".orianbuilder" && segments[i + 1] === "media") {
      mediaIdx = i + 1;
      break;
    }
  }
  if (mediaIdx === -1) {
    return false;
  }

  const mediaDirPath = segments.slice(0, mediaIdx + 1).join(path.sep);
  const relativePath = path.relative(mediaDirPath, resolved);
  return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}
