import type { FileNode } from '@/lib/jmap/types';
import { demoDate } from '../demo-utils';

export function createDemoFileNodes(): FileNode[] {
  return [
    // Root-level directories
    {
      id: 'demo-file-documents',
      parentId: null,
      name: 'Documents',
      type: 'd',
      blobId: null,
      size: 0,
      created: demoDate(-30),
      modified: demoDate(-2),
    },
    {
      id: 'demo-file-photos',
      parentId: null,
      name: 'Photos',
      type: 'd',
      blobId: null,
      size: 0,
      created: demoDate(-30),
      modified: demoDate(-5),
    },

    // Documents contents
    {
      id: 'demo-file-meeting-notes',
      parentId: 'demo-file-documents',
      name: 'meeting-notes.md',
      type: 'text/markdown',
      blobId: 'demo-blob-file-1',
      size: 2150,
      created: demoDate(-7),
      modified: demoDate(-2),
    },
    {
      id: 'demo-file-quarterly-report',
      parentId: 'demo-file-documents',
      name: 'quarterly-report.pdf',
      type: 'application/pdf',
      blobId: 'demo-blob-file-2',
      size: 148480,
      created: demoDate(-14),
      modified: demoDate(-14),
    },
    {
      id: 'demo-file-todo',
      parentId: 'demo-file-documents',
      name: 'todo.txt',
      type: 'text/plain',
      blobId: 'demo-blob-file-3',
      size: 410,
      created: demoDate(-3),
      modified: demoDate(-1),
    },

    // Office documents (openable in a WOPI editor when one is configured, #425)
    {
      id: 'demo-file-project-proposal',
      parentId: 'demo-file-documents',
      name: 'project-proposal.odt',
      type: 'application/vnd.oasis.opendocument.text',
      blobId: 'demo-blob-file-7',
      size: 24576,
      created: demoDate(-12),
      modified: demoDate(-4),
    },
    {
      id: 'demo-file-contract-draft',
      parentId: 'demo-file-documents',
      name: 'contract-draft.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      blobId: 'demo-blob-file-8',
      size: 38912,
      created: demoDate(-9),
      modified: demoDate(-2),
    },
    {
      id: 'demo-file-team-timesheet',
      parentId: 'demo-file-documents',
      name: 'team-timesheet.ods',
      type: 'application/vnd.oasis.opendocument.spreadsheet',
      blobId: 'demo-blob-file-9',
      size: 17408,
      created: demoDate(-6),
      modified: demoDate(-1),
    },
    {
      id: 'demo-file-roadmap-presentation',
      parentId: 'demo-file-documents',
      name: 'roadmap-presentation.odp',
      type: 'application/vnd.oasis.opendocument.presentation',
      blobId: 'demo-blob-file-10',
      size: 245760,
      created: demoDate(-16),
      modified: demoDate(-8),
    },

    // Photos contents
    {
      id: 'demo-file-vacation',
      parentId: 'demo-file-photos',
      name: 'vacation.jpg',
      type: 'image/jpeg',
      blobId: 'demo-blob-file-4',
      size: 91949,
      created: demoDate(-10),
      modified: demoDate(-10),
    },
    {
      id: 'demo-file-team-photo',
      parentId: 'demo-file-photos',
      name: 'team-photo.jpg',
      type: 'image/jpeg',
      blobId: 'demo-blob-file-5',
      size: 71066,
      created: demoDate(-21),
      modified: demoDate(-21),
    },

    // Root-level files
    {
      id: 'demo-file-budget',
      parentId: null,
      name: 'budget.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      blobId: 'demo-blob-file-6',
      size: 68608,
      created: demoDate(-5),
      modified: demoDate(-1),
    },
    {
      id: 'demo-file-launch-deck',
      parentId: null,
      name: 'product-launch.pptx',
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      blobId: 'demo-blob-file-11',
      size: 512000,
      created: demoDate(-4),
      modified: demoDate(-3),
    },
  ];
}
