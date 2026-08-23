import { apiFetch } from '@/lib/browser-navigation';
import type { SignatureAssetMeta } from '@/lib/signature-asset-constants';

export type { SignatureAssetMeta };

function identityHeaders(username: string, serverUrl: string): HeadersInit {
  return {
    'x-settings-username': username,
    'x-settings-server': serverUrl,
  };
}

export async function listSignatureAssetsClient(
  username: string,
  serverUrl: string,
  identityId: string,
): Promise<SignatureAssetMeta[]> {
  const res = await apiFetch(
    `/api/signatures/assets?identityId=${encodeURIComponent(identityId)}`,
    { headers: identityHeaders(username, serverUrl) },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to list signature images (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data.assets) ? data.assets : [];
}

export async function uploadSignatureAssetClient(
  username: string,
  serverUrl: string,
  identityId: string,
  file: File,
): Promise<SignatureAssetMeta> {
  const form = new FormData();
  form.set('identityId', identityId);
  form.set('file', file);
  const res = await apiFetch('/api/signatures/assets', {
    method: 'POST',
    headers: identityHeaders(username, serverUrl),
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to upload signature image (${res.status})`);
  }
  const data = await res.json();
  if (!data.asset?.id) throw new Error('Invalid upload response');
  return data.asset;
}

export async function fetchSignatureAssetBlob(
  username: string,
  serverUrl: string,
  assetId: string,
): Promise<Blob> {
  const res = await apiFetch(`/api/signatures/assets/${encodeURIComponent(assetId)}`, {
    headers: identityHeaders(username, serverUrl),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to load signature image (${res.status})`);
  }
  return res.blob();
}

export async function deleteSignatureAssetClient(
  username: string,
  serverUrl: string,
  assetId: string,
): Promise<void> {
  const res = await apiFetch(`/api/signatures/assets/${encodeURIComponent(assetId)}`, {
    method: 'DELETE',
    headers: identityHeaders(username, serverUrl),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to delete signature image (${res.status})`);
  }
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
    reader.readAsDataURL(blob);
  });
}
