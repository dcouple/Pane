import type { ReactNode } from 'react';
import { SETTINGS_CATEGORIES } from './catalog';
import type { SettingsCategoryId } from '../../types/settings';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/Select';
import { cn } from '../../utils/cn';

interface SettingsLayoutProps {
  category: SettingsCategoryId;
  onCategoryChange: (category: SettingsCategoryId) => void;
  children: ReactNode;
}
export function SettingsLayout({ category, onCategoryChange, children }: SettingsLayoutProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="hidden min-h-0 border-r border-border-primary bg-surface-secondary/35 p-3 md:block">
        <nav aria-label="Settings categories" className="space-y-0.5">
          {SETTINGS_CATEGORIES.map((item) => {
            const Icon = item.icon;
            const selected = item.id === category;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={selected ? 'page' : undefined}
                disabled={item.availability?.disabled}
                title={item.availability?.reason}
                onClick={() => onCategoryChange(item.id)}
                className={cn(
                  'flex h-9 w-full items-center gap-2 rounded-md border-l-2 px-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle',
                  selected
                    ? 'border-interactive bg-interactive/20 font-semibold text-interactive ring-1 ring-inset ring-interactive/30'
                    : 'border-transparent text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                  item.availability?.disabled && 'cursor-not-allowed opacity-45',
                )}
              >
                <Icon className="h-4 w-4 flex-none" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="border-b border-border-primary p-3 md:hidden">
        <label className="mb-1.5 block text-xs font-medium text-text-secondary" htmlFor="settings-category-select">
          Category
        </label>
        <Select value={category} onValueChange={(value) => onCategoryChange(value as SettingsCategoryId)}>
          <SelectTrigger id="settings-category-select" aria-label="Settings category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SETTINGS_CATEGORIES.map((item) => (
              <SelectItem key={item.id} value={item.id} disabled={item.availability?.disabled}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <main className="min-h-0 overflow-y-auto px-5 py-6 sm:px-7 md:px-9" data-testid="settings-content">
        {children}
      </main>
    </div>
  );
}
