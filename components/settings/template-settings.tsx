'use client';

import { useState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { SettingsSection } from './settings-section';
import { Button } from '@/components/ui/button';
import { TemplateManagerModal } from '@/components/templates/template-manager-modal';
import { useTemplateStore } from '@/stores/template-store';
import { toast } from '@/stores/toast-store';
import { debug } from '@/lib/debug';
import {
  FileText,
  Download,
  Upload,
} from 'lucide-react';

const MAX_IMPORT_FILE_SIZE = 1 * 1024 * 1024;

export function TemplateSettings() {
  const t = useTranslations('settings.templates');
  const tNotif = useTranslations('notifications');

  const { templates, exportAllTemplates, importTemplates: storeImport } = useTemplateStore();

  const [showManager, setShowManager] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    const json = exportAllTemplates();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'email-templates.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success(tNotif('templates_exported'));
  };

  const resetFileInput = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_IMPORT_FILE_SIZE) {
      toast.error(tNotif('templates_import_errors'));
      resetFileInput();
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      const result = storeImport(content);

      if (result.errors.length > 0) {
        toast.error(tNotif('templates_import_errors'));
      } else if (result.count > 0) {
        toast.success(tNotif('templates_imported', { count: result.count }));
      } else {
        toast.error(tNotif('templates_import_empty'));
      }

      resetFileInput();
    };
    reader.onerror = () => {
      debug.error('FileReader error during template import:', reader.error);
      toast.error(tNotif('templates_import_errors'));
      resetFileInput();
    };
    reader.readAsText(file);
  };

  return (
    <div className="space-y-6">
      <SettingsSection title={t('title')} description={t('description')}>
        <div className="flex items-center justify-between py-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <FileText className="w-4 h-4" />
            <span>
              {t('count', { count: templates.length })}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowManager(true)}
          >
            {t('manage')}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title={t('export_import')} description={t('export_import_description')}>
        <div className="flex items-center gap-3 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={templates.length === 0}
          >
            <Download className="w-4 h-4 me-1" />
            {t('export')}
          </Button>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleImport}
              className="hidden"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="w-4 h-4 me-1" />
              {t('import')}
            </Button>
          </div>
        </div>
      </SettingsSection>

      {showManager && (
        <TemplateManagerModal
          isOpen={showManager}
          onClose={() => setShowManager(false)}
        />
      )}
    </div>
  );
}
