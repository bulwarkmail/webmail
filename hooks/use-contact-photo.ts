"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { useAuthStore } from "@/stores/auth-store";
import { getClientByLocalAccountId } from "@/stores/client-registry";
import type { ContactPhotoRef } from "@/stores/contact-store";
import {
  contactPhotoConcurrency,
  contactPhotoKey,
  peekContactPhoto,
  requestContactPhoto,
  subscribeContactPhotos,
} from "@/lib/contact-photo-cache";

/**
 * The client that downloads blobs of a card: the one of the card's login in
 * multi-account mode, else the active one. Null when that login has no
 * client (signed out, not connected yet): the active client would ask another
 * server, and its refusal would stick to the photo as a failure.
 */
export function getContactPhotoClient(localAccountId?: string): IJMAPClient | null {
  if (localAccountId) return getClientByLocalAccountId(localAccountId) ?? null;
  return useAuthStore.getState().client;
}

const visibilityCallbacks = new Map<Element, (visible: boolean) => void>();
let sharedObserver: IntersectionObserver | null = null;

/** Reports whether the element is on or near the screen; one observer serves every avatar. */
function observeVisibility(element: Element, onChange: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onChange(true);
    return () => {};
  }
  sharedObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) visibilityCallbacks.get(entry.target)?.(entry.isIntersecting);
  }, { rootMargin: "200px" });
  visibilityCallbacks.set(element, onChange);
  sharedObserver.observe(element);
  return () => {
    visibilityCallbacks.delete(element);
    sharedObserver?.unobserve(element);
  };
}

/**
 * The src to show for a contact photo. A URI is used as it is. A blob is
 * downloaded through the photo cache once the element passed to `observe` is
 * on screen, since the contacts list renders every row; until then, and if
 * the download fails, `src` is undefined.
 */
export function useContactPhotoSrc(photo: ContactPhotoRef | null | undefined): {
  src: string | undefined;
  observe: (element: Element | null) => void;
} {
  const blob = photo && "blobId" in photo ? photo : undefined;
  const key = blob ? contactPhotoKey(blob.localAccountId, blob.blobId) : undefined;
  const blobUrl = useSyncExternalStore(
    subscribeContactPhotos,
    () => (key ? peekContactPhoto(key) : undefined),
    () => undefined,
  );
  // Asks again once a client comes along (sign-in, account switch).
  const activeClient = useAuthStore((s) => s.client);
  const [element, setElement] = useState<Element | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!key || !element) return;
    return observeVisibility(element, setVisible);
  }, [key, element]);

  const blobId = blob?.blobId;
  const mediaType = blob?.mediaType;
  const accountId = blob?.accountId;
  const localAccountId = blob?.localAccountId;
  useEffect(() => {
    if (!key || !blobId || !visible) return;
    const client = getContactPhotoClient(localAccountId);
    if (!client) return;
    // Also re-runs when the cached copy goes (evicted, cache cleared) while
    // the avatar is still on screen.
    return requestContactPhoto(key, async () => {
      const current = getContactPhotoClient(localAccountId);
      return current ? current.fetchBlob(blobId, "photo", mediaType, accountId) : null;
    }, { concurrency: contactPhotoConcurrency(client.getMaxConcurrentRequests?.()) });
  }, [key, blobId, mediaType, accountId, localAccountId, visible, blobUrl, activeClient]);

  // Only a photo still to download needs its element. Taking every element
  // into state drew each avatar a second time right after it mounted, for
  // every row of every list, though most have nothing to download. A new key
  // makes a new callback, which React calls again with the element.
  const observe = useCallback((next: Element | null) => {
    if (key) setElement(next);
  }, [key]);

  return { src: photo && "uri" in photo ? photo.uri : blobUrl, observe };
}
