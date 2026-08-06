/**
 * Host-observed visual verification: does the *live route* actually show it?
 *
 * This is the gate that catches the failure the whole acceptance contract exists
 * for. Claude reported success after writing `rainbow-hello.html`, and every
 * other check agreed with it: files changed, the build passed, the preview
 * server was healthy. All of that was true. The page the user was looking at was
 * still `src/pages/Index.tsx`, because the new file was never part of the app.
 *
 * Only rendering the served URL can tell those two situations apart, so this
 * loads it in an offscreen Electron window and reads the resulting DOM. A `fetch`
 * of the same URL would not: a Vite/React app serves an empty `<div id="root">`
 * and every claim about content would come back inconclusive.
 *
 * Two things are deliberately *not* attempted:
 *
 *   - **No semantic judgement of design.** "Make it prettier" has no assertion.
 *     When the goal implies no checkable claim, this verifies render health —
 *     the route renders, has real content, and logged no page errors — and
 *     attaches a screenshot for a human or a vision model to look at. Claiming
 *     more than that would be the same false confidence as trusting the worker.
 *   - **No navigation.** The verifier looks at the route the preview serves. A
 *     crawler would need a route map Orion does not have for an arbitrary
 *     project.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import log from "electron-log";

import { getElectron, getUserDataPath } from "@/paths/paths";

const logger = log.scope("marta-visual");

const LOAD_TIMEOUT_MS = 25_000;
/** Time after load for a client-rendered app to paint its first real content. */
const SETTLE_MS = 1_200;
/** Below this, a "rendered" page is a spinner or an error boundary. */
const MIN_MEANINGFUL_TEXT = 12;
const MAX_TEXT_SAMPLE = 4_000;
const VIEWPORT = { width: 1_440, height: 900 } as const;

export interface VisualExpectation {
  /** Text that must appear in the rendered page. */
  text: string;
  /** Why Orion believes the user asked for it, shown in the evidence. */
  reason: string;
}

export interface VisualInspection {
  ok: boolean;
  url: string;
  title: string | null;
  /** Leading slice of `document.body.innerText`, for evidence and diagnosis. */
  textSample: string;
  /** Rendered element count; distinguishes an empty root from a real page. */
  elementCount: number;
  screenshotPath: string | null;
  /** Expectations that were checked, and whether each one was found. */
  matched: Array<VisualExpectation & { found: boolean }>;
  /** Uncaught page errors and `console.error` output, verbatim. */
  pageErrors: string[];
  detail: string;
}

// ─── Deriving what can honestly be asserted (pure) ───────────────────────────

/** Words too generic to prove anything by their presence in a page. */
const UNCHECKABLE = new Set([
  "app",
  "page",
  "website",
  "site",
  "web",
  "ui",
  "ux",
  "button",
  "component",
  "the",
  "and",
  "with",
  "please",
  "make",
  "add",
  "change",
  "update",
  "small",
  "simple",
  "nice",
  "pretty",
  "modern",
  "clean",
]);

/**
 * Extract checkable claims from the user's own words.
 *
 * Conservative on purpose. A false expectation fails a task that actually
 * succeeded, which trains the user to ignore the gate — strictly worse than
 * having no expectation and saying so.
 */
export function deriveVisualExpectations(goal: string): VisualExpectation[] {
  const expectations: VisualExpectation[] = [];
  const seen = new Set<string>();

  const add = (raw: string, reason: string) => {
    const text = raw.trim().replace(/\s+/g, " ");
    if (text.length < 2 || text.length > 120) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    if (UNCHECKABLE.has(key)) return;
    seen.add(key);
    expectations.push({ text, reason });
  };

  // Quoted text is the strongest signal there is: the user typed the exact
  // string they expect to see.
  for (const match of goal.matchAll(/["“”']([^"“”']{2,120})["“”']/g)) {
    add(match[1], "quoted in the request");
  }

  // "a heading that says Welcome", "with the text Hello there"
  for (const match of goal.matchAll(
    /\b(?:says?|saying|reads?|labelled|labeled|titled|text)\s+(?:that\s+)?(?:says\s+)?([A-Za-z0-9][^.,;!?\n]{1,60})/gi,
  )) {
    add(match[1], "named as the visible text");
  }

  return expectations;
}

/** Case- and whitespace-insensitive containment, as a human would read it. */
export function pageContainsText(pageText: string, expected: string): boolean {
  const normalise = (value: string) =>
    value.toLowerCase().replace(/\s+/g, " ").trim();
  return normalise(pageText).includes(normalise(expected));
}

export function summariseInspection(
  inspection: Omit<VisualInspection, "ok" | "detail">,
): { ok: boolean; detail: string } {
  const missing = inspection.matched.filter((item) => !item.found);
  const rendered = inspection.textSample.trim().length >= MIN_MEANINGFUL_TEXT;

  if (inspection.pageErrors.length > 0) {
    return {
      ok: false,
      detail: `The live route logged ${inspection.pageErrors.length} page error(s): ${inspection.pageErrors
        .slice(0, 3)
        .join(" | ")}`,
    };
  }
  if (!rendered) {
    return {
      ok: false,
      detail:
        "The live route rendered no meaningful content — an empty root, a spinner or an error boundary.",
    };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      detail: `Not visible at the live route: ${missing
        .map((item) => `“${item.text}” (${item.reason})`)
        .join(
          ", ",
        )}. The change may exist in a file the running app never loads.`,
    };
  }
  return {
    ok: true,
    detail:
      inspection.matched.length > 0
        ? `Confirmed at the live route: ${inspection.matched
            .map((item) => `“${item.text}”`)
            .join(", ")}.`
        : `The live route rendered ${inspection.elementCount} elements with no page errors. The request implied no checkable text, so a screenshot is attached instead of a claim.`,
  };
}

