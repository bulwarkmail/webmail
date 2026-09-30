"use client";

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, GripVertical, Plus, X } from '@/components/icons';
import { useSettingsStore } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { SettingItem, Select, ToggleSwitch } from './settings-section';
import { cn } from '@/lib/utils';
import {
  MAX_SORT_LEVELS,
  ORDER_PRESETS,
  SORT_CRITERIA,
  defaultDirection,
  detectPreset,
  isKeywordCriterion,
  presetLevels,
  sanitizeSortLevels,
  type OrderPreset,
  type SortCriterion,
  type SortDirection,
  type SortLevel,
} from '@/lib/message-list-order';

/** Semantic direction labels per criterion: [desc, asc] translation keys. */
const DIRECTION_LABELS: Record<SortCriterion, [string, string]> = {
  unread: ['unread_first', 'read_first'],
  starred: ['starred_first', 'unstarred_first'],
  tag: ['tagged_first', 'untagged_first'],
  receivedAt: ['newest_first', 'oldest_first'],
  sentAt: ['newest_first', 'oldest_first'],
  from: ['z_to_a', 'a_to_z'],
  subject: ['z_to_a', 'a_to_z'],
  size: ['largest_first', 'smallest_first'],
};

/**
 * Re-fetches the current folder so a changed order shows up without leaving
 * settings and coming back (the Pro interface keeps the mail tab mounted).
 */
function refetchCurrentList() {
  const client = useAuthStore.getState().client;
  const store = useEmailStore.getState();
  if (client && store.selectedMailbox) {
    void store.fetchEmails(client, store.selectedMailbox, { background: true });
  }
}

/**
 * Settings → Appearance → "Message list order" (#718). A preset dropdown for
 * the common cases and an advanced editor for up to MAX_SORT_LEVELS ordered
 * {criterion, direction} levels, mapped onto the JMAP Email/query sort.
 */
