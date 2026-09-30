// IndexedDB storage for plugin/theme binary blobs (JS bundles, CSS, previews)

const DB_NAME = 'bulwark-plugins';
// Bumped to 3 to add the file-plugin store; existing stores are preserved.
const DB_VERSION = 3;
const STORE_PLUGINS = 'plugin-code';
const STORE_THEMES = 'theme-css';
const STORE_THEME_SKINS = 'theme-skin';
const STORE_PREVIEWS = 'previews';
const STORE_FILE_ACCESS_PLUGIN = 'file-plugin'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PLUGINS)) {
        db.createObjectStore(STORE_PLUGINS);
      }
      if (!db.objectStoreNames.contains(STORE_THEMES)) {
        db.createObjectStore(STORE_THEMES);
      }
      if (!db.objectStoreNames.contains(STORE_THEME_SKINS)) {
        db.createObjectStore(STORE_THEME_SKINS);
      }
      if (!db.objectStoreNames.contains(STORE_PREVIEWS)) {
        db.createObjectStore(STORE_PREVIEWS);
      }
      if (!db.objectStoreNames.contains(STORE_FILE_ACCESS_PLUGIN)) {
        db.createObjectStore(STORE_FILE_ACCESS_PLUGIN);
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Another tab bumping DB_VERSION needs every older connection gone
      // before its upgrade can run; close ours instead of blocking it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    // Without this the open request never settles while an older tab keeps
    // the previous version open, and every caller (attachment upload, plugin
    // loading) hangs silently. (#840)
    request.onblocked = () =>
      reject(
        new Error(
          'Plugin storage database is blocked by another open tab. Close other Bulwark tabs and try again.',
        ),
      );
  });
}

async function putItem(storeName: string, key: string, value: string | Blob | File): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function getItem<T = string>(storeName: string, key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

async function deleteItem(storeName: string, key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function clearItems(storeName: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// ─── Public API ──────────────────────────────────────────────

export const pluginStorage = {
  // Plugin JS bundles
  async saveCode(pluginId: string, code: string): Promise<void> {
    await putItem(STORE_PLUGINS, pluginId, code);
  },
  async getCode(pluginId: string): Promise<string | null> {
    return getItem<string>(STORE_PLUGINS, pluginId);
  },
  async deleteCode(pluginId: string): Promise<void> {
    await deleteItem(STORE_PLUGINS, pluginId);
  },

  // Theme CSS blobs
  async saveThemeCSS(themeId: string, css: string): Promise<void> {
    await putItem(STORE_THEMES, themeId, css);
  },
  async getThemeCSS(themeId: string): Promise<string | null> {
    return getItem<string>(STORE_THEMES, themeId);
  },
  async deleteThemeCSS(themeId: string): Promise<void> {
    await deleteItem(STORE_THEMES, themeId);
  },

  // Theme skin CSS - separate store so it can be present/absent independently
  // of the colour-token CSS (e.g. some v2 themes ship colours only).
  async saveThemeSkin(themeId: string, skin: string): Promise<void> {
    await putItem(STORE_THEME_SKINS, themeId, skin);
  },
  async getThemeSkin(themeId: string): Promise<string | null> {
    return getItem<string>(STORE_THEME_SKINS, themeId);
  },
  async deleteThemeSkin(themeId: string): Promise<void> {
    await deleteItem(STORE_THEME_SKINS, themeId);
  },

  // Preview images (stored as data URIs)
  async savePreview(id: string, dataUri: string): Promise<void> {
    await putItem(STORE_PREVIEWS, id, dataUri);
  },
  async getPreview(id: string): Promise<string | null> {
    return getItem<string>(STORE_PREVIEWS, id);
  },
  async deletePreview(id: string): Promise<void> {
    await deleteItem(STORE_PREVIEWS, id);
  },
};

/**
 * Used in host-api for plugins to access to raw data files
 * to modify them before they are uploaded.
 */
export const fileStorage = {
      async saveFile(fileId: string, file: File): Promise<void> {
    await putItem(STORE_FILE_ACCESS_PLUGIN, fileId, file);
  },
  async getFile(fileId: string): Promise<File | null> {
    return getItem<File>(STORE_FILE_ACCESS_PLUGIN, fileId);
  },
  async deleteFile(fileId: string): Promise<void> {
    await deleteItem(STORE_FILE_ACCESS_PLUGIN, fileId);
  },
  /** Drop every staged file, e.g. on sign-out. */
  async clearFiles(): Promise<void> {
    await clearItems(STORE_FILE_ACCESS_PLUGIN);
  },
}