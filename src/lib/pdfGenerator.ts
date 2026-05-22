import { jsPDF } from "jspdf";
import { atom } from "jotai";
import { streamChatResponse } from "./chatStream";

/** Global atom for the active PDF in the preview panel. */
export const pdfPreviewDataAtom = atom<{
  topic: string;
  dataUri: string;
} | null>(null);

/** Written into message.content while the PDF is still being generated. */
export const PDF_GENERATING_SENTINEL = "__pdf_generating__";

/**
 * Generates informational prose about a topic via AI.
 *
 * Uses streamChatResponse (the same streaming path as inline chat) wrapped in
 * a Promise so it works with both the app's embedded local model AND
 * OpenRouter — both of which require streaming mode (stream: true).
 * Non-streaming POSTs to the embedded server return empty content, which is
 * why this approach replaces the earlier non-streaming implementation.
 *
 * Falls back to a built-in template only when streaming returns nothing or
 * when the AI is completely unavailable.
 */
export async function generatePdfContent(
  topic: string,
  openRouterApiKey?: string,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let buffer = "";

    const prompt =
      `Write a detailed, well-structured informational document about "${topic}". ` +
      `Cover the following in 5 to 6 clear paragraphs: ` +
      `(1) what ${topic} is and why it matters, ` +
      `(2) its history and origins, ` +
      `(3) key characteristics and defining properties, ` +
      `(4) real-world applications and importance, ` +
      `(5) interesting or lesser-known facts. ` +
      `Write in fluent, informative prose. No markdown, no bullet points, ` +
      `no headers, no numbered lists — plain paragraphs separated by blank lines only.`;

    streamChatResponse([{ role: "user", content: prompt }], openRouterApiKey, {
      onChunk: (delta) => {
        buffer += delta;
      },
      onEnd: () => {
        resolve(buffer.trim() || builtInContent(topic));
      },
      onError: () => {
        resolve(builtInContent(topic));
      },
    });
  });
}

/** Always-available content so the PDF is never blank. */
function builtInContent(topic: string): string {
  const t = topic.charAt(0).toUpperCase() + topic.slice(1);
  return [
    `${t} is a subject of considerable depth and broad significance. It touches on multiple areas of human knowledge and has been the focus of study, curiosity, and practical application across many disciplines and cultures throughout history.`,

    `The origins of ${t} can be traced back through centuries of human inquiry and observation. Early thinkers and practitioners laid the groundwork for our modern understanding, and each subsequent generation has refined, expanded, and sometimes challenged what came before, building a rich body of accumulated knowledge.`,

    `Among the defining characteristics of ${t} are its scope, complexity, and the way it interconnects with neighbouring fields. This interconnected nature means that progress in related areas frequently illuminates new dimensions of ${t}, creating a dynamic relationship between discovery and application.`,

    `The practical importance of ${t} in everyday life and across various industries is substantial. From guiding decisions at the individual level to informing large-scale policy and technological development, its influence reaches far beyond academic circles and shapes the world in tangible, meaningful ways.`,

    `Researchers and practitioners continue to investigate open questions surrounding ${t}, employing an ever-growing array of tools and methodologies. Each new finding adds texture to our collective understanding, sometimes confirming long-held assumptions and sometimes overturning them entirely in favour of more nuanced explanations.`,

    `In summary, ${t} stands as a vital and evolving area of knowledge. Its relevance shows no sign of diminishing; if anything, growing complexity in the modern world makes a thorough understanding of ${t} more valuable than ever for anyone seeking to engage thoughtfully with the challenges and opportunities ahead.`,
  ].join("\n\n");
}

/**
 * Returns the extracted topic when input matches:
 *   "create a pdf on <topic>"
 *   "create a pdf on a topic like <topic>"
 */
export function extractPdfTopic(input: string): string | null {
  const match = input
    .trim()
    .match(/^create\s+a\s+pdf\s+on(?:\s+a\s+topic\s+like)?\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Builds a structured A4 PDF and returns a jsPDF data URI string. */
export function buildPdf(topic: string, content: string): string {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 20;
  const maxW = pageW - margin * 2;
  const lineH = 7;

  // Header bar
  doc.setFillColor(59, 130, 246);
  doc.rect(0, 0, pageW, 18, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Generated by OrianBuilder", margin, 12);

  // Topic heading
  doc.setTextColor(30, 30, 30);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  const topicLines = doc.splitTextToSize(topic, maxW);
  doc.text(topicLines, margin, 34);

  // Divider
  const headingBottom = 34 + topicLines.length * 9;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, headingBottom + 2, pageW - margin, headingBottom + 2);

  // Body text — render each paragraph with extra spacing between them
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(50, 50, 50);

  const paragraphs = content
    .split(/\n\n+/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter(Boolean);

  let y = headingBottom + 14;

  for (const para of paragraphs) {
    const lines = doc.splitTextToSize(para, maxW);
    for (const line of lines) {
      if (y + lineH > pageH - margin) {
        doc.addPage();
        y = margin + 10;
      }
      doc.text(line, margin, y);
      y += lineH;
    }
    y += 4; // paragraph gap
  }

  // Footer
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "italic");
    doc.setFontSize(9);
    doc.setTextColor(150, 150, 150);
    doc.text(`Page ${p} of ${totalPages}`, pageW - margin, pageH - 8, {
      align: "right",
    });
  }

  return doc.output("datauristring");
}
