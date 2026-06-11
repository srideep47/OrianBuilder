import { useTranslation } from "react-i18next";
// @ts-ignore
import openAiLogo from "../../assets/ai-logos/openai-logo.svg";
// @ts-ignore
import googleLogo from "../../assets/ai-logos/google-logo.svg";
// @ts-ignore
import anthropicLogo from "../../assets/ai-logos/anthropic-logo.svg";
import { ipc } from "@/ipc/types";
import { useState } from "react";
import { ArrowUpRight, KeyRound, Wallet } from "lucide-react";

import { Button } from "./ui/button";
import { cn } from "@/lib/utils";
import { hasOrianBuilderProKey } from "@/lib/schemas";
import { useSettings } from "@/hooks/useSettings";

export function ProBanner() {
  const { settings } = useSettings();

  const [selectedBanner] = useState<"ai" | "smart" | "turbo">(() => {
    const options = ["ai", "smart", "turbo"] as const;
    return options[Math.floor(Math.random() * options.length)];
  });

  if (settings && hasOrianBuilderProKey(settings)) {
    return null;
  }

  return (
    <div className="mt-6 max-w-2xl mx-auto">
      {selectedBanner === "ai" ? (
        <AiAccessBanner />
      ) : selectedBanner === "smart" ? (
        <SmartContextBanner />
      ) : (
        <TurboBanner />
      )}
    </div>
  );
}

export function ManageOrianBuilderProButton({
  className,
}: {
  className?: string;
}) {
  const { t } = useTranslation("home");
  return (
    <Button
      variant="outline"
      size="lg"
      className={cn(
        "cursor-pointer w-full mt-4 bg-(--background-lighter) text-primary",
        className,
      )}
      onClick={() => {
        ipc.system.openExternalUrl(
          "https://academy.orianbuilder.sh/subscription",
        );
      }}
    >
      <Wallet aria-hidden="true" className="w-5 h-5" />
      {t("proBanner.manageOrianBuilderPro")}
      <ArrowUpRight aria-hidden="true" className="w-5 h-5" />
    </Button>
  );
}

export function SetupOrianBuilderProButton() {
  const { t } = useTranslation("home");
  return (
    <Button
      variant="outline"
      size="lg"
      className="cursor-pointer w-full bg-(--background-lighter) text-primary"
      onClick={() => {
        ipc.system.openExternalUrl("https://academy.orianbuilder.sh/settings");
      }}
    >
      <KeyRound aria-hidden="true" />
      {t("proBanner.alreadyHavePro")}
    </Button>
  );
}

