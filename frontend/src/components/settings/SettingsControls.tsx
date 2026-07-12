import { useEffect, useState } from 'react';
import { Toggle } from '../ui/Toggle';
import { cn } from '../../utils/cn';

interface ImmediateToggleProps {
  value: boolean;
  onSave: (value: boolean) => Promise<boolean>;
  label: string;
  disabled?: boolean;
}

export function ImmediateToggle({ value, onSave, label, disabled }: ImmediateToggleProps) {
  const [localValue, setLocalValue] = useState(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => setLocalValue(value), [value]);

  return (
    <Toggle
      checked={localValue}
      aria-label={label}
      disabled={disabled || saving}
      onChange={(nextValue) => {
        const previous = localValue;
        setLocalValue(nextValue);
        setSaving(true);
        void onSave(nextValue)
          .then((saved) => {
            if (!saved) setLocalValue(previous);
          })
          .finally(() => setSaving(false));
      }}
    />
  );
}

interface SegmentedOption<T extends string | number> {
  id: T;
  label: string;
  description?: string;
}

interface SegmentedControlProps<T extends string | number> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
  columns?: 2 | 3 | 4;
}

export function SegmentedControl<T extends string | number>({
  value,
  options,
  onChange,
  label,
  columns = 2,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'grid min-w-[220px] gap-1 rounded-md bg-surface-secondary p-1',
        columns === 2 && 'grid-cols-2',
        columns === 3 && 'grid-cols-3',
        columns === 4 && 'grid-cols-4',
      )}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          title={option.description}
          onClick={() => onChange(option.id)}
          className={cn(
            'min-h-8 rounded px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle',
            value === option.id
              ? 'bg-surface-primary text-text-primary shadow-sm'
              : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
