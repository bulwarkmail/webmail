'use client';

import dynamic from 'next/dynamic';
import { useSaveAsTemplateStore } from '@/stores/save-as-template-store';

// The template editor (TipTap) loads when a message is saved as a template, not with every page.
const SaveAsTemplateFlow = dynamic(() => import('./save-as-template-flow').then((m) => m.SaveAsTemplateFlow), { ssr: false });

/** Mounted once in the app layout; menus ask through useSaveAsTemplateStore. */
export function SaveAsTemplateHost() {
  const pending = useSaveAsTemplateStore((s) => s.pending);
  if (!pending) return null;
  return <SaveAsTemplateFlow key={pending.request} email={pending.email} />;
}
