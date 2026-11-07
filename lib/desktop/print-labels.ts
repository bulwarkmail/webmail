/**
 * The desktop print preview's text in the interface language, by its keys in the shell's
 * src/main/strings.ts. `{count}` goes through as it is: the shell fills it in. It goes out
 * with the rest of the labels in shellLabels (languages.ts).
 */
export function printLabels(t: (key: string, values?: Record<string, string>) => string): Record<string, string> {
  const keep = { count: '{count}' };
  return {
    printTitle: t('desktopPrint.title'),
    printPagesOne: t('desktopPrint.pages_one'),
    printPagesMany: t('desktopPrint.pages_many', keep),
    printPreparing: t('desktopPrint.preparing'),
    printPreviewFailed: t('desktopPrint.preview_failed'),
    printPreviewLabel: t('desktopPrint.preview_label'),
    printDestination: t('desktopPrint.destination'),
    printSaveAsPdf: t('desktopPrint.save_as_pdf'),
    printPages: t('desktopPrint.pages'),
    printPagesAll: t('desktopPrint.pages_all'),
    printPagesCustom: t('desktopPrint.pages_custom'),
    printPagesExample: t('desktopPrint.pages_example'),
    printPagesInvalid: t('desktopPrint.pages_invalid', keep),
    printCopies: t('desktopPrint.copies'),
    printLayout: t('desktopPrint.layout'),
    printPortrait: t('desktopPrint.portrait'),
    printLandscape: t('desktopPrint.landscape'),
    printColor: t('desktopPrint.color'),
    printColorColor: t('desktopPrint.color_color'),
    printColorMono: t('desktopPrint.color_mono'),
    printMore: t('desktopPrint.more'),
    printPaper: t('desktopPrint.paper'),
    printPaperPrinter: t('desktopPrint.paper_printer'),
    printMargins: t('desktopPrint.margins'),
    printMarginsDefault: t('desktopPrint.margins_default'),
    printMarginsNone: t('desktopPrint.margins_none'),
    printMarginsMinimum: t('desktopPrint.margins_minimum'),
    printScale: t('desktopPrint.scale'),
    printOptions: t('desktopPrint.options'),
    printHeaderFooter: t('desktopPrint.header_footer'),
    printBackground: t('desktopPrint.background'),
    printPrint: t('desktopPrint.print'),
    printSave: t('desktopPrint.save'),
    printCancel: t('desktopPrint.cancel'),
    printSystemDialog: t('desktopPrint.system_dialog'),
    printFailedTitle: t('desktopPrint.failed_title'),
    printFailedDetail: t('desktopPrint.failed_detail'),
  };
}
