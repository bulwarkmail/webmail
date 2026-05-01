import { ReactNode } from 'react';
import { Lock, FlaskConical } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SettingsSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
  experimental?: boolean;
  experimentalDescription?: string;
}

export function SettingsSection({ title, description, children, experimental, experimentalDescription }: SettingsSectionProps) {
  return (
    <div className="space-y-4">
      {experimental && (
        <div className="flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/30">
          <FlaskConical className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Experimental Feature</p>
            {experimentalDescription && (
              <p className="text-xs text-amber-700 dark:text-amber-400/80 mt-1">{experimentalDescription}</p>
            )}
          </div>
        </div>
      )}
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
  return (
    <div className={cn("flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4 py-3 border-b border-border last:border-0", locked && "opacity-60")}>
      <div className="flex-1 min-w-0 sm:pr-4">
        <div className="flex items-center gap-1.5">
          <label className="text-sm font-medium text-foreground">{label}</label>
          {locked && <Lock className="w-3 h-3 text-muted-foreground" aria-label="Managed by administrator" />}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      <div className={cn("flex-shrink-0", locked && "pointer-events-none")}>{children}</div>
    </div>
  );
}

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function ToggleSwitch({ checked, onChange, disabled }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
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
          checked ? 'translate-x-6' : 'translate-x-1'
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
  return (
    <div className="flex gap-1.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
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
}

export function Select({ value, onChange, options }: SelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      dir="auto"
      className="px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150 cursor-pointer hover:border-muted-foreground"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