// ─── Rendering (impure) ──────────────────────────────────────────────────────

async function screenshotDirectory(): Promise<string> {
  const directory = path.join(getUserDataPath(), "marta-evidence");
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

/**
 * Load `url` offscreen and read what it actually rendered.
 *
 * `show: false` with `paintWhenInitiallyHidden` left at its default is what
 * makes `capturePage()` return real pixels rather than a blank frame, and
 * `backgroundThrottling: false` stops Chromium from parking the renderer's
 * timers the moment the window is not visible — a throttled React app can sit
 * unmounted for the entire settle window and read as an empty page.
 */
export async function inspectLiveRoute(input: {
  url: string;
  goal?: string;
  expectations?: VisualExpectation[];
  /** Injected in tests; production uses Electron's BrowserWindow. */
  timeoutMs?: number;
}): Promise<VisualInspection> {
  const expectations =
    input.expectations ?? deriveVisualExpectations(input.goal ?? "");
  const pageErrors: string[] = [];
  const electron = getElectron();
  const BrowserWindow = electron?.BrowserWindow;

  if (!BrowserWindow) {
    // Not a silent pass: without a renderer there is no visual evidence, and
    // acceptance must treat missing evidence as missing.
    return {
      ok: false,
      url: input.url,
      title: null,
      textSample: "",
      elementCount: 0,
      screenshotPath: null,
      matched: expectations.map((item) => ({ ...item, found: false })),
      pageErrors: [
        "Electron is unavailable, so the live route was not rendered.",
      ],
      detail: "Visual verification requires the Electron renderer.",
    };
  }

  const window = new BrowserWindow({
    show: false,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    webPreferences: {
      offscreen: false,
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      // The page under inspection is the user's own dev server, but it is still
      // untrusted content being loaded by the host process.
      sandbox: true,
      webSecurity: true,
    },
  });

  // Electron 40 delivers one details object rather than positional arguments.
  // An uncaught exception in the page reaches Chromium's console as an error, so
  // this is also how a crashed React render is detected.
  const onConsole = (details: { level: string; message: string }) => {
    if (details.level === "error") pageErrors.push(details.message);
  };
  const onFailLoad = (
    _event: unknown,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame) {
      pageErrors.push(
        `Navigation to ${validatedURL} failed: ${errorDescription} (${errorCode})`,
      );
    }
  };

  try {
    window.webContents.on("console-message", onConsole);
    window.webContents.on("did-fail-load", onFailLoad);

    await Promise.race([
      window.loadURL(input.url),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out loading ${input.url}`)),
          input.timeoutMs ?? LOAD_TIMEOUT_MS,
        ),
      ),
    ]);

    // A client-rendered app finishes `loadURL` with an empty root. Waiting for a
    // fixed settle window is cruder than waiting for a specific selector, but it
    // is the only thing that works for an arbitrary project's stack.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    const probe = (await window.webContents.executeJavaScript(
      `(() => ({
        title: document.title || null,
        text: (document.body ? document.body.innerText : "").slice(0, ${MAX_TEXT_SAMPLE}),
        elementCount: document.getElementsByTagName("*").length,
      }))()`,
      true,
    )) as { title: string | null; text: string; elementCount: number };

    let screenshotPath: string | null = null;
    try {
      const image = await window.webContents.capturePage();
      const directory = await screenshotDirectory();
      const name = `route-${createHash("sha1")
        .update(input.url)
        .digest("hex")
        .slice(0, 10)}-${Date.now()}.png`;
      screenshotPath = path.join(directory, name);
      await fs.writeFile(screenshotPath, image.toPNG());
    } catch (error) {
      // A missing screenshot is a weaker evidence bundle, not a failed check;
      // the DOM assertions above are what the decision rests on.
      logger.warn("Could not capture a preview screenshot:", error);
      screenshotPath = null;
    }

    const partial = {
      url: input.url,
      title: probe.title,
      textSample: probe.text,
      elementCount: probe.elementCount,
      screenshotPath,
      matched: expectations.map((item) => ({
        ...item,
        found: pageContainsText(probe.text, item.text),
      })),
      pageErrors,
    };
    return { ...partial, ...summariseInspection(partial) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      url: input.url,
      title: null,
      textSample: "",
      elementCount: 0,
      screenshotPath: null,
      matched: expectations.map((item) => ({ ...item, found: false })),
      pageErrors: [...pageErrors, message],
      detail: `The live route could not be inspected: ${message}`,
    };
  } finally {
    window.webContents.removeListener("console-message", onConsole);
    window.webContents.removeListener("did-fail-load", onFailLoad);
    if (!window.isDestroyed()) window.destroy();
  }
}
