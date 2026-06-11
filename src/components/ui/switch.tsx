import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "data-checked:bg-primary data-unchecked:bg-black/10 focus-visible:border-ring focus-visible:ring-ring/50 dark:data-unchecked:bg-white/[0.14] shrink-0 rounded-full border border-black/[0.06] p-0.5 shadow-[inset_0_1px_1px_rgba(0,0,0,0.08)] focus-visible:ring-[3px] h-6 w-11 peer group/switch relative inline-flex items-center transition-all outline-none data-disabled:cursor-not-allowed data-disabled:opacity-50 dark:border-white/[0.08]",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="data-checked:bg-primary-foreground data-unchecked:bg-white rounded-full size-5 data-checked:translate-x-5 data-unchecked:translate-x-0 pointer-events-none block ring-0 shadow-[0_2px_8px_rgba(15,23,42,0.18)] transition-transform dark:data-unchecked:bg-zinc-200"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
