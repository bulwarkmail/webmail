import type { ProAppTabKind } from "@/stores/pro-tab-store";

export interface TourStep {
  id: string;
  target: string;
  titleKey: string;
  descriptionKey: string;
  /** The text on a phone, where the layout it describes ("on the right") isn't there. */
  phoneDescriptionKey?: string;
  placement: "top" | "bottom" | "left" | "right";
  interactive?: boolean;
  spotlight?: "rect" | "circle";
  /** The app the step is in; none means Mail. */
  page?: string;
  /**
   * "reader": the step is in Mail's reading pane, which on a phone covers the
   * list and the tab bar. Every other Mail step closes the reader there.
   */
  view?: "reader";
  /** false: the target only exists in the rail or the folder drawer, so a phone never shows it. */
  phone?: false;
  demoOnly?: boolean;
  beforeAction?: () => void;
}

/**
 * The first element for the selector that the user can see: not in a closed
 * drawer (inert), with a size, on screen sideways and not covered by
 * something else (the open message over the phone's tab bar). The same anchor
 * can exist twice (the rail and the phone's tab bar).
 */
export function findTourTarget(selector: string): Element | null {
  for (const el of document.querySelectorAll(selector)) {
    if (el.closest("[inert]")) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right <= 0 || r.left >= window.innerWidth) continue;
    if (isCovered(el, r)) continue;
    return el;
  }
  return null;
}

/** Whether the middle of an on-screen element is under another element (the tour's own layers aside). */
function isCovered(el: Element, r: DOMRect): boolean {
  if (typeof document.elementsFromPoint !== "function") return false;
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  // Below or above the fold: scrolled into view before it is shown.
  if (y < 0 || y > window.innerHeight || x < 0 || x > window.innerWidth) return false;
  const top = document.elementsFromPoint(x, y).find((hit) => !hit.closest("[data-tour-layer]"));
  return !!top && top !== el && !el.contains(top) && !top.contains(el);
}

