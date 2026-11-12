'use client';

import { useState } from 'react';
import { Plus, Trash2 } from '@/components/icons';
import { Select } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/admin/badge';
import { inputClass, RevertButton } from '@/components/admin/config-items';
import { EVERYONE } from '@/components/admin/org/use-org-policy-draft';
import type { SettingsPolicy } from '@/lib/admin/types';
import { TAGS_DEFAULT_KEY, defaultAt, withDefaultAt, type PolicyKeyword } from '@/lib/admin/policy-settings';
import { chooseKeywordId } from '@/lib/keyword-nesting';
import { DEFAULT_KEYWORDS, KEYWORD_PALETTE, KEYWORD_PALETTE_ROWS } from '@/stores/settings-store';
import { cn } from '@/lib/utils';

type PolicyChange = (change: (policy: SettingsPolicy) => SettingsPolicy) => void;

const subLabelClass = 'mt-2 text-xs font-semibold text-muted-foreground';
const noteClass = 'text-xs text-muted-foreground';

/** Longest tag name the server keeps in policy.json (lib/admin/policy-defaults.ts). */
const MAX_LABEL_LENGTH = 100;

const PALETTE_KEYS = KEYWORD_PALETTE_ROWS.flat().filter((key) => key in KEYWORD_PALETTE);
const BASE_COLORS = KEYWORD_PALETTE_ROWS[1];

/** "Light red", "Red", "Dark red". */
function colorLabel(key: string): string {
  const [hue, shade] = key.split('-');
  const name = hue.charAt(0).toUpperCase() + hue.slice(1);
  if (shade === 'light') return `Light ${hue}`;
  if (shade === 'dark') return `Dark ${hue}`;
  return name;
}

function describeCount(value: unknown): string {
  const count = Array.isArray(value) ? value.length : 0;
  return count === 0 ? 'no tags' : count === 1 ? '1 tag' : `${count} tags`;
}

/** A tag being edited. A row added with Add tag has no id yet: it follows the name. */
interface TagRow {
  key: number;
  id: string | null;
  label: string;
  color: string;
}

let nextRowKey = 0;

function toRows(value: unknown): TagRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => ({
      key: nextRowKey++,
      id: typeof entry.id === 'string' ? entry.id : null,
      label: typeof entry.label === 'string' ? entry.label : '',
      color: typeof entry.color === 'string' ? entry.color : 'gray',
    }));
}

interface CheckedRow {
  row: TagRow;
  id: string;
  error: string | null;
}

/**
 * Each row's id, as Settings > Tags picks one for a new tag, and what keeps
 * it out of the policy: no name, or a name or id an earlier row has.
 */
function checkRows(rows: TagRow[]): CheckedRow[] {
  const ids: string[] = [];
  const labels = new Set<string>();
  return rows.map((row) => {
    const label = row.label.trim();
    const id = row.id ?? chooseKeywordId(null, label, ids);
    let error: string | null = null;
    if (!label) error = 'Give this tag a name.';
    else if (labels.has(label.toLowerCase()) || ids.some((taken) => taken.toLowerCase() === id.toLowerCase())) {
      error = 'Another tag has this name.';
    }
    if (id) ids.push(id);
    if (label) labels.add(label.toLowerCase());
    return { row, id, error };
  });
}

function toPolicyList(checked: CheckedRow[]): PolicyKeyword[] {
  return checked
    .filter((entry) => !entry.error)
    .map((entry) => ({ id: entry.id, label: entry.row.label.trim(), color: entry.row.color }));
}

function ColorDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block h-3 w-3 shrink-0 rounded-full', KEYWORD_PALETTE[color]?.dot ?? KEYWORD_PALETTE.gray.dot)}
    />
  );
}

/**
 * The built-in colour tags not yet in the list, to pick one or more of.
 * Rendered in place under the buttons.
 */
