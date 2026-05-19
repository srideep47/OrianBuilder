/**
 * Parser for <orianbuilder-quick-action label="..." prompt="..."/> tags emitted
 * by the agent at the end of a turn. The renderer reads these out of the final
 * assistant message and renders them as one-click follow-up buttons.
 *
 * Pattern borrowed from bolt.diy's <bolt-quick-action>.
 */

import { unescapeXmlAttr } from "../../shared/xmlEscape";

export interface QuickAction {
  label: string;
  prompt: string;
}

const QUICK_ACTION_RE =
  /<orianbuilder-quick-action\s+([^>]*?)\s*\/?>(?:<\/orianbuilder-quick-action>)?/gi;
const ATTR_RE = /(\w[\w-]*)="([^"]*)"/g;

function readAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let match: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((match = ATTR_RE.exec(raw)) !== null) {
    out[match[1]] = unescapeXmlAttr(match[2]);
  }
  return out;
}

export function parseQuickActions(text: string): QuickAction[] {
  if (!text || text.indexOf("<orianbuilder-quick-action") === -1) return [];
  const actions: QuickAction[] = [];
  let match: RegExpExecArray | null;
  QUICK_ACTION_RE.lastIndex = 0;
  while ((match = QUICK_ACTION_RE.exec(text)) !== null) {
    const attrs = readAttrs(match[1]);
    const label = (attrs.label ?? "").trim();
    const prompt = (attrs.prompt ?? "").trim();
    if (label && prompt) actions.push({ label: label.slice(0, 24), prompt });
    if (actions.length >= 3) break;
  }
  return actions;
}
