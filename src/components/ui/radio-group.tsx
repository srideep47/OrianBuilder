"use client";

import * as React from "react";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";
import { Circle } from "lucide-react";

import { cn } from "@/lib/utils";

const RadioGroup = React.forwardRef<
  HTMLDivElement,
  Omit<
    React.ComponentPropsWithoutRef<typeof BaseRadioGroup>,
    "onValueChange"
  > & {
    onValueChange?: (value: string) => void;
  }
>(({ className, onValueChange, ...props }, ref) => {
  return (
    <BaseRadioGroup
      className={cn("grid gap-2", className)}
      onValueChange={(value) => onValueChange?.(value as string)}
      {...props}
      ref={ref}
    />
  );
});
RadioGroup.displayName = "RadioGroup";

const RadioGroupItem = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof Radio.Root>
>(({ className, ...props }, ref) => {
  return (
    <Radio.Root
      ref={ref}
      className={cn(
        "aspect-square h-4 w-4 rounded-full border border-black/[0.1] bg-white/72 text-primary ring-offset-background shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center dark:border-white/[0.12] dark:bg-white/[0.08]",
        className,
      )}
      {...props}
    >
      <Radio.Indicator className="flex items-center justify-center">
        <Circle className="h-2.5 w-2.5 fill-current text-current" />
      </Radio.Indicator>
    </Radio.Root>
  );
});
RadioGroupItem.displayName = "RadioGroupItem";

export { RadioGroup, RadioGroupItem };
