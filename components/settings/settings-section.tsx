'use client';

import { ReactNode, createContext, useContext, useId } from 'react';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Lets the controls inside a SettingItem borrow the row's visible label as
 * their accessible name. Without it a bare toggle announces as an unnamed
 * switch, since the row label is a <label> with nothing to point at (#722).
 */
const SettingLabelContext = createContext<string | undefined>(undefined);

interface SettingsSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function SettingsSection({ title, description, children }: SettingsSectionProps) {
  return (
    <div data-search-label={title} className="space-y-4">
      <div>
        <h3 className="text-lg font-medium text-foreground">{title}</h3>
        {description && (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

interface SettingItemProps {
  label: string;
  description?: string;
  children: ReactNode;
  locked?: boolean;
}

export function SettingItem({ label, description, children, locked }: SettingItemProps) {
  const labelId = useId();
  return (
    <div
      data-search-label={label}
      className={cn("flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4 py-3 border-b border-border last:border-0", locked && "opacity-60")}
    >
      <div className="flex-1 min-w-0 sm:pe-4">
        <div className="flex items-center gap-1.5">
          <label id={labelId} className="text-sm font-medium text-foreground">{label}</label>
          {locked && <Lock className="w-3 h-3 text-muted-foreground" aria-label="Managed by administrator" />}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      <SettingLabelContext.Provider value={labelId}>
        <div className={cn("flex-shrink-0", locked && "pointer-events-none")}>{children}</div>
      </SettingLabelContext.Provider>
    </div>
  );
}

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Overrides the enclosing SettingItem label as the accessible name. */
  ariaLabel?: string;
  /** Test hook (data-testid) for integration tests. */
  testId?: string;
}

export function ToggleSwitch({ checked, onChange, disabled, ariaLabel, testId }: ToggleSwitchProps) {
  const labelledBy = useContext(SettingLabelContext);
  return (
    <button
      type="button"
      role="switch"
      data-testid={testId}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-150',
        checked ? 'bg-primary' : 'bg-muted',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-background transition-transform duration-150',
          checked ? 'ltr:translate-x-6 rtl:-translate-x-6' : 'ltr:translate-x-1 rtl:-translate-x-1'
        )}
      />
    </button>
  );
}

interface RadioGroupProps {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}

export function RadioGroup({ value, onChange, options }: RadioGroupProps) {
  const labelledBy = useContext(SettingLabelContext);
  return (
    <div className="flex gap-1.5" role="group" aria-labelledby={labelledBy}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'px-3 py-1.5 text-xs rounded-md transition-colors duration-150',
            value === option.value
              ? 'bg-primary text-primary-foreground font-medium'
              : 'bg-muted hover:bg-accent text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function Select({ value, onChange, options, disabled, className, ariaLabel }: SelectProps) {
  const labelledBy = useContext(SettingLabelContext);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : labelledBy}
      dir="auto"
      className={cn(
        "px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150",
        disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:border-muted-foreground",
        className
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
