// The kit's own accessible names ("Clear", "Remove …"). The kit runs in the
// plugin iframe, which has no copy of the app's catalog, so its few strings
// live here, one table per app locale. kit-strings.test.ts checks that every
// locale in locales/ has every key.

type KitKey = 'remove' | 'remove_named' | 'clear' | 'clear_search' | 'open' | 'close';

export const KIT_STRINGS: Record<string, Record<KitKey, string>> = {
  en: { remove: 'Remove', remove_named: 'Remove {name}', clear: 'Clear', clear_search: 'Clear search', open: 'Open list', close: 'Close list' },
  de: { remove: 'Entfernen', remove_named: '{name} entfernen', clear: 'Leeren', clear_search: 'Suche leeren', open: 'Liste öffnen', close: 'Liste schließen' },
  el: { remove: 'Αφαίρεση', remove_named: 'Αφαίρεση {name}', clear: 'Εκκαθάριση', clear_search: 'Εκκαθάριση αναζήτησης', open: 'Άνοιγμα λίστας', close: 'Κλείσιμο λίστας' },
  ar: { remove: 'إزالة', remove_named: 'إزالة {name}', clear: 'مسح', clear_search: 'مسح البحث', open: 'فتح القائمة', close: 'إغلاق القائمة' },
  ca: { remove: 'Treu', remove_named: 'Treu {name}', clear: 'Esborra', clear_search: 'Esborra la cerca', open: 'Obre la llista', close: 'Tanca la llista' },
  cs: { remove: 'Odebrat', remove_named: 'Odebrat {name}', clear: 'Vymazat', clear_search: 'Vymazat hledání', open: 'Otevřít seznam', close: 'Zavřít seznam' },
  da: { remove: 'Fjern', remove_named: 'Fjern {name}', clear: 'Ryd', clear_search: 'Ryd søgning', open: 'Åbn liste', close: 'Luk liste' },
  es: { remove: 'Quitar', remove_named: 'Quitar {name}', clear: 'Borrar', clear_search: 'Borrar búsqueda', open: 'Abrir lista', close: 'Cerrar lista' },
  et: { remove: 'Eemalda', remove_named: 'Eemalda {name}', clear: 'Tühjenda', clear_search: 'Tühjenda otsing', open: 'Ava loend', close: 'Sulge loend' },
  fa: { remove: 'حذف', remove_named: 'حذف {name}', clear: 'پاک کردن', clear_search: 'پاک کردن جستجو', open: 'باز کردن فهرست', close: 'بستن فهرست' },
  fr: { remove: 'Retirer', remove_named: 'Retirer {name}', clear: 'Effacer', clear_search: 'Effacer la recherche', open: 'Ouvrir la liste', close: 'Fermer la liste' },
  he: { remove: 'הסרה', remove_named: 'הסרת {name}', clear: 'ניקוי', clear_search: 'ניקוי החיפוש', open: 'פתיחת הרשימה', close: 'סגירת הרשימה' },
  hu: { remove: 'Eltávolítás', remove_named: '{name} eltávolítása', clear: 'Törlés', clear_search: 'Keresés törlése', open: 'Lista megnyitása', close: 'Lista bezárása' },
  it: { remove: 'Rimuovi', remove_named: 'Rimuovi {name}', clear: 'Cancella', clear_search: 'Cancella la ricerca', open: 'Apri elenco', close: 'Chiudi elenco' },
  ja: { remove: '削除', remove_named: '{name} を削除', clear: 'クリア', clear_search: '検索をクリア', open: '一覧を開く', close: '一覧を閉じる' },
  ko: { remove: '삭제', remove_named: '{name} 삭제', clear: '지우기', clear_search: '검색 지우기', open: '목록 열기', close: '목록 닫기' },
  lv: { remove: 'Noņemt', remove_named: 'Noņemt {name}', clear: 'Notīrīt', clear_search: 'Notīrīt meklēšanu', open: 'Atvērt sarakstu', close: 'Aizvērt sarakstu' },
  mn: { remove: 'Хасах', remove_named: '{name}-г хасах', clear: 'Цэвэрлэх', clear_search: 'Хайлтыг цэвэрлэх', open: 'Жагсаалт нээх', close: 'Жагсаалт хаах' },
  nb: { remove: 'Fjern', remove_named: 'Fjern {name}', clear: 'Tøm', clear_search: 'Tøm søket', open: 'Åpne listen', close: 'Lukk listen' },
  nl: { remove: 'Verwijderen', remove_named: '{name} verwijderen', clear: 'Wissen', clear_search: 'Zoekopdracht wissen', open: 'Lijst openen', close: 'Lijst sluiten' },
  pl: { remove: 'Usuń', remove_named: 'Usuń {name}', clear: 'Wyczyść', clear_search: 'Wyczyść wyszukiwanie', open: 'Otwórz listę', close: 'Zamknij listę' },
  pt: { remove: 'Remover', remove_named: 'Remover {name}', clear: 'Limpar', clear_search: 'Limpar pesquisa', open: 'Abrir lista', close: 'Fechar lista' },
  ro: { remove: 'Elimină', remove_named: 'Elimină {name}', clear: 'Golește', clear_search: 'Golește căutarea', open: 'Deschide lista', close: 'Închide lista' },
  ru: { remove: 'Удалить', remove_named: 'Удалить {name}', clear: 'Очистить', clear_search: 'Очистить поиск', open: 'Открыть список', close: 'Закрыть список' },
  sk: { remove: 'Odstrániť', remove_named: 'Odstrániť {name}', clear: 'Vymazať', clear_search: 'Vymazať hľadanie', open: 'Otvoriť zoznam', close: 'Zavrieť zoznam' },
  th: { remove: 'นำออก', remove_named: 'นำ {name} ออก', clear: 'ล้าง', clear_search: 'ล้างการค้นหา', open: 'เปิดรายการ', close: 'ปิดรายการ' },
  tr: { remove: 'Kaldır', remove_named: '{name} öğesini kaldır', clear: 'Temizle', clear_search: 'Aramayı temizle', open: 'Listeyi aç', close: 'Listeyi kapat' },
  uk: { remove: 'Вилучити', remove_named: 'Вилучити {name}', clear: 'Очистити', clear_search: 'Очистити пошук', open: 'Відкрити список', close: 'Закрити список' },
  vi: { remove: 'Xóa', remove_named: 'Xóa {name}', clear: 'Xóa hết', clear_search: 'Xóa tìm kiếm', open: 'Mở danh sách', close: 'Đóng danh sách' },
  zh: { remove: '移除', remove_named: '移除 {name}', clear: '清除', clear_search: '清除搜索', open: '打开列表', close: '关闭列表' },
  'zh-TW': { remove: '移除', remove_named: '移除 {name}', clear: '清除', clear_search: '清除搜尋', open: '開啟清單', close: '關閉清單' },
};

/** The app language the runtime set (applyLocale in runtime.tsx), else English. */
function kitLocale(): string {
  return (globalThis as unknown as { __PLUGIN_LOCALE__?: string }).__PLUGIN_LOCALE__ || 'en';
}

/** A kit string in the app's language: the exact locale, then its language, then English. */
export function kitString(key: KitKey, vars: Record<string, string> = {}): string {
  const locale = kitLocale();
  const table = KIT_STRINGS[locale] ?? KIT_STRINGS[locale.split('-')[0]] ?? KIT_STRINGS.en;
  return (table[key] ?? KIT_STRINGS.en[key]).replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m);
}
