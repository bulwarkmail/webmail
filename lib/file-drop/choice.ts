/**
 * The overlay's choices without a drag: for files pasted outside a text field, and for a
 * file opened with the desktop app ("Open with" in Explorer, Finder or a file manager).
 * The host shows them as a dialog that works from the keyboard. Requests wait for the
 * host to mount, and the host waits for a sign-in.
 */

import type { FileDropZoneId } from './zones';

export interface FileChoiceRequest {
  files: File[];
  /** Where the focus starts, if that choice is there. */
  preferred?: FileDropZoneId;
}

type Listener = (request: FileChoiceRequest) => void;

let listener: Listener | null = null;
const waiting: FileChoiceRequest[] = [];

export function requestFileChoice(request: FileChoiceRequest): void {
  if (request.files.length === 0) return;
  if (listener) listener(request);
  else waiting.push(request);
}

/** One host at a time. What came before it mounted is handed over at once. */
export function listenForFileChoices(next: Listener): () => void {
  listener = next;
  for (const request of waiting.splice(0)) next(request);
  return () => {
    if (listener === next) listener = null;
  };
}

