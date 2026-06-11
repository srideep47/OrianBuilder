import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "mac-btn inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "border border-transparent bg-primary text-primary-foreground shadow-[0_14px_28px_rgba(0,122,255,0.22)] hover:bg-primary/92 dark:shadow-[0_14px_28px_rgba(10,132,255,0.24)]",
        destructive:
          "border border-transparent bg-destructive text-white shadow-[0_12px_24px_rgba(255,69,58,0.22)] hover:bg-destructive/92 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        outline:
          "liquid-glass-thin border-black/[0.06] bg-white/55 text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] hover:bg-white/70 dark:border-white/[0.1] dark:bg-white/[0.06] dark:hover:bg-white/[0.1]",
        secondary:
          "liquid-glass-thin border border-black/[0.06] bg-secondary/72 text-secondary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.48)] hover:bg-secondary/86 dark:border-white/[0.08]",
        ghost:
          "text-foreground/78 hover:bg-accent/75 hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
        orion: "btn-orion",
        "orion-outline": "btn-orion-outline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 px-6 has-[>svg]:px-4",
        icon: "size-9",
        sidebar: "h-16 w-16",
        orion: "h-auto",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps<T extends React.ElementType = "button"> = {
  as?: T;
} & Omit<React.ComponentPropsWithoutRef<T>, "as"> &
  VariantProps<typeof buttonVariants>;

function Button<T extends React.ElementType = "button">({
  className,
  variant,
  size,
  as,
  ...props
}: ButtonProps<T>) {
  const Comp = (as || "button") as React.ComponentType<any>;

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
