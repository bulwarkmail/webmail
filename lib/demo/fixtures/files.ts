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

    // Photos contents
    {
      id: 'demo-file-vacation',
      parentId: 'demo-file-photos',
      name: 'vacation.jpg',
      type: 'image/jpeg',
      blobId: 'demo-blob-file-4',
      size: 1258291,
      created: demoDate(-10),
      modified: demoDate(-10),
    },
    {
      id: 'demo-file-team-photo',
      parentId: 'demo-file-photos',
      name: 'team-photo.png',
      type: 'image/png',
      blobId: 'demo-blob-file-5',
      size: 911360,
      created: demoDate(-21),
      modified: demoDate(-21),
    },

    // Root-level file
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
  ];
}
