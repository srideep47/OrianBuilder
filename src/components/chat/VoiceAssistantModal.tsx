import React, { useMemo } from "react";
import { Mic, MicOff, Loader2, Zap, Volume2 } from "lucide-react";
import { useVoiceAssistant } from "@/hooks/useVoiceAssistant";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface VoiceAssistantModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled?: boolean;
  onTranscription?: (text: string) => void;

  /**
   * When this value changes, the modal will call `toggleRecording()`.
   * Used by the home-page mic to implement start/stop on repeated clicks.
   */
  toggleRecordingToken?: number;
}

/**
 * Voice Assistant Modal Component
 * Provides a rich UI for voice interaction with speech recognition, response generation, and TTS
 */
export function VoiceAssistantModal({
  open,
  onOpenChange,
  enabled = true,
  onTranscription,
  toggleRecordingToken,
}: VoiceAssistantModalProps) {
  const {
    context,
    isRecording,
    isTranscribing,
    isSpeaking,
    toggleRecording,
    speakReply,
    clearConversation,
    stopAllAudio,
  } = useVoiceAssistant({
    enabled: open && enabled,
    onTranscription,
  });

  const visualizerHeights = useMemo(() => [14, 28, 42, 58, 42, 28, 14], []);
  const isActive = isRecording || isSpeaking;
  const hasReply = context.assistantText.trim().length > 0;
  const canSpeak = hasReply && !isTranscribing && !isRecording && !isSpeaking;

  const handleClose = () => {
    stopAllAudio();
    onOpenChange(false);
  };

  React.useEffect(() => {
    if (!open || !enabled) return;
    if (toggleRecordingToken === undefined) return;
    toggleRecording();
  }, [open, enabled, toggleRecordingToken, toggleRecording]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="max-w-md p-0 gap-0 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 border-slate-800"
        style={{ maxHeight: "85vh", overflow: "hidden" }}
      >
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b border-slate-800">
          <div>
            <h2 className="text-2xl font-bold text-slate-100">
              Voice Assistant
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Ready to listen for your voice commands
            </p>
          </div>
          <div className="w-12 h-12 rounded-full bg-blue-500/10 flex items-center justify-center flex-shrink-0">
            <Zap className="w-6 h-6 text-blue-400" />
          </div>
        </div>

        {/* Chat Area - Scrollable */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* User Message */}
          <div>
            <p className="text-xs text-slate-500 font-semibold mb-2 text-right uppercase tracking-wider">
              YOU SAID
            </p>
            <div className="bg-gradient-to-r from-blue-600 to-blue-500 rounded-2xl px-4 py-3 ml-auto max-w-xs shadow-lg">
              <p className="text-slate-100 text-sm font-medium leading-relaxed">
                {context.userText || "Tap the mic and speak your question."}
              </p>
            </div>
          </div>

          {/* Assistant Response */}
          <div>
            <p className="text-xs text-cyan-400 font-semibold mb-2 uppercase tracking-widest">
              ASSISTANT REPLY
            </p>
            <div className="bg-slate-800 border border-slate-700 rounded-2xl px-4 py-3 max-w-xs">
              {isTranscribing ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                  <p className="text-slate-300 text-sm">
                    Building your answer...
                  </p>
                </div>
              ) : (
                <p className="text-slate-300 text-sm leading-relaxed">
                  {context.assistantText ||
                    "Your reply will appear here after speech is recognized."}
                </p>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          {hasReply && (
            <div className="flex gap-2 mt-4">
              <button
                onClick={clearConversation}
                className="flex-1 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-semibold rounded-full border border-slate-600 transition-colors uppercase"
              >
                CLEAR
              </button>
              <button
                onClick={speakReply}
                disabled={!canSpeak}
                className={cn(
                  "flex-1 px-3 py-2 text-xs font-semibold rounded-full border transition-colors uppercase",
                  canSpeak
                    ? "bg-slate-700 hover:bg-slate-600 text-slate-200 border-slate-600"
                    : "bg-slate-800 text-slate-500 border-slate-700 cursor-not-allowed opacity-50",
                )}
              >
                SOUND
              </button>
            </div>
          )}

          {/* Status and Visualizer */}
          <div className="bg-slate-800/50 border border-slate-700 rounded-3xl p-6 flex flex-col items-center gap-4 mt-4">
            <p className="text-slate-400 text-xs text-center">
              {context.statusMessage}
            </p>
            <div className="flex items-center justify-center gap-2 min-h-14">
              {visualizerHeights.map((height, index) => (
                <div
                  key={index}
                  className={cn(
                    "w-2 rounded-full transition-all duration-200",
                    isActive
                      ? "bg-gradient-to-t from-cyan-400 to-blue-400"
                      : "bg-slate-600",
                  )}
                  style={{
                    height: `${height}px`,
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Bottom Controls */}
        <div className="flex justify-between gap-3 p-5 border-t border-slate-800 bg-slate-900/50">
          <button
            onClick={stopAllAudio}
            disabled={!isRecording && !isSpeaking && !isTranscribing}
            className={cn(
              "flex-1 flex flex-col items-center justify-center gap-1 py-4 rounded-3xl transition-all border",
              isRecording || isSpeaking || isTranscribing
                ? "bg-slate-700 border-slate-600 text-slate-200 hover:bg-slate-600"
                : "bg-slate-800 border-slate-700 text-slate-400 opacity-50 cursor-not-allowed",
            )}
            title="Stop recording or playback"
          >
            <MicOff className="w-5 h-5" />
            <span className="text-xs font-semibold">STOP</span>
          </button>

          <button
            onClick={toggleRecording}
            disabled={isTranscribing || isSpeaking}
            className={cn(
              "flex-1 flex flex-col items-center justify-center gap-1 py-5 rounded-3xl transition-all border font-semibold text-white",
              isTranscribing || isSpeaking
                ? "bg-slate-700 border-slate-600 opacity-50 cursor-not-allowed"
                : isRecording
                  ? "bg-red-600 border-red-500 hover:bg-red-700 shadow-lg shadow-red-600/30"
                  : "bg-blue-600 border-blue-500 hover:bg-blue-700 shadow-lg shadow-blue-600/30",
            )}
            title={isRecording ? "Stop recording" : "Start recording"}
          >
            <Mic className="w-6 h-6" />
            <span className="text-xs font-bold">
              {isRecording ? "LIVE" : "MIC"}
            </span>
          </button>

          <button
            onClick={speakReply}
            disabled={!canSpeak}
            className={cn(
              "flex-1 flex flex-col items-center justify-center gap-1 py-4 rounded-3xl transition-all border",
              canSpeak
                ? "bg-slate-700 border-slate-600 text-slate-200 hover:bg-slate-600"
                : "bg-slate-800 border-slate-700 text-slate-400 opacity-50 cursor-not-allowed",
            )}
            title="Speak the assistant reply"
          >
            <Volume2 className="w-5 h-5" />
            <span className="text-xs font-semibold">SOUND</span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
