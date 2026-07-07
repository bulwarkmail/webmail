'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { X, FileText, Pencil, Trash2, Star, Copy, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TemplateForm } from './template-form';
import { useTemplateStore } from '@/stores/template-store';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import type { EmailTemplate } from '@/lib/template-types';

interface TemplateManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TemplateManagerModal({ isOpen, onClose }: TemplateManagerModalProps) {
  const t = useTranslations('templates');
  const tSettings = useTranslations('settings.templates');

  const {
    templates,
    addTemplate,
    updateTemplate,
    deleteTemplate,
    duplicateTemplate,
    toggleFavorite,
    searchTemplates,
  } = useTemplateStore();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const modalRef = useFocusTrap({
    isActive: isOpen,
    onEscape: () => {
      if (isCreating || editingId) {
        setIsCreating(false);
        setEditingId(null);
      } else {
        onClose();
      }
    },
    restoreFocus: true,
  });

  const filtered = searchQuery ? searchTemplates(searchQuery) : templates;

  const handleSave = (data: Omit<EmailTemplate, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (editingId) {
      updateTemplate(editingId, data);
      setEditingId(null);
    } else {
      addTemplate(data);
      setIsCreating(false);
    }
  };

  const handleDelete = (id: string) => {
    deleteTemplate(id);
    setDeleteConfirmId(null);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[1px] flex items-center justify-center z-50 p-4 animate-in fade-in duration-150">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-manager-title"
        className={cn(
          'bg-background border border-border rounded-lg shadow-xl',
          'w-full max-w-3xl max-h-[90vh] overflow-hidden',
          'animate-in zoom-in-95 duration-200'
        )}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <FileText className="w-5 h-5 text-muted-foreground" />
            <h2 id="template-manager-title" className="text-lg font-semibold text-foreground">
              {tSettings('title')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[calc(90vh-80px)]">
          {!isCreating && !editingId && (
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('search_placeholder')}
                  className="ps-9"
                />
              </div>
              <Button
                onClick={() => setIsCreating(true)}
                size="sm"
              >
                {tSettings('add')}
              </Button>
            </div>
          )}

          {isCreating && (
            <div className="mb-6 p-4 border border-border rounded-lg bg-muted/30">
              <h3 className="text-sm font-semibold mb-4">{tSettings('add')}</h3>
              <TemplateForm
                onSave={handleSave}
                onCancel={() => setIsCreating(false)}
              />
            </div>
          )}

          {editingId && (
            <div className="mb-6 p-4 border border-border rounded-lg bg-muted/30">
              <h3 className="text-sm font-semibold mb-4">{tSettings('edit')}</h3>
              <TemplateForm
                template={templates.find((t) => t.id === editingId)}
                onSave={handleSave}
                onCancel={() => setEditingId(null)}
              />
            </div>
          )}

          <div className="space-y-2">
            {filtered.map((template) => (
              <div
                key={template.id}
                className="flex items-center gap-3 p-3 rounded-md border border-border hover:bg-muted/50 transition-colors"
              >
                <button
                  type="button"
                  onClick={() => toggleFavorite(template.id)}
                  className="flex-shrink-0"
                >
                  <Star
                    className={cn(
                      'w-4 h-4 transition-colors',
                      template.isFavorite
                        ? 'fill-amber-400 text-amber-400'
                        : 'text-muted-foreground hover:text-amber-400'
                    )}
                  />
                </button>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground truncate">
                      {template.name}
                    </p>
                    {template.category && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium flex-shrink-0">
                        {template.category}
                      </span>
                    )}
                  </div>
                  {template.subject && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {template.subject}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { setEditingId(template.id); setIsCreating(false); }}
                    disabled={!!editingId || isCreating}
                    className="h-8 w-8 p-0"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => duplicateTemplate(template.id, t('copy_suffix'))}
                    disabled={!!editingId || isCreating}
                    className="h-8 w-8 p-0"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </Button>
                  {deleteConfirmId === template.id ? (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDelete(template.id)}
                        className="h-7 text-xs"
                      >
                        {tSettings('confirm_delete')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteConfirmId(null)}
                        className="h-7 text-xs"
                      >
                        {tSettings('cancel')}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteConfirmId(template.id)}
                      disabled={!!editingId || isCreating}
                      className="h-8 w-8 p-0 hover:text-red-600 dark:hover:text-red-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}

            {filtered.length === 0 && !isCreating && (
              <div className="flex flex-col items-center py-8 text-muted-foreground">
                <FileText className="w-10 h-10 mb-3 opacity-40" />
                <p className="text-sm">
                  {searchQuery ? t('no_results') : tSettings('no_templates')}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