export function MessageListOrderSettings() {
  const t = useTranslations('settings.appearance.message_list_order');
  const { messageListOrder, messageListOrderScope, emailKeywords, updateSetting } = useSettingsStore();
  const { isSettingLocked, isSettingHidden } = usePolicyStore();
  const client = useAuthStore((s) => s.client);

  const preset = detectPreset(messageListOrder);
  const [advanced, setAdvanced] = useState(preset === 'custom');
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // A server that lists its sort options without hasKeyword cannot order by
  // read state, stars or tags; say so rather than silently showing a
  // chronological list the user believes is prioritised.
  const sortOptions = client?.getEmailQuerySortOptions?.() ?? null;
  const keywordSortUnsupported = sortOptions !== null && !sortOptions.includes('hasKeyword');

  if (isSettingHidden('messageListOrder')) return null;
  const locked = isSettingLocked('messageListOrder');

  const apply = (next: SortLevel[]) => {
    updateSetting('messageListOrder', sanitizeSortLevels(next));
    refetchCurrentList();
  };

  const firstTagId = emailKeywords[0]?.id;
  const presetTagId = messageListOrder.find((l) => l.criterion === 'tag')?.tagId ?? firstTagId;

  const onPresetChange = (value: string) => {
    const next = value as OrderPreset;
    if (next === 'custom') return;
    apply(presetLevels(next, presetTagId));
  };

  const updateLevel = (index: number, patch: Partial<SortLevel>) => {
    apply(messageListOrder.map((level, i) => {
      if (i !== index) return level;
      const merged = { ...level, ...patch };
      if (patch.criterion && patch.criterion !== level.criterion) {
        merged.direction = defaultDirection(patch.criterion);
        if (patch.criterion === 'tag') merged.tagId = merged.tagId ?? firstTagId;
        else delete merged.tagId;
      }
      return merged;
    }));
  };

  const moveLevel = (from: number, to: number) => {
    if (to < 0 || to >= messageListOrder.length || from === to) return;
    const next = [...messageListOrder];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    apply(next);
  };

  const removeLevel = (index: number) => apply(messageListOrder.filter((_, i) => i !== index));

  const usedCriteria = new Set(messageListOrder.map((l) => l.criterion));
  const addLevel = () => {
    if (messageListOrder.length >= MAX_SORT_LEVELS) return;
    const criterion = SORT_CRITERIA.find((c) => !usedCriteria.has(c) && (c !== 'tag' || firstTagId));
    if (!criterion) return;
    const level: SortLevel = { criterion, direction: defaultDirection(criterion) };
    if (criterion === 'tag') level.tagId = firstTagId;
    apply([...messageListOrder, level]);
  };

  const presetOptions = [
    ...ORDER_PRESETS
      .filter((p) => p !== 'tagged_first' || emailKeywords.length > 0)
      .map((p) => ({ value: p, label: t(`preset.${p}`) })),
    ...(preset === 'custom' ? [{ value: 'custom', label: t('preset.custom') }] : []),
  ];

  const tagOptions = emailKeywords.map((k) => ({ value: k.id, label: k.label }));

  const criterionOptions = (current: SortCriterion) =>
    SORT_CRITERIA
      .filter((c) => c === current || (!usedCriteria.has(c) && (c !== 'tag' || emailKeywords.length > 0)))
      .map((c) => ({ value: c, label: t(`criteria.${c}`) }));

  const directionOptions = (criterion: SortCriterion) => {
    const [desc, asc] = DIRECTION_LABELS[criterion];
    return [
      { value: 'desc', label: t(`direction.${desc}`) },
      { value: 'asc', label: t(`direction.${asc}`) },
    ];
  };

  return (
    <>
      <SettingItem label={t('label')} description={t('description')} locked={locked}>
        <div className="flex flex-col items-start sm:items-end gap-2">
          <Select value={preset} onChange={onPresetChange} options={presetOptions} disabled={locked} />
          {preset === 'tagged_first' && !advanced && tagOptions.length > 0 && (
            <Select
              value={presetTagId ?? ''}
              onChange={(tagId) => apply(presetLevels('tagged_first', tagId))}
              options={tagOptions}
              disabled={locked}
              ariaLabel={t('tag_label')}
            />
          )}
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="text-xs text-primary hover:underline"
            aria-expanded={advanced}
            data-testid="message-list-order-advanced-toggle"
          >
            {advanced ? t('advanced_hide') : t('advanced_show')}
          </button>
        </div>
      </SettingItem>

      {advanced && (
        <div className="py-3 border-b border-border" data-testid="message-list-order-editor">
          <ol className="flex flex-col gap-2">
            {messageListOrder.map((level, index) => (
              <li
                key={`${level.criterion}-${level.tagId ?? ''}-${index}`}
                draggable={!locked}
                onDragStart={(e) => { setDragIndex(index); e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                onDrop={(e) => { e.preventDefault(); if (dragIndex !== null) moveLevel(dragIndex, index); setDragIndex(null); }}
                onDragEnd={() => setDragIndex(null)}
                className={cn(
                  'flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5',
                  dragIndex === index && 'opacity-50',
                )}
                data-testid={`message-list-order-level-${index}`}
              >
                <span className="flex items-center gap-1 text-xs text-muted-foreground w-10 flex-shrink-0">
                  <GripVertical className="w-4 h-4 cursor-grab" aria-hidden="true" />
                  {index + 1}.
                </span>
                <Select
                  value={level.criterion}
                  onChange={(criterion) => updateLevel(index, { criterion: criterion as SortCriterion })}
                  options={criterionOptions(level.criterion)}
                  disabled={locked}
                  ariaLabel={t('criterion_label', { n: index + 1 })}
                />
                {level.criterion === 'tag' && (
                  <Select
                    value={level.tagId ?? ''}
                    onChange={(tagId) => updateLevel(index, { tagId })}
                    options={tagOptions}
                    disabled={locked}
                    ariaLabel={t('tag_label')}
                  />
                )}
                <Select
                  value={level.direction}
                  onChange={(direction) => updateLevel(index, { direction: direction as SortDirection })}
                  options={directionOptions(level.criterion)}
                  disabled={locked}
                  ariaLabel={t('direction_label', { n: index + 1 })}
                />
                <span className="flex items-center gap-0.5 ms-auto">
                  <button
                    type="button"
                    onClick={() => moveLevel(index, index - 1)}
                    disabled={locked || index === 0}
                    className="p-1 rounded hover:bg-muted disabled:opacity-40"
                    aria-label={t('move_up')}
                    title={t('move_up')}
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveLevel(index, index + 1)}
                    disabled={locked || index === messageListOrder.length - 1}
                    className="p-1 rounded hover:bg-muted disabled:opacity-40"
                    aria-label={t('move_down')}
                    title={t('move_down')}
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeLevel(index)}
                    disabled={locked}
                    className="p-1 rounded hover:bg-muted disabled:opacity-40"
                    aria-label={t('remove_level')}
                    title={t('remove_level')}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-3 mt-2">
            {messageListOrder.length < MAX_SORT_LEVELS && (
              <button
                type="button"
                onClick={addLevel}
                disabled={locked}
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-40"
                data-testid="message-list-order-add-level"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('add_level')}
              </button>
            )}
            <span className="text-xs text-muted-foreground">{t('tiebreak_note')}</span>
          </div>
        </div>
      )}

      {keywordSortUnsupported && messageListOrder.some((l) => isKeywordCriterion(l.criterion)) && (
        <p className="py-2 text-xs text-amber-600 dark:text-amber-400" role="status">
          {t('unsupported_note')}
        </p>
      )}

      <SettingItem label={t('scope.label')} description={t('scope.description')} locked={locked}>
        <ToggleSwitch
          checked={messageListOrderScope === 'all'}
          onChange={(checked) => {
            updateSetting('messageListOrderScope', checked ? 'all' : 'inbox');
            refetchCurrentList();
          }}
          disabled={locked}
          testId="message-list-order-scope"
        />
      </SettingItem>
    </>
  );
}
