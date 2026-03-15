/**
 * WebDAV client that proxies through /api/webdav to avoid CORS issues.
 * The server-side proxy handles auth and forwards requests to Stalwart's /dav/file/ endpoint.
 */

export interface WebDAVResource {
  href: string;
  name: string;
  isDirectory: boolean;
  contentType: string;
  contentLength: number;
  lastModified: string;
  etag: string;
}

export class WebDAVClient {
  private proxyUrl = '/api/webdav';

  /**
   * Send a WebDAV request through the proxy.
   */
  private async request(method: string, path: string, options?: {
    headers?: Record<string, string>;
    body?: string | ArrayBuffer | Blob;
  }): Promise<Response> {
    const headers: Record<string, string> = {
      'X-WebDAV-Method': method,
      'X-WebDAV-Path': path,
      ...options?.headers,
    };

    return fetch(this.proxyUrl, {
      method: 'POST',
      headers,
      body: options?.body,
    });
  }

  /**
   * Check if WebDAV is available by sending a PROPFIND to the root.
   */
  async checkSupport(): Promise<boolean> {
    try {
      const response = await this.request('PROPFIND', '/', {
        headers: {
          'Depth': '0',
          'Content-Type': 'application/xml; charset=utf-8',
        },
        body: `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
  </D:prop>
</D:propfind>`,
      });
      return response.status === 207;
    } catch {
      return false;
    }
  }

