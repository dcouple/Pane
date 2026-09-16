import type { OuterResizeSeparatorHandlers } from '../../hooks/useOuterPanelResize';

export interface OuterResizeSeparatorProps extends OuterResizeSeparatorHandlers {
  label: string;
  orientation: 'vertical' | 'horizontal';
  value: number;
  minimum: number;
  maximum: number;
  className?: string;
}

export function OuterResizeSeparator({
  label,
  orientation,
  value,
  minimum,
  maximum,
  className = '',
  ...handlers
}: OuterResizeSeparatorProps) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={value}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      tabIndex={0}
      className={`pane-outer-resize-separator pane-outer-resize-separator-${orientation} ${className}`}
      {...handlers}
    >
      <span aria-hidden="true" className="pane-outer-resize-separator-rule" />
    </div>
  );
}
