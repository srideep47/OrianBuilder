import { Download, FileText, Loader2 } from "lucide-react";

interface PdfPreviewMessageProps {
  topic: string;
  dataUri: string;
}

export function PdfPreviewMessage({ topic, dataUri }: PdfPreviewMessageProps) {
  const safeFilename = `${topic.replace(/[^a-z0-9]/gi, "_").slice(0, 60)}.pdf`;
  return (
    <div className="border border-border rounded-xl overflow-hidden bg-(--background-lighter) w-full">
      <div className="flex items-center justify-between px-3 py-2 bg-muted/40 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={15} className="text-primary shrink-0" />
          <span className="text-sm font-medium truncate">{topic}</span>
        </div>
        <a
          href={dataUri}
          download={safeFilename}
          className="flex items-center gap-1 text-xs text-primary hover:underline shrink-0 ml-3"
        >
          <Download size={13} />
          Download PDF
        </a>
      </div>
      <iframe
        src={dataUri}
        title={`PDF: ${topic}`}
        className="w-full border-0"
        style={{ height: "520px" }}
      />
    </div>
  );
}

export function PdfGeneratingMessage() {
  return (
    <div className="flex items-center gap-2 py-3 px-1 text-sm text-muted-foreground">
      <Loader2 size={15} className="animate-spin shrink-0" />
      <span>Generating PDF…</span>
    </div>
  );
}