  /**
   * List contents of a directory via PROPFIND with Depth: 1
   */
  async list(path: string = '/'): Promise<WebDAVResource[]> {
    const response = await this.request('PROPFIND', path, {
      headers: {
        'Depth': '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:resourcetype/>
    <D:getcontenttype/>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:getetag/>
    <D:displayname/>
  </D:prop>
</D:propfind>`,
    });

    if (response.status !== 207) {
      throw new Error(`PROPFIND failed: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    const requestUri = response.headers.get('X-WebDAV-Request-URI') || '';
    return this.parseMultistatus(text, requestUri);
  }

  /**
   * Create a new directory
   */
  async createDirectory(path: string): Promise<void> {
    const response = await this.request('MKCOL', path);

    if (response.status !== 201 && response.status !== 204) {
      throw new Error(`MKCOL failed: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Upload a file with optional progress tracking
   */
  async uploadFile(
    path: string,
    file: File | Blob,
    contentType?: string,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (onProgress) {
      // Use XMLHttpRequest for progress tracking
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', this.proxyUrl);
        xhr.setRequestHeader('X-WebDAV-Method', 'PUT');
        xhr.setRequestHeader('X-WebDAV-Path', path);
        xhr.setRequestHeader('Content-Type',
          contentType || (file instanceof File ? file.type : 'application/octet-stream'));

        if (signal) {
          signal.addEventListener('abort', () => {
            xhr.abort();
            reject(new DOMException('Upload aborted', 'AbortError'));
          });
        }

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded, e.total);
        };
        xhr.onload = () => {
          if (xhr.status === 200 || xhr.status === 201 || xhr.status === 204) {
            resolve();
          } else {
            reject(new Error(`PUT failed: ${xhr.status} ${xhr.statusText}`));
          }
        };
        xhr.onerror = () => reject(new Error('Upload failed'));
        xhr.send(file);
      });
    }

    const response = await this.request('PUT', path, {
      headers: {
        'Content-Type': contentType || (file instanceof File ? file.type : 'application/octet-stream'),
      },
      body: file,
    });

    if (response.status !== 201 && response.status !== 204 && response.status !== 200) {
      throw new Error(`PUT failed: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Download a file
   */
  async downloadFile(path: string): Promise<{ blob: Blob; contentType: string; filename: string }> {
    const response = await this.request('GET', path);

    if (!response.ok) {
      throw new Error(`GET failed: ${response.status} ${response.statusText}`);
    }

    const blob = await response.blob();
    const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
    const filename = path.split('/').pop() || 'download';

    return { blob, contentType, filename };
  }

  /**
   * Delete a file or directory
   */
  async delete(path: string): Promise<void> {
    const response = await this.request('DELETE', path);

    if (response.status !== 204 && response.status !== 200) {
      throw new Error(`DELETE failed: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Move/rename a resource
   */
  async move(fromPath: string, toPath: string): Promise<void> {
    const response = await this.request('MOVE', fromPath, {
      headers: {
        'X-WebDAV-Destination': toPath,
        'Overwrite': 'F',
      },
    });

    if (response.status !== 201 && response.status !== 204) {
      throw new Error(`MOVE failed: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Copy a resource
   */
  async copy(fromPath: string, toPath: string): Promise<void> {
    const response = await this.request('COPY', fromPath, {
      headers: {
        'X-WebDAV-Destination': toPath,
        'Overwrite': 'F',
      },
    });

    if (response.status !== 201 && response.status !== 204) {
      throw new Error(`COPY failed: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Parse a WebDAV multistatus XML response into WebDAVResource[]
   */
  private parseMultistatus(xml: string, requestUrl: string): WebDAVResource[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    const responses = doc.getElementsByTagNameNS('DAV:', 'response');
    const resources: WebDAVResource[] = [];

    // Normalize the request URL for comparison (skip the "self" entry)
    const normalizedRequestUrl = requestUrl.replace(/\/+$/, '');

    for (let i = 0; i < responses.length; i++) {
      const resp = responses[i];

      const hrefEl = resp.getElementsByTagNameNS('DAV:', 'href')[0];
      if (!hrefEl?.textContent) continue;

      const href = decodeURIComponent(hrefEl.textContent);

      // Skip the directory itself (the parent being listed)
      const normalizedHref = href.replace(/\/+$/, '');
      if (this.isSameResource(normalizedHref, normalizedRequestUrl)) continue;

      const propstat = resp.getElementsByTagNameNS('DAV:', 'propstat')[0];
      if (!propstat) continue;

      const statusEl = propstat.getElementsByTagNameNS('DAV:', 'status')[0];
      if (statusEl?.textContent && !statusEl.textContent.includes('200')) continue;

      const prop = propstat.getElementsByTagNameNS('DAV:', 'prop')[0];
      if (!prop) continue;

      const resourceType = prop.getElementsByTagNameNS('DAV:', 'resourcetype')[0];
      const isDirectory = !!resourceType?.getElementsByTagNameNS('DAV:', 'collection')[0];

      const displayName = prop.getElementsByTagNameNS('DAV:', 'displayname')[0]?.textContent || '';
      const contentType = prop.getElementsByTagNameNS('DAV:', 'getcontenttype')[0]?.textContent || '';
      const contentLengthStr = prop.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent || '0';
      const lastModified = prop.getElementsByTagNameNS('DAV:', 'getlastmodified')[0]?.textContent || '';
      const etag = prop.getElementsByTagNameNS('DAV:', 'getetag')[0]?.textContent || '';

      // Extract the name from the href path
      const segments = href.replace(/\/+$/, '').split('/');
      const name = displayName || segments[segments.length - 1] || '';

      resources.push({
        href,
        name,
        isDirectory,
        contentType: isDirectory ? '' : contentType,
        contentLength: parseInt(contentLengthStr, 10) || 0,
        lastModified,
        etag,
      });
    }

    // Sort: directories first, then alphabetically
    resources.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return resources;
  }

  private isSameResource(href1: string, href2: string): boolean {
    // Compare by path only (ignore origin differences)
    try {
      const path1 = new URL(href1, 'http://dummy').pathname.replace(/\/+$/, '');
      const path2 = new URL(href2, 'http://dummy').pathname.replace(/\/+$/, '');
      return path1 === path2;
    } catch {
      return href1 === href2;
    }
  }
}
