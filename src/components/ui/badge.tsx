import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow-[0_10px_20px_rgba(0,122,255,0.18)] hover:bg-primary/86",
        secondary:
          "liquid-glass-thin border-black/[0.06] bg-secondary/72 text-secondary-foreground hover:bg-secondary/86 dark:border-white/[0.08]",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow-[0_10px_20px_rgba(255,69,58,0.18)] hover:bg-destructive/86",
        outline:
          "liquid-glass-thin border-black/[0.06] bg-white/56 text-foreground dark:border-white/[0.08] dark:bg-white/[0.06]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
