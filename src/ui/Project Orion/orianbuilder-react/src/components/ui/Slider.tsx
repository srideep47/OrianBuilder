import { Slider as BaseSlider } from '@base-ui-components/react/slider';

interface Props {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}

export function Slider({ value, defaultValue, onValueChange, min = 0, max = 100, step = 1, className }: Props) {
  return (
    <BaseSlider.Root
      className={`bu-slider ${className ?? ''}`}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(v) => onValueChange?.(typeof v === 'number' ? v : v[0])}
      min={min}
      max={max}
      step={step}
    >
      <BaseSlider.Control className="bu-slider-track">
        <BaseSlider.Track>
          <BaseSlider.Indicator />
          <BaseSlider.Thumb className="bu-slider-thumb" />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