/** The Pro tab that holds the app the step is about. */
export function proTabOfTourStep(step: Pick<TourStep, "page" | "target">): ProAppTabKind | null {
  // The composer has a tab of its own, which the step just opened.
  if (step.target === COMPOSER_TARGET) return null;
  const page = step.page?.replace(/^\//, "");
  return page === "calendar" || page === "contacts" || page === "files" || page === "settings" ? page : "mail";
}

/** Whether the user is in the app the step is about. */
export function isTourStepOnPage(step: Pick<TourStep, "page">, pathname: string): boolean {
  const page = step.page && step.page !== "/" ? step.page : null;
  if (!page) return pathname === "/" || pathname === "" || pathname === "/mail" || pathname.startsWith("/mail/");
  return pathname === page || pathname.startsWith(page + "/");
}

/** Clicks the visible copy of a tour anchor (the phone's compose button, not the closed drawer's). */
function clickTourTarget(selector: string): void {
  (findTourTarget(selector) as HTMLElement | null)?.click();
}

const COMPOSER_TARGET = '[data-tour="composer"]';

export const BASE_TOUR_STEPS: TourStep[] = [
  {
    id: "sidebar",
    target: '[data-tour="sidebar"]',
    titleKey: "tour.sidebar_title",
    descriptionKey: "tour.sidebar_desc",
    placement: "right",
    phone: false,
  },
  {
    id: "compose",
    target: '[data-tour="compose-button"]',
    titleKey: "tour.compose_title",
    descriptionKey: "tour.compose_desc",
    placement: "right",
    interactive: true,
  },
  {
    id: "search",
    target: '[data-tour="search-input"]',
    titleKey: "tour.search_title",
    descriptionKey: "tour.search_desc",
    placement: "bottom",
    interactive: true,
  },
  {
    id: "email-list",
    target: '[data-tour="email-list"]',
    titleKey: "tour.email_list_title",
    descriptionKey: "tour.email_list_desc",
    phoneDescriptionKey: "tour.email_list_desc_phone",
    placement: "right",
  },
  {
    id: "email-viewer",
    target: '[data-tour="email-viewer"]',
    titleKey: "tour.email_viewer_title",
    descriptionKey: "tour.email_viewer_desc",
    placement: "left",
    view: "reader",
    beforeAction: () => {
      // Click the "Welcome to Bulwark Mail!" email (or the first email) to open the viewer
      const emailList = document.querySelector('[data-tour="email-list"]');
      if (!emailList) return;
      // Try to find the welcome email by subject text
      const items = emailList.querySelectorAll('.cursor-pointer');
      let target: HTMLElement | null = null;
      for (const item of items) {
        if (item.textContent?.includes("Welcome to Bulwark Mail")) {
          target = item as HTMLElement;
          break;
        }
      }
      // Fallback to first email if welcome email not found
      if (!target) target = emailList.querySelector('.cursor-pointer') as HTMLElement | null;
      if (target) target.click();
    },
  },
  {
    id: "keywords",
    target: '[data-tour="keyword-tags"]',
    titleKey: "tour.keywords_title",
    descriptionKey: "tour.keywords_desc",
    placement: "right",
    phone: false,
  },
  {
    id: "nav-calendar",
    target: '[data-tour="nav-calendar"]',
    titleKey: "tour.calendar_title",
    descriptionKey: "tour.calendar_desc",
    placement: "right",
  },
  {
    id: "nav-contacts",
    target: '[data-tour="nav-contacts"]',
    titleKey: "tour.contacts_title",
    descriptionKey: "tour.contacts_desc",
    placement: "right",
  },
  {
    id: "nav-settings",
    target: '[data-tour="nav-settings"]',
    titleKey: "tour.settings_title",
    descriptionKey: "tour.settings_desc",
    placement: "right",
  },
  {
    id: "shortcuts",
    target: '[data-tour="nav-shortcuts"]',
    titleKey: "tour.shortcuts_title",
    descriptionKey: "tour.shortcuts_desc",
    placement: "right",
    interactive: true,
  },
];

export const DEMO_TOUR_STEPS: TourStep[] = [
  {
    id: "compose-open",
    target: COMPOSER_TARGET,
    titleKey: "tour.compose_open_title",
    descriptionKey: "tour.compose_open_desc",
    placement: "left",
    view: "reader",
    demoOnly: true,
    beforeAction: () => clickTourTarget('[data-tour="compose-button"]'),
  },
  {
    id: "calendar-view",
    target: '[data-tour="calendar-view"]',
    titleKey: "tour.calendar_view_title",
    descriptionKey: "tour.calendar_view_desc",
    placement: "bottom",
    page: "/calendar",
    demoOnly: true,
  },
  {
    id: "create-event",
    target: '[data-tour="create-event-button"]',
    titleKey: "tour.create_event_title",
    descriptionKey: "tour.create_event_desc",
    placement: "bottom",
    page: "/calendar",
    interactive: true,
    demoOnly: true,
  },
  {
    id: "event-modal",
    target: '[data-tour="event-modal"]',
    titleKey: "tour.event_modal_title",
    descriptionKey: "tour.event_modal_desc",
    placement: "left",
    page: "/calendar",
    interactive: true,
    demoOnly: true,
    beforeAction: () => clickTourTarget('[data-tour="create-event-button"]'),
  },
  {
    id: "contacts-list",
    target: '[data-tour="contacts-list"]',
    titleKey: "tour.contacts_list_title",
    descriptionKey: "tour.contacts_list_desc",
    phoneDescriptionKey: "tour.contacts_list_desc_phone",
    placement: "right",
    page: "/contacts",
    demoOnly: true,
  },
  {
    id: "settings-tabs",
    target: '[data-tour="settings-tabs"]',
    titleKey: "tour.settings_tabs_title",
    descriptionKey: "tour.settings_tabs_desc",
    placement: "right",
    page: "/settings",
    demoOnly: true,
  },
  {
    id: "nav-files",
    target: '[data-tour="nav-files"]',
    titleKey: "tour.files_title",
    descriptionKey: "tour.files_desc",
    placement: "right",
    // Shown over the Files app, pointing at its place in the rail or tab bar.
    page: "/files",
    demoOnly: true,
  },
  {
    id: "demo-banner",
    target: '[data-tour="demo-banner"]',
    titleKey: "tour.demo_banner_title",
    descriptionKey: "tour.demo_banner_desc",
    placement: "bottom",
    phone: false,
    demoOnly: true,
  },
  {
    id: "quota",
    target: '[data-tour="storage-quota"]',
    titleKey: "tour.quota_title",
    descriptionKey: "tour.quota_desc",
    placement: "right",
    phone: false,
    demoOnly: true,
  },
];

export function getTourSteps(options: {
  isDemoMode: boolean;
  supportsCalendar: boolean;
  supportsWebDAV: boolean;
  /** Contacts available and allowed; defaults to true. */
  supportsContacts?: boolean;
  /** A touch screen: no keyboard to use the shortcuts with. */
  touch?: boolean;
  /** The phone layout: no rail, the folders in a drawer. */
  phone?: boolean;
}): TourStep[] {
  let steps = [...BASE_TOUR_STEPS];

  if (!options.supportsCalendar) {
    steps = steps.filter((s) => s.id !== "nav-calendar");
  }
  if (options.supportsContacts === false) {
    steps = steps.filter((s) => s.id !== "nav-contacts");
  }
  if (options.touch) {
    steps = steps.filter((s) => s.id !== "shortcuts");
  }

  if (options.isDemoMode) {
    const demoSteps = DEMO_TOUR_STEPS.filter((s) => {
      if (s.id === "nav-files" && !options.supportsWebDAV) return false;
      if ((s.id === "calendar-view" || s.id === "create-event" || s.id === "event-modal") && !options.supportsCalendar) return false;
      return true;
    });
    steps = [...steps, ...demoSteps];
  }

  if (options.phone) {
    steps = steps.filter((s) => s.phone !== false);
  }

  return steps;
}