export function AiAccessBanner() {
  const { t } = useTranslation("home");
  return (
    <div
      className="liquid-glass w-full py-2 sm:py-2.5 md:py-3 rounded-[20px] bg-card/76 flex items-center justify-center relative overflow-hidden ring-1 ring-inset ring-black/5 dark:ring-white/10 shadow-md cursor-pointer transition-all duration-200 hover:shadow-md hover:-translate-y-[1px]"
      onClick={() => {
        ipc.system.openExternalUrl(
          "https://www.orianbuilder.sh/pro?utm_source=orianbuilder-app&utm_medium=app&utm_campaign=in-app-banner-ai-access",
        );
      }}
    >
      <div
        className="absolute inset-0 z-0 bg-gradient-to-tr from-white/60 via-transparent to-transparent pointer-events-none dark:from-white/10"
        aria-hidden="true"
      />
      <div className="relative z-10 text-center flex flex-col items-center gap-0.5 sm:gap-1 md:gap-1.5 px-4 md:px-6 pr-6 md:pr-8">
        <div className="mt-0.5 sm:mt-1 flex items-center gap-2 sm:gap-3 justify-center">
          <div className="text-xl font-semibold tracking-tight text-foreground">
            {t("proBanner.accessLeadingModels")}
          </div>
          <button
            type="button"
            aria-label="Subscribe to OrianBuilder Pro"
            className="inline-flex items-center rounded-3xl bg-primary text-primary-foreground hover:bg-primary/90 shadow px-3 py-1.5 text-xs sm:text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-ring/50"
          >
            {t("proBanner.getOrianBuilderPro")}
          </button>
        </div>

        <div className="mt-1.5 sm:mt-2 grid grid-cols-3 gap-6 md:gap-8 items-center justify-items-center opacity-90">
          <div className="flex items-center justify-center">
            <img
              src={openAiLogo}
              alt="OpenAI"
              width={96}
              height={28}
              className="h-4 md:h-5 w-auto dark:invert"
            />
          </div>
          <div className="flex items-center justify-center">
            <img
              src={googleLogo}
              alt="Google"
              width={110}
              height={30}
              className="h-4 md:h-5 w-auto"
            />
          </div>
          <div className="flex items-center justify-center">
            <img
              src={anthropicLogo}
              alt="Anthropic"
              width={110}
              height={30}
              className="h-3 w-auto dark:invert"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function SmartContextBanner() {
  const { t } = useTranslation("home");
  return (
    <div
      className="liquid-glass w-full py-2 sm:py-2.5 md:py-3 rounded-[20px] bg-card/76 flex items-center justify-center relative overflow-hidden ring-1 ring-inset ring-emerald-900/10 dark:ring-white/10 shadow-md cursor-pointer transition-all duration-200 hover:shadow-md hover:-translate-y-[1px]"
      onClick={() => {
        ipc.system.openExternalUrl(
          "https://www.orianbuilder.sh/pro?utm_source=orianbuilder-app&utm_medium=app&utm_campaign=in-app-banner-smart-context",
        );
      }}
    >
      <div
        className="absolute inset-0 z-0 bg-gradient-to-tr from-white/60 via-transparent to-transparent pointer-events-none dark:from-white/10"
        aria-hidden="true"
      />
      <div className="relative z-10 px-4 md:px-6 pr-6 md:pr-8">
        <div className="mt-0.5 sm:mt-1 flex items-center gap-2 sm:gap-3 justify-center">
          <div className="flex flex-col items-center text-center">
            <div className="text-xl font-semibold tracking-tight text-foreground">
              {t("proBanner.upTo3xCheaper")}
            </div>
            <div className="text-sm sm:text-base mt-1 text-muted-foreground">
              {t("proBanner.byUsingSmartContext")}
            </div>
          </div>
          <button
            type="button"
            aria-label="Get OrianBuilder Pro"
            className="inline-flex items-center rounded-3xl bg-primary text-primary-foreground hover:bg-primary/90 shadow px-3 py-1.5 text-xs sm:text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-ring/50"
          >
            {t("proBanner.getOrianBuilderPro")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TurboBanner() {
  const { t } = useTranslation("home");
  return (
    <div
      className="liquid-glass w-full py-2 sm:py-2.5 md:py-3 rounded-[20px] bg-card/76 flex items-center justify-center relative overflow-hidden ring-1 ring-inset ring-rose-900/10 dark:ring-white/5 shadow-md cursor-pointer transition-all duration-200 hover:shadow-md hover:-translate-y-[1px]"
      onClick={() => {
        ipc.system.openExternalUrl(
          "https://www.orianbuilder.sh/pro?utm_source=orianbuilder-app&utm_medium=app&utm_campaign=in-app-banner-turbo",
        );
      }}
    >
      <div
        className="absolute inset-0 z-0 bg-gradient-to-tr from-white/60 via-transparent to-transparent pointer-events-none dark:from-white/10"
        aria-hidden="true"
      />
      <div className="relative z-10 px-4 md:px-6 pr-6 md:pr-8">
        <div className="mt-0.5 sm:mt-1 flex items-center gap-2 sm:gap-3 justify-center">
          <div className="flex flex-col items-center text-center">
            <div className="text-xl font-semibold tracking-tight text-foreground">
              {t("proBanner.generateCode4x")}
            </div>
            <div className="text-sm sm:text-base mt-1 text-muted-foreground">
              {t("proBanner.withTurboModels")}
            </div>
          </div>
          <button
            type="button"
            aria-label="Get OrianBuilder Pro"
            className="inline-flex items-center rounded-3xl bg-primary text-primary-foreground hover:bg-primary/90 shadow px-3 py-1.5 text-xs sm:text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-ring/50"
          >
            {t("proBanner.getOrianBuilderPro")}
          </button>
        </div>
      </div>
    </div>
  );
}
