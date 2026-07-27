import { useEffect, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
import { previewModeAtom, selectedAppIdAtom } from "@/atoms/appAtoms";
import { selectedFileAtom } from "@/atoms/viewAtoms";
import { AlertTriangle, Check, RefreshCw, Wrench, XCircle } from "lucide-react";
import { Problem, ProblemReport } from "@/ipc/types";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { EmptyState, LBadge, LButton } from "@/components/liquid";

import { useStreamChat } from "@/hooks/useStreamChat";
import { useCheckProblems } from "@/hooks/useCheckProblems";
import { createProblemFixPrompt } from "@/shared/problem_prompt";
import { showError } from "@/lib/toast";
import { useTranslation } from "react-i18next";

interface ProblemItemProps {
  problem: Problem;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
}

/**
 * One diagnostic.
 *
 * The row is split into two independent affordances, because it previously had
 * one click target that did the least useful of the two things: the checkbox
 * area selects the problem for the "fix" batch, and the message area opens the
 * file at the offending line. Before, clicking anywhere only toggled selection —
 * there was no way at all to get from a problem to its source, which is the
 * first thing anyone wants.
 */
const ProblemItem = ({
  problem,
  checked,
  onToggle,
  onOpen,
}: ProblemItemProps) => {
  const { t } = useTranslation(["home", "common"]);
  return (
    <div
      className={cn(
        "flex items-start gap-3 border-b border-white/[0.06] px-3 py-2.5 transition-colors",
        checked ? "bg-primary/[0.07]" : "hover:bg-white/[0.04]",
      )}
      data-testid="problem-row"
    >
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        className="mt-0.5 shrink-0"
        aria-label={t("home:preview.problems_panel.selectProblem")}
      />
      <XCircle
        size={15}
        className="mt-0.5 shrink-0 text-[var(--cosmos-red)]"
        aria-hidden
      />
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {/* File and position lead, in the mono face, because that's the part you
            scan a long list by. */}
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-mono text-[11px] text-foreground/85 underline-offset-2 hover:underline">
            {problem.file}
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {problem.line}:{problem.column}
          </span>
          {problem.code ? (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
              {problem.code}
            </span>
          ) : null}
        </span>
        <span className="mt-1 block text-[12px] leading-[1.5] text-foreground">
          {problem.message}
        </span>
      </button>
    </div>
  );
};

interface RecheckButtonProps {
  appId: number;
  onBeforeRecheck?: () => void;
  tone?: "glass" | "primary";
}

const RecheckButton = ({
  appId,
  onBeforeRecheck,
  tone = "glass",
}: RecheckButtonProps) => {
  const { t } = useTranslation(["home", "common"]);
  const { checkProblems, isChecking } = useCheckProblems(appId);
  const [showingFeedback, setShowingFeedback] = useState(false);

  const handleRecheck = async () => {
    onBeforeRecheck?.();
    setShowingFeedback(true);
    const res = await checkProblems();
    setShowingFeedback(false);
    if (res.error) showError(res.error);
  };

  const busy = isChecking || showingFeedback;

  return (
    <LButton
      size="compact"
      tone={tone}
      onClick={handleRecheck}
      disabled={busy}
      data-testid="recheck-button"
      icon={<RefreshCw className={busy ? "animate-spin" : undefined} />}
    >
      {busy
        ? t("home:preview.problems_panel.checkingProblems")
        : t("home:preview.problems_panel.runChecks")}
    </LButton>
  );
};

interface ProblemsSummaryProps {
  problemReport: ProblemReport;
  appId: number;
  selectedCount: number;
  onClearAll: () => void;
  onFixSelected: () => void;
  onSelectAll: () => void;
  canFix: boolean;
}

/**
 * The action bar. Sticky, so "fix selected" stays reachable while scrolling a
 * long list — it used to scroll away with the header.
 */
const ProblemsSummary = ({
  problemReport,
  appId,
  selectedCount,
  onClearAll,
  onFixSelected,
  onSelectAll,
  canFix,
}: ProblemsSummaryProps) => {
  const { t } = useTranslation(["home", "common"]);
  const totalErrors = problemReport.problems.length;

  return (
    <div className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-2 border-b border-white/[0.07] bg-[color-mix(in_srgb,var(--cosmos-deep)_60%,transparent)] px-3 py-2 backdrop-blur-[24px]">
      <LBadge tone="danger">
        {t("home:preview.problems_panel.error", { count: totalErrors })}
      </LBadge>
      <span className="ml-auto flex flex-wrap items-center gap-2">
        <RecheckButton appId={appId} onBeforeRecheck={onClearAll} />
        <LButton
          size="compact"
          tone="glass"
          onClick={selectedCount === 0 ? onSelectAll : onClearAll}
        >
          {selectedCount === 0 ? t("common:selectAll") : t("common:clearAll")}
        </LButton>
        <LButton
          size="compact"
          tone="primary"
          onClick={onFixSelected}
          data-testid="fix-all-button"
          disabled={selectedCount === 0 || !canFix}
          icon={<Wrench />}
        >
          {t("home:preview.problems_panel.fixProblems", {
            count: selectedCount,
          })}
        </LButton>
      </span>
    </div>
  );
};

export function Problems() {
  return (
    <div data-testid="problems-pane" className="h-full">
      <_Problems />
    </div>
  );
}

export function _Problems() {
  const { t } = useTranslation(["home", "common"]);
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const { problemReport } = useCheckProblems(selectedAppId);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const problemKey = (p: Problem) =>
    `${p.file}:${p.line}:${p.column}:${p.code}`;
  const { streamMessage } = useStreamChat();
  const [selectedChatId] = useAtom(selectedChatIdAtom);
  const setSelectedFile = useSetAtom(selectedFileAtom);
  const setPreviewMode = useSetAtom(previewModeAtom);

  // Whenever the problems pane is shown or the report updates, select all problems
  useEffect(() => {
    if (problemReport?.problems?.length) {
      setSelectedKeys(new Set(problemReport.problems.map(problemKey)));
    } else {
      setSelectedKeys(new Set());
    }
  }, [problemReport]);

  /** Jumps to the source of a diagnostic: open the file, at the line, in Files. */
  const openProblem = (problem: Problem) => {
    setSelectedFile({ path: problem.file, line: problem.line });
    setPreviewMode("code");
  };

  if (!selectedAppId) {
    return (
      <EmptyState
        icon={<AlertTriangle />}
        title={t("home:preview.problems_panel.noAppSelectedTitle")}
        description={t("home:preview.problems_panel.noAppSelectedDescription")}
      />
    );
  }

  if (!problemReport) {
    return (
      <EmptyState
        icon={<AlertTriangle />}
        title={t("home:preview.problems_panel.noProblemsReportTitle")}
        description={t(
          "home:preview.problems_panel.noProblemsReportDescription",
        )}
        action={
          <RecheckButton
            appId={selectedAppId}
            tone="primary"
            onBeforeRecheck={() => setSelectedKeys(new Set())}
          />
        }
      />
    );
  }

  if (problemReport.problems.length === 0) {
    return (
      <EmptyState
        icon={<Check className="text-[var(--cosmos-green)]" aria-hidden />}
        title={t("home:preview.problems_panel.noProblemsFound")}
        description="Type checking and the build both came back clean."
        action={<RecheckButton appId={selectedAppId} />}
      />
    );
  }

  const selectedCount = [...selectedKeys].filter((key) =>
    problemReport.problems.some((p) => problemKey(p) === key),
  ).length;

  return (
    <div className="flex h-full flex-col">
      <ProblemsSummary
        problemReport={problemReport}
        appId={selectedAppId}
        selectedCount={selectedCount}
        canFix={Boolean(selectedChatId)}
        onClearAll={() => setSelectedKeys(new Set())}
        onSelectAll={() =>
          setSelectedKeys(
            new Set(problemReport.problems.map((p) => problemKey(p))),
          )
        }
        onFixSelected={() => {
          if (!selectedChatId) return;
          const selectedProblems = problemReport.problems.filter((p) =>
            selectedKeys.has(problemKey(p)),
          );
          const subsetReport: ProblemReport = { problems: selectedProblems };
          streamMessage({
            prompt: createProblemFixPrompt(subsetReport),
            chatId: selectedChatId,
          });
        }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {problemReport.problems.map((problem) => {
          const selKey = problemKey(problem);
          return (
            <ProblemItem
              key={selKey}
              problem={problem}
              checked={selectedKeys.has(selKey)}
              onOpen={() => openProblem(problem)}
              onToggle={() => {
                setSelectedKeys((prev) => {
                  const next = new Set(prev);
                  if (next.has(selKey)) next.delete(selKey);
                  else next.add(selKey);
                  return next;
                });
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
