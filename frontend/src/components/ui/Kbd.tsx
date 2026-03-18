import { cn } from '../../utils/cn';

interface KbdProps {
  children: React.ReactNode;
  /** xs = compact (palette footer), sm = default (tooltips/inline), md = larger (help dialog) */
  size?: 'xs' | 'sm' | 'md';
  /** muted adds text-text-tertiary color */
  variant?: 'default' | 'muted';
  className?: string;
}

const sizeStyles = {
  xs: {
    key: 'min-w-[1.1rem] px-1 py-px text-[10px]',
    gap: 'gap-0.5',
    separator: 'text-[10px]',
  },
  sm: {
    key: 'min-w-[1.35rem] px-1.5 py-px text-[11px]',
    gap: 'gap-1',
    separator: 'text-[11px]',
  },
  md: {
    key: 'min-w-[1.6rem] px-2 py-0.5 text-xs',
    gap: 'gap-1',
    separator: 'text-xs',
  },
} as const;

export function Kbd({ children, size = 'sm', variant = 'default', className }: KbdProps) {
  const text = typeof children === 'string' ? children.trim() : null;
  const segments = text ? text.split(' + ').filter(Boolean) : null;
  const hasSegments = !!segments && segments.length > 1;

  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap align-middle',
        sizeStyles[size].gap,
        variant === 'muted' ? 'text-text-tertiary' : 'text-text-secondary',
        className,
      )}
    >
      {hasSegments ? (
        segments.map((segment, index) => (
          <span key={`${segment}-${index}`} className="inline-flex items-center gap-1">
            {index > 0 && (
              <span className={cn('font-mono leading-none opacity-55', sizeStyles[size].separator)}>
                +
              </span>
            )}
            <kbd
              className={cn(
                'inline-flex items-center justify-center rounded-md border border-border-primary/70 bg-surface-primary font-mono font-medium leading-none shadow-[0_1px_0_rgba(255,255,255,0.04),0_1px_2px_rgba(0,0,0,0.16)]',
                sizeStyles[size].key,
              )}
            >
              {segment}
            </kbd>
          </span>
        ))
      ) : (
        <kbd
          className={cn(
            'inline-flex items-center justify-center rounded-md border border-border-primary/70 bg-surface-primary font-mono font-medium leading-none shadow-[0_1px_0_rgba(255,255,255,0.04),0_1px_2px_rgba(0,0,0,0.16)]',
            sizeStyles[size].key,
          )}
        >
          {children}
        </kbd>
      )}
    </span>
  );
}
