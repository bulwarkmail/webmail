'use client';

import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { VacationTemplate } from '@/lib/admin/organisation-policy';
import { isValidEmail } from '@/lib/validation';
import {
  deputyFieldsNeeded,
  fillVacationTemplate,
  sortedVacationTemplates,
  vacationValues,
  type FilledVacationTemplate,
  type VacationFillInput,
} from '@/lib/vacation-templates';
import { SettingsSection } from './settings-section';

const FIELD =
  'w-full sm:w-64 max-w-full px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground ' +
  'placeholder:text-muted-foreground focus:outline-hidden transition-colors duration-150 hover:border-muted-foreground';

/**
 * "Use a template" on the out-of-office page: the organisation's reply
 * texts. Picking one asks for the deputy first when the text names one,
 * and only "Use this text" fills the fields, so nothing half-filled is
 * saved by the page's auto-save.
 */
export function VacationTemplatePicker({ library, base, onApply }: {
  library: readonly VacationTemplate[];
  /** Everything but the deputy, from the account and the dates on the page. */
  base: Omit<VacationFillInput, 'deputy' | 'deputyName'>;
  onApply: (filled: FilledVacationTemplate) => void;
}) {
  const t = useTranslations('vacation_templates');
  const id = useId();
  const templates = useMemo(() => sortedVacationTemplates(library), [library]);
  const [selectedId, setSelectedId] = useState('');
  const [deputy, setDeputy] = useState('');
  const [deputyName, setDeputyName] = useState('');
  const [tried, setTried] = useState(false);
  const selected = templates.find((tpl) => tpl.id === selectedId) ?? null;
  const needs = selected ? deputyFieldsNeeded(selected) : { address: false, name: false };
  const addressError = needs.address && !isValidEmail(deputy.trim());
  const nameError = needs.name && !deputyName.trim();

  if (templates.length === 0) return null;

  const categories = [...new Set(templates.map((tpl) => tpl.category))];

  const apply = () => {
    if (!selected) return;
    if (addressError || nameError) {
      setTried(true);
      return;
    }
    onApply(fillVacationTemplate(selected, vacationValues({ ...base, deputy, deputyName })));
    setSelectedId('');
    setTried(false);
  };

  return (
    <SettingsSection id="vacation-templates" title={t('title')} description={t('description')}>
      <div className="space-y-3 py-2" data-testid="vacation-template-picker">
        <div>
          <label htmlFor={`${id}-pick`} className="mb-1 block text-sm font-medium text-foreground">{t('pick_label')}</label>
          <select
            id={`${id}-pick`}
            data-testid="vacation-template-select"
            value={selectedId}
            onChange={(e) => { setSelectedId(e.target.value); setTried(false); }}
            className={FIELD}
          >
            <option value="">{t('pick_placeholder')}</option>
            {categories.map((category) => {
              const options = templates.filter((tpl) => tpl.category === category).map((tpl) => (
                <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
              ));
              return category ? <optgroup key={category} label={category}>{options}</optgroup> : options;
            })}
          </select>
        </div>
        {selected && (
          <>
            {needs.address && (
              <div>
                <label htmlFor={`${id}-deputy`} className="mb-1 block text-sm font-medium text-foreground">{t('deputy_label')}</label>
                <input
                  id={`${id}-deputy`}
                  type="email"
                  data-testid="vacation-template-deputy"
                  value={deputy}
                  onChange={(e) => setDeputy(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
                  placeholder={t('deputy_placeholder')}
                  aria-invalid={tried && addressError}
                  aria-describedby={tried && addressError ? `${id}-deputy-error` : `${id}-deputy-hint`}
                  className={FIELD}
                />
                {tried && addressError
                  ? <p id={`${id}-deputy-error`} className="mt-1 text-xs text-red-600 dark:text-red-400">{t('deputy_missing')}</p>
                  : <p id={`${id}-deputy-hint`} className="mt-1 text-xs text-muted-foreground">{t('deputy_hint')}</p>}
              </div>
            )}
            {needs.name && (
              <div>
                <label htmlFor={`${id}-deputy-name`} className="mb-1 block text-sm font-medium text-foreground">{t('deputy_name_label')}</label>
                <input
                  id={`${id}-deputy-name`}
                  type="text"
                  data-testid="vacation-template-deputy-name"
                  value={deputyName}
                  onChange={(e) => setDeputyName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
                  aria-invalid={tried && nameError}
                  className={FIELD}
                />
                {tried && nameError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t('deputy_name_missing')}</p>}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" size="sm" onClick={apply} data-testid="vacation-template-apply">{t('apply')}</Button>
              <span className="text-xs text-muted-foreground">{t('apply_hint')}</span>
            </div>
          </>
        )}
      </div>
    </SettingsSection>
  );
}
