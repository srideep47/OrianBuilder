import { Switch as BaseSwitch } from "@base-ui-components/react/switch";

interface Props {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
}

export function Switch(props: Props) {
  return (
    <BaseSwitch.Root className="bu-switch" {...props}>
      <BaseSwitch.Thumb className="bu-switch-thumb" />
    </BaseSwitch.Root>
  );
}