function ColorTagPicker({ offered, onAdd, onCancel }: {
  offered: PolicyKeyword[];
  onAdd: (tags: PolicyKeyword[]) => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string, on: boolean) => {
    const next = new Set(checked);
    if (on) next.add(id);
    else next.delete(id);
    setChecked(next);
  };
  return (
    <fieldset
      className="mt-2 rounded-md border border-border bg-muted/30 p-3"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <legend className="px-1 text-xs font-medium text-muted-foreground">Colour tags to add</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {offered.map((tag, index) => (
          <label key={tag.id} className="flex cursor-pointer items-center gap-1.5 text-sm text-foreground">
            <input
              type="checkbox"
              className="rounded border-input"
              checked={checked.has(tag.id)}
              autoFocus={index === 0}
              onChange={(e) => toggle(tag.id, e.target.checked)}
            />
            <ColorDot color={tag.color} />
            {tag.label}
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="h-8 text-xs"
          disabled={checked.size === 0}
          onClick={() => onAdd(offered.filter((tag) => checked.has(tag.id)))}
        >
          Add selected
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * The tags new users start with (`defaults.emailKeywords`, #1612), for
 * Everyone or the scope picked above. A default only: tags can't be locked.
 */
export function TagDefaults({ policy, scopeId, onChange }: { policy: SettingsPolicy; scopeId: string; onChange: PolicyChange }) {
  const preset = defaultAt(policy, scopeId, TAGS_DEFAULT_KEY);
  const scoped = scopeId !== EVERYONE;
  const signature = preset.own ? JSON.stringify(preset.value) : null;
  const [rows, setRows] = useState<TagRow[]>(() => (preset.own ? toRows(preset.value) : []));
  const [seen, setSeen] = useState({ scopeId, signature });
  const [picking, setPicking] = useState(false);

  // Another scope, a revert or the saved policy coming back: start over from
  // the policy. The editor's own writes leave rows that aren't written yet.
  if (seen.scopeId !== scopeId || seen.signature !== signature) {
    setSeen({ scopeId, signature });
    setRows(preset.own ? toRows(preset.value) : []);
    setPicking(false);
  }

  const checked = checkRows(rows);
  const present = new Set(checked.filter((entry) => entry.id).map((entry) => entry.id.toLowerCase()));
  const offered = DEFAULT_KEYWORDS.filter((tag) => !present.has(tag.id.toLowerCase()))
    .map(({ id, label, color }) => ({ id, label, color }));

  const update = (next: TagRow[]) => {
    const list = toPolicyList(checkRows(next));
    setRows(next);
    setSeen({ scopeId, signature: JSON.stringify(list) });
    onChange((p) => withDefaultAt(p, scopeId, TAGS_DEFAULT_KEY, list));
  };
  const revert = () => onChange((p) => withDefaultAt(p, scopeId, TAGS_DEFAULT_KEY, undefined));
  const patchRow = (key: number, patch: Partial<TagRow>) =>
    update(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const addRow = () => {
    const used = new Set(rows.map((row) => row.color));
    const color = BASE_COLORS.find((c) => !used.has(c)) ?? BASE_COLORS[rows.length % BASE_COLORS.length];
    update([...rows, { key: nextRowKey++, id: null, label: '', color }]);
  };
  const addColorTags = (tags: PolicyKeyword[]) => {
    update([...rows, ...tags.map((tag) => ({ key: nextRowKey++, ...tag }))]);
    setPicking(false);
  };

  return (
    <div data-testid="defaults-tags">
      <p className={subLabelClass}>Tags</p>
      <p className={cn(noteClass, 'mt-1')}>
        The tags new users start with. Users who already have tags keep theirs, and anyone can change their own tags afterwards.
      </p>
      {!preset.own ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className={noteClass}>
            {scoped && preset.everyone !== undefined ? `From Everyone: ${describeCount(preset.everyone)}` : 'Built-in: no tags'}
          </p>
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => update([])}>
            <Plus className="h-3.5 w-3.5" /> Set default tags
          </Button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="accent">set</Badge>
            <span className={noteClass}>Built-in: no tags</span>
            <RevertButton onClick={revert} title={scoped ? "Use Everyone's value" : 'Remove the default'} />
          </div>
          {rows.length === 0 && <p className={noteClass}>No tags: new users start without any.</p>}
          {checked.map(({ row, error }) => {
            const errorId = `tag-default-error-${row.key}`;
            const colorOptions = PALETTE_KEYS.map((key) => ({ value: key, label: colorLabel(key) }));
            if (!PALETTE_KEYS.includes(row.color)) colorOptions.unshift({ value: row.color, label: `${row.color} (not valid)` });
            return (
              <div key={row.key} data-testid="tag-default-row">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    aria-label="Tag name"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    value={row.label}
                    maxLength={MAX_LABEL_LENGTH}
                    autoComplete="off"
                    onChange={(e) => patchRow(row.key, { label: e.target.value })}
                    className={cn(inputClass, 'w-full min-w-0 sm:w-56')}
                  />
                  <span className="flex items-center gap-1.5">
                    <ColorDot color={row.color} />
                    <Select
                      value={row.color}
                      ariaLabel="Colour"
                      onChange={(color) => patchRow(row.key, { color })}
                      options={colorOptions}
                    />
                  </span>
                  <button
                    type="button"
                    aria-label="Remove tag"
                    title="Remove tag"
                    onClick={() => update(rows.filter((r) => r.key !== row.key))}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {error && <p id={errorId} className="mt-1 text-xs text-destructive">{error}</p>}
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={addRow}>
              <Plus className="h-3.5 w-3.5" /> Add tag
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              aria-expanded={picking && offered.length > 0}
              disabled={offered.length === 0}
              title={offered.length === 0 ? 'All colour tags are already in the list' : undefined}
              onClick={() => setPicking((open) => !open)}
            >
              <Plus className="h-3.5 w-3.5" /> Add colour tags
            </Button>
          </div>
          {picking && offered.length > 0 && (
            <ColorTagPicker offered={offered} onAdd={addColorTags} onCancel={() => setPicking(false)} />
          )}
        </div>
      )}
    </div>
  );
}
