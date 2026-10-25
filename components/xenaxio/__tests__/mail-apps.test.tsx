import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { translate } from "@/lib/xenaxio/i18n";
import { MAIL_APPS, MailApps } from "../mail-apps";

vi.mock("next-intl", () => ({ useLocale: () => "de" }));

const settings = {
  username: "anna@firma.de",
  imap: { host: "mail.xenaxio.com", port: 993, security: "ssl" as const },
  smtp: { host: "mail.xenaxio.com", port: 465, security: "ssl" as const },
};

describe("MailApps (step 23)", () => {
  it("shows the login, both servers and their ports", () => {
    render(<MailApps settings={settings} domainPending={false} />);
    expect(screen.getByText("anna@firma.de")).toBeTruthy();
    expect(screen.getAllByText("mail.xenaxio.com")).toHaveLength(2);
    expect(screen.getByText("993")).toBeTruthy();
    expect(screen.getByText("465")).toBeTruthy();
    expect(screen.getByText("Ihr xenaxio-Passwort")).toBeTruthy();
    expect(screen.queryByText(/noch nicht verbunden/)).toBeNull();
  });

  it("warns while the company domain is not connected", () => {
    render(<MailApps settings={settings} domainPending />);
    expect(screen.getByText(/noch nicht verbunden/)).toBeTruthy();
  });

  it("has steps for every app, opened on demand", () => {
    render(<MailApps settings={settings} domainPending={false} />);
    fireEvent.click(screen.getByText("Thunderbird"));
    expect(screen.getByText("„Manuell einrichten“ wählen.")).toBeTruthy();
  });

  it("explains sending from shared mailboxes only to those who may (step 37)", () => {
    const { unmount } = render(<MailApps settings={settings} domainPending={false} />);
    expect(screen.queryByText("Von gemeinsamen Postfächern senden")).toBeNull();
    unmount();
    render(<MailApps settings={{ ...settings, sendAs: [{ email: "info@firma.de", displayName: "Info" }] }} domainPending={false} />);
    expect(screen.getByText("Von gemeinsamen Postfächern senden")).toBeTruthy();
    expect(screen.getByText("info@firma.de")).toBeTruthy();
    expect(screen.getByText(/kein eigenes Passwort/)).toBeTruthy();
    for (const key of ["send_as_title", "send_as_intro", "send_as_note"]) {
      expect(translate("en", `mail_apps.${key}`)).not.toBe(`mail_apps.${key}`);
    }
  });

  it("has every step text in German and English", () => {
    for (const locale of ["de", "en"]) {
      for (const app of MAIL_APPS) {
        for (const key of [app.id, ...Array.from({ length: app.steps }, (_, i) => `${app.id}_${i + 1}`)]) {
          expect(translate(locale, `mail_apps.${key}`)).not.toBe(`mail_apps.${key}`);
        }
      }
    }
  });
});
