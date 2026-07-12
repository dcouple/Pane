import React from 'react';
import { cn } from '../../utils/cn';

interface SettingsSectionProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  spacing?: 'sm' | 'md' | 'lg';
}

export function SettingsSection({
  title,
  description,
  icon,
  children,
  className,
  spacing = 'md'
}: SettingsSectionProps) {
  const spacingClasses = {
    sm: 'space-y-3',
    md: 'space-y-4',
    lg: 'space-y-6'
  };

  return (
    <section className={cn('space-y-1', className)}>
      <div className="flex items-start gap-2 border-b border-border-secondary pb-2">
        {icon && (
          <div className="mt-0.5 flex-shrink-0 text-text-tertiary">
            {icon}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">
            {title}
          </h3>
          {description && (
            <p className="text-xs text-text-tertiary mt-1 leading-relaxed">
              {description}
            </p>
          )}
        </div>
      </div>
      <div className={cn('divide-y divide-border-secondary/70', spacingClasses[spacing])}>
        {children}
      </div>
    </section>
  );
}
