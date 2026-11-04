/**
 * The desktop app's OS policies: every key, its type, its text in en and de, and
 * how a raw value becomes a usable one. The ADMX and ADML templates, the sample
 * .mobileconfig and the sample policies.json are generated from this file
 * (scripts/generate-desktop-policies.mjs), so nobody writes those by hand.
 *
 * No DOM, no Node, no imports: the desktop repo keeps a byte-for-byte copy in
 * src/shared/policy-schema.ts, the embedded server reads it, and so do pages.
 *
 * A policy value can be anything. A registry value may have the wrong type, a
 * JSON file may hold an object where a string belongs, and a list may have a
 * million entries. So every value goes through `parsePolicyValue`, which has caps
 * and scheme checks, and a value it refuses fails closed: see `onInvalid`.
 */

export const POLICY_SCHEMA_VERSION = 1;

/** Under HKLM and HKCU. Only this tree is ever read: nothing a standard user can write. */
export const POLICY_REGISTRY_ROOT = 'Software\\Policies\\Bulwark\\Desktop';
export const POLICY_RECOMMENDED_SUBKEY = 'Recommended';
export const POLICY_BUNDLE_ID = 'org.bulwarkmail.desktop';
export const POLICY_LINUX_FILE = '/etc/bulwark/policies.json';

export const POLICY_MAX_STRING = 2048;
export const POLICY_MAX_NONCE = 128;
export const POLICY_MAX_LIST_ITEMS = 500;
export const POLICY_MAX_CERTIFICATE_RULE = 4096;
export const POLICY_MAX_FILE_BYTES = 1024 * 1024;

export type PolicyText = { en: string; de: string };

export type PolicyCategory = 'connection' | 'updates' | 'plugins' | 'security' | 'privacy' | 'signIn' | 'system';

export const POLICY_CATEGORIES: Record<PolicyCategory, PolicyText> = {
  connection: { en: 'Connection', de: 'Verbindung' },
  updates: { en: 'Updates', de: 'Updates' },
  plugins: { en: 'Plugins', de: 'Plugins' },
  security: { en: 'Offline mail and app lock', de: 'Offline-E-Mails und App-Sperre' },
  privacy: { en: 'Privacy', de: 'Datenschutz' },
  signIn: { en: 'Sign-in and certificates', de: 'Anmeldung und Zertifikate' },
  system: { en: 'System integration and troubleshooting', de: 'Systemintegration und Fehlerbehebung' },
};

export interface CertificateName {
  CN?: string;
  L?: string;
  O?: string;
  OU?: string;
}

/** One entry of AutoSelectCertificateForUrls, in Chrome's format. */
export interface CertificateRule {
  /** A lowercase host, optionally with a port. */
  host: string;
  /** Also matches subdomains: `[*.]example.com`. */
  subdomains: boolean;
  issuer?: CertificateName;
  subject?: CertificateName;
}

export interface PolicyValues {
  InstanceUrl: string | null;
  AllowStandalone: boolean;
  AllowedJmapServers: string[] | null;
  AllowInsecureInstance: boolean;
  UpdateChannel: 'stable' | 'beta';
  AutoUpdate: boolean;
  PluginsMode: 'allowed' | 'allowlist' | 'off';
  PluginAllowlist: string[];
  OfflineEnabled: boolean;
  AppLockRequired: boolean;
  AppLockTimeoutMinutes: number | null;
  TelemetryAllowed: boolean;
  CrashReportsAllowed: boolean;
  QuickComposeShortcut: string | null;
  AuthServerAllowlist: string | null;
  AuthNegotiateDelegateAllowlist: string | null;
  AutoSelectCertificateForUrls: CertificateRule[];
  KeystoreEnabled: boolean;
  KeystoreAllowedOrigins: string[];
  BrowserSignIn: boolean;
  WipeOfflineData: string | null;
  OpenWithEnabled: boolean;
  DeveloperToolsAvailability: number | null;
  FilesDriveEnabled: boolean;
  FilesFolderSyncEnabled: boolean;
  FilesDriveLetter: string | null;
}

export type PolicyKey = keyof PolicyValues;

interface PolicyBase {
  category: PolicyCategory;
  title: PolicyText;
  description: PolicyText;
  /**
   * Only a forced value counts. Anything that decides what's allowed, or a yes or no with
   * nothing for a recommendation to set: it has no user choice to sit under, so a
   * "recommended" one would act as forced without being shown as such, or do nothing, and
   * only a forced value may loosen a forced one.
   */
  forcedOnly?: boolean;
}

export type PolicyDefinition = PolicyBase &
  (
    | {
        type: 'boolean';
        default: boolean;
        /** What a forced value that makes no sense means. The strict side, never the open one. */
        onInvalid: boolean;
        /** What an example configuration sets. */
        sample: boolean;
      }
    | {
        type: 'integer';
        default: number | null;
        min: number;
        max: number;
        /** What a forced value nobody can read means, where the lowest number isn't the strict side. */
        onInvalid?: number | null;
        unit: PolicyText;
        sample: number;
      }
    | {
        type: 'enum';
        default: string;
        onInvalid: string;
        values: readonly { value: string; title: PolicyText }[];
        sample: string;
      }
    | {
        type: 'string';
        format: 'instanceUrl' | 'shortcut' | 'hostList' | 'nonce' | 'driveLetter';
        default: null;
        maxLength: number;
        label: PolicyText;
        sample: string;
      }
    | {
        type: 'list';
        item: 'server' | 'plugin' | 'certificate' | 'origin';
        default: readonly never[] | null;
        label: PolicyText;
        sample: readonly string[];
      }
  );

export const POLICY_SCHEMA: Record<PolicyKey, PolicyDefinition> = {
  InstanceUrl: {
    category: 'connection',
    type: 'string',
    format: 'instanceUrl',
    default: null,
    maxLength: POLICY_MAX_STRING,
    sample: 'https://mail.example.com',
    label: { en: 'Address of the Bulwark server', de: 'Adresse des Bulwark-Servers' },
    title: { en: 'Bulwark server', de: 'Bulwark-Server' },
    description: {
      en: 'The address of your Bulwark server, starting with https://. When forced, the app opens on this server, the choice of server is hidden, and the window stays on it. An invalid address shows an error page that names this policy, and the app does not fall back to anything else. As a default, the app opens on this server until the user picks something else.',
      de: 'Die Adresse Ihres Bulwark-Servers, beginnend mit https://. Wenn erzwungen, öffnet sich die App auf diesem Server, die Serverauswahl ist ausgeblendet und das Fenster bleibt auf diesem Server. Eine ungültige Adresse zeigt eine Fehlerseite mit dem Namen dieser Richtlinie, und die App weicht auf nichts anderes aus. Als Standardwert öffnet sich die App auf diesem Server, bis der Benutzer etwas anderes wählt.',
    },
  },
  AllowStandalone: {
    category: 'connection',
    forcedOnly: true,
    type: 'boolean',
    default: true,
    onInvalid: false,
    sample: false,
    title: { en: 'Allow direct connections to mail servers', de: 'Direkte Verbindungen zu Mailservern zulassen' },
    description: {
      en: 'When disabled, the app only opens a Bulwark server and nobody can sign in directly to a mail server. Accounts added earlier stay on the disk, but are hidden. If you force a Bulwark server and leave this not configured, direct connections are off too. Enable it to offer both.',
      de: 'Wenn deaktiviert, öffnet die App nur einen Bulwark-Server, und niemand kann sich direkt bei einem Mailserver anmelden. Früher hinzugefügte Konten bleiben auf dem Datenträger, sind aber ausgeblendet. Wenn Sie einen Bulwark-Server erzwingen und diese Richtlinie nicht konfigurieren, sind direkte Verbindungen ebenfalls aus. Aktivieren Sie sie, um beides anzubieten.',
    },
  },
  AllowedJmapServers: {
    category: 'connection',
    forcedOnly: true,
    type: 'list',
    item: 'server',
    default: null,
    sample: ['https://mail.example.com', 'https://*.mail.example.com'],
    label: { en: 'Allowed mail servers', de: 'Zugelassene Mailserver' },
    title: { en: 'Allowed mail servers', de: 'Zugelassene Mailserver' },
    description: {
      en: 'The mail servers people may sign in to. One per line: an address such as https://mail.example.com, or https://*.example.com for all subdomains. A server without a scheme means https. Plain http must be named with http://. When this list is set, everything else is refused, and accounts on a server taken off the list stop until it is back, keeping their data. A Bulwark server the user picks, or the one under "Bulwark server" as a default, must be on the list too. A forced one does not need to be.',
      de: 'Die Mailserver, bei denen sich Benutzer anmelden dürfen. Einer pro Zeile: eine Adresse wie https://mail.example.com oder https://*.example.com für alle Subdomains. Ein Server ohne Schema bedeutet https. Unverschlüsseltes http muss mit http:// angegeben werden. Ist diese Liste gesetzt, wird alles andere abgelehnt, und Konten auf einem Server, der von der Liste genommen wird, ruhen, bis er wieder darauf steht, und behalten ihre Daten. Ein Bulwark-Server, den der Benutzer wählt, oder der unter „Bulwark-Server“ als Standardwert muss ebenfalls auf der Liste stehen. Ein erzwungener nicht.',
    },
  },
  AllowInsecureInstance: {
    category: 'connection',
    forcedOnly: true,
    type: 'boolean',
    default: false,
    onInvalid: false,
    sample: false,
    title: { en: 'Allow a Bulwark server on plain http', de: 'Bulwark-Server über unverschlüsseltes http zulassen' },
    description: {
      en: 'When enabled, the address in "Bulwark server" may start with http://. Passwords and mail then travel unencrypted, and the browser features that need https, such as offline mail and S/MIME, do not work. Leave this off unless the server is on a network you trust.',
      de: 'Wenn aktiviert, darf die Adresse unter „Bulwark-Server“ mit http:// beginnen. Passwörter und E-Mails gehen dann unverschlüsselt über das Netzwerk, und Funktionen, die https brauchen, wie Offline-E-Mails und S/MIME, funktionieren nicht. Lassen Sie dies aus, sofern der Server nicht in einem Netzwerk steht, dem Sie vertrauen.',
    },
  },
  UpdateChannel: {
    category: 'updates',
    type: 'enum',
    default: 'stable',
    onInvalid: 'stable',
    sample: 'stable',
    values: [
      { value: 'stable', title: { en: 'Stable', de: 'Stabil' } },
      { value: 'beta', title: { en: 'Beta', de: 'Beta' } },
    ],
    title: { en: 'Update channel', de: 'Update-Kanal' },
    description: {
      en: 'Which releases the app updates to.',
      de: 'Auf welche Versionen die App aktualisiert wird.',
    },
  },
  AutoUpdate: {
    category: 'updates',
    forcedOnly: true,
    type: 'boolean',
    default: true,
    onInvalid: false,
    sample: false,
    title: { en: 'Update automatically', de: 'Automatisch aktualisieren' },
    description: {
      en: 'When disabled, the app does not look for updates or download them. Use this when SCCM, Intune or similar tools deliver updates.',
      de: 'Wenn deaktiviert, sucht die App nicht nach Updates und lädt keine herunter. Verwenden Sie dies, wenn SCCM, Intune oder ähnliche Werkzeuge die Updates liefern.',
    },
  },
  PluginsMode: {
    category: 'plugins',
    forcedOnly: true,
    type: 'enum',
    default: 'allowed',
    onInvalid: 'off',
    sample: 'allowlist',
    values: [
      { value: 'allowed', title: { en: 'All plugins are allowed', de: 'Alle Plugins sind erlaubt' } },
      { value: 'allowlist', title: { en: 'Only plugins on the list', de: 'Nur Plugins auf der Liste' } },
      { value: 'off', title: { en: 'No plugins', de: 'Keine Plugins' } },
    ],
    title: { en: 'Which plugins may run', de: 'Welche Plugins laufen dürfen' },
    description: {
      en: 'Whether plugins can be installed and run. With the list or none, people cannot add a plugin themselves, since a package can name any id. With the list, only plugins your Bulwark server or the app\'s directory provides can run. A plugin that is refused keeps its data and settings: it comes back as it was if the policy allows it again.',
      de: 'Ob Plugins installiert und ausgeführt werden dürfen. Mit der Liste oder ohne Plugins können Benutzer selbst keine Plugins hinzufügen, weil ein Paket jede beliebige ID nennen kann. Mit der Liste laufen nur Plugins, die Ihr Bulwark-Server oder das Verzeichnis der App bereitstellt. Ein abgelehntes Plugin behält seine Daten und Einstellungen: Es kommt unverändert zurück, wenn die Richtlinie es wieder erlaubt.',
    },
  },
  PluginAllowlist: {
    category: 'plugins',
    forcedOnly: true,
    type: 'list',
    item: 'plugin',
    default: [],
    sample: ['example-plugin'],
    label: { en: 'Plugin ids', de: 'Plugin-IDs' },
    title: { en: 'Allowed plugins', de: 'Erlaubte Plugins' },
    description: {
      en: 'The ids of the plugins that may run when "Which plugins may run" is set to the list. One per line.',
      de: 'Die IDs der Plugins, die laufen dürfen, wenn „Welche Plugins laufen dürfen“ auf die Liste gesetzt ist. Eine pro Zeile.',
    },
  },
  OfflineEnabled: {
    category: 'security',
    type: 'boolean',
    default: true,
    onInvalid: false,
    sample: true,
    title: { en: 'Keep mail on the device', de: 'E-Mails auf dem Gerät behalten' },
    description: {
      en: 'Whether accounts keep an encrypted copy of mail on this device for offline use. When forced off, copies already on the device are removed.',
      de: 'Ob Konten eine verschlüsselte Kopie der E-Mails auf diesem Gerät für die Offline-Nutzung behalten. Wenn erzwungen aus, werden bereits vorhandene Kopien entfernt.',
    },
  },
  AppLockRequired: {
    category: 'security',
    forcedOnly: true,
    type: 'boolean',
    default: false,
    onInvalid: true,
    sample: true,
    title: { en: 'Require an app lock', de: 'App-Sperre verlangen' },
    description: {
      en: 'When enabled, people must set up the app lock and cannot turn it off.',
      de: 'Wenn aktiviert, müssen Benutzer die App-Sperre einrichten und können sie nicht ausschalten.',
    },
  },
  AppLockTimeoutMinutes: {
    category: 'security',
    type: 'integer',
    default: null,
    min: 1,
    max: 1440,
    unit: { en: 'Minutes', de: 'Minuten' },
    sample: 10,
    title: { en: 'Lock the app after', de: 'App sperren nach' },
    description: {
      en: 'How many minutes without use the app stays unlocked. From 1 to 1440.',
      de: 'Wie viele Minuten ohne Nutzung die App entsperrt bleibt. Von 1 bis 1440.',
    },
  },
  TelemetryAllowed: {
    category: 'privacy',
    forcedOnly: true,
    type: 'boolean',
    default: true,
    onInvalid: false,
    sample: false,
    title: { en: 'Allow usage statistics', de: 'Nutzungsstatistiken zulassen' },
    description: {
      en: 'When disabled, the app sends no usage statistics and does not ask. When enabled or not configured, it still asks the user first.',
      de: 'Wenn deaktiviert, sendet die App keine Nutzungsstatistiken und fragt nicht danach. Wenn aktiviert oder nicht konfiguriert, fragt sie den Benutzer trotzdem zuerst.',
    },
  },
  CrashReportsAllowed: {
    category: 'privacy',
    forcedOnly: true,
    type: 'boolean',
    default: true,
    onInvalid: false,
    sample: false,
    title: { en: 'Allow crash reports', de: 'Absturzberichte zulassen' },
    description: {
      en: 'When disabled, the app sends no crash reports and does not ask. When enabled or not configured, it still asks the user first.',
      de: 'Wenn deaktiviert, sendet die App keine Absturzberichte und fragt nicht danach. Wenn aktiviert oder nicht konfiguriert, fragt sie den Benutzer trotzdem zuerst.',
    },
  },
  QuickComposeShortcut: {
    category: 'security',
    type: 'string',
    format: 'shortcut',
    default: null,
    maxLength: 64,
    sample: 'CommandOrControl+Alt+N',
    label: { en: 'Shortcut', de: 'Tastenkombination' },
    title: { en: 'Global shortcut for a new message', de: 'Globale Tastenkombination für neue Nachricht' },
    description: {
      en: 'The key combination that opens a new message from anywhere, such as CommandOrControl+Alt+N. Enter off to turn the shortcut off.',
      de: 'Die Tastenkombination, die von überall aus eine neue Nachricht öffnet, etwa CommandOrControl+Alt+N. Geben Sie off ein, um sie auszuschalten.',
    },
  },
  AuthServerAllowlist: {
    category: 'signIn',
    forcedOnly: true,
    type: 'string',
    format: 'hostList',
    default: null,
    maxLength: POLICY_MAX_STRING,
    sample: '*.example.com',
    label: { en: 'Servers', de: 'Server' },
    title: { en: 'Servers for integrated sign-in', de: 'Server für die integrierte Anmeldung' },
    description: {
      en: 'The servers that may use the Windows sign-in (Kerberos, NTLM), separated by commas, such as *.example.com. A server taken off the list stops getting it at once. A new one needs the app to restart.',
      de: 'Die Server, die die Windows-Anmeldung (Kerberos, NTLM) verwenden dürfen, durch Kommas getrennt, etwa *.example.com. Ein von der Liste entfernter Server erhält sie sofort nicht mehr. Ein neuer braucht einen Neustart der App.',
    },
  },
  AuthNegotiateDelegateAllowlist: {
    category: 'signIn',
    forcedOnly: true,
    type: 'string',
    format: 'hostList',
    default: null,
    maxLength: POLICY_MAX_STRING,
    sample: '*.example.com',
    label: { en: 'Servers', de: 'Server' },
    title: { en: 'Servers for delegated sign-in', de: 'Server für die delegierte Anmeldung' },
    description: {
      en: 'The servers the app may delegate Kerberos credentials to, separated by commas. Takes effect when the app restarts.',
      de: 'Die Server, an die die App Kerberos-Anmeldedaten delegieren darf, durch Kommas getrennt. Wird beim Neustart der App wirksam.',
    },
  },
  AutoSelectCertificateForUrls: {
    category: 'signIn',
    forcedOnly: true,
    type: 'list',
    item: 'certificate',
    default: [],
    sample: ['{"pattern":"https://[*.]example.com","filter":{"ISSUER":{"CN":"Example CA"}}}'],
    label: { en: 'Rules', de: 'Regeln' },
    title: { en: 'Choose client certificates automatically', de: 'Clientzertifikate automatisch wählen' },
    description: {
      en: 'One JSON rule per line, in the format Chrome uses: {"pattern":"https://[*.]example.com","filter":{"ISSUER":{"CN":"Example CA"}}}. The app then picks the matching certificate for that site without asking.',
      de: 'Eine JSON-Regel pro Zeile, im Format von Chrome: {"pattern":"https://[*.]example.com","filter":{"ISSUER":{"CN":"Example CA"}}}. Die App wählt dann für diese Website das passende Zertifikat ohne Rückfrage.',
    },
  },
  KeystoreEnabled: {
    category: 'signIn',
    forcedOnly: true,
    type: 'boolean',
    default: true,
    onInvalid: false,
    sample: true,
    title: { en: 'Allow the system certificate store', de: 'Zertifikatspeicher des Systems erlauben' },
    description: {
      en: 'When disabled, nothing in the app can sign or decrypt with the certificates and smart cards in the operating system\'s store, and nobody is asked. This overrides the list of sites below. It also holds when plugins are turned off. Imported keys are not affected.',
      de: 'Wenn deaktiviert, kann nichts in der App mit den Zertifikaten und Smartcards im Speicher des Betriebssystems signieren oder entschlüsseln, und niemand wird gefragt. Das hat Vorrang vor der Liste der Websites unten. Es gilt auch, wenn Plugins ausgeschaltet sind. Importierte Schlüssel sind nicht betroffen.',
    },
  },
  KeystoreAllowedOrigins: {
    category: 'signIn',
    forcedOnly: true,
    type: 'list',
    item: 'origin',
    default: [],
    sample: ['https://mail.example.com'],
    label: { en: 'Addresses', de: 'Adressen' },
    title: { en: 'Sites that may use the system certificate store', de: 'Websites, die den Zertifikatspeicher des Systems verwenden dürfen' },
    description: {
      en: 'The Bulwark servers, by https address, whose plugins may sign and decrypt with the certificates in the operating system\'s store, without the user being asked for each site. One per line.',
      de: 'Die Bulwark-Server, nach https-Adresse, deren Plugins mit den Zertifikaten im Speicher des Betriebssystems signieren und entschlüsseln dürfen, ohne dass der Benutzer für jede Website gefragt wird. Eine pro Zeile.',
    },
  },
  BrowserSignIn: {
    category: 'signIn',
    type: 'boolean',
    default: true,
    onInvalid: false,
    sample: true,
    title: { en: 'Offer sign-in through the browser', de: 'Anmeldung über den Browser anbieten' },
    description: {
      en: 'When enabled or not configured, the login page offers "Sign in with your browser", so people can use their password manager, passkeys and your single sign-on there. When disabled, the button is gone and the app refuses the flow. The form in the app stays, unless the server only allows OAuth.',
      de: 'Wenn aktiviert oder nicht konfiguriert, bietet die Anmeldeseite „Mit Ihrem Browser anmelden“ an, damit Benutzer dort ihren Passwort-Manager, Passkeys und Ihr Single Sign-on verwenden können. Wenn deaktiviert, fehlt die Schaltfläche und die App lehnt den Vorgang ab. Das Formular in der App bleibt, sofern der Server nicht nur OAuth erlaubt.',
    },
  },
  WipeOfflineData: {
    category: 'security',
    type: 'string',
    format: 'nonce',
    default: null,
    forcedOnly: true,
    maxLength: POLICY_MAX_NONCE,
    sample: '2026-11-03-1',
    label: { en: 'Wipe code', de: 'Löschcode' },
    title: { en: 'Delete mail kept on the device', de: 'Auf dem Gerät behaltene E-Mails löschen' },
    description: {
      en: 'Set this to a new value, such as today\'s date, to delete everything the app keeps on the device for every server and account: mail, keys, and sign-ins, so people sign in again. Each value deletes once: the app remembers the ones it has acted on, so it stays safe to leave a value in place. Use a new value to delete again. That memory is in the user\'s own profile, so someone who edits it can skip a wipe they know is coming: this cleans up a device, it doesn\'t take data from the person using it.',
      de: 'Setzen Sie dies auf einen neuen Wert, etwa das heutige Datum, um alles zu löschen, was die App für alle Server und Konten auf dem Gerät behält: E-Mails, Schlüssel und Anmeldungen, Benutzer melden sich also neu an. Jeder Wert löscht einmal: Die App merkt sich, welche sie schon ausgeführt hat, ein Wert kann also stehen bleiben. Verwenden Sie einen neuen Wert, um erneut zu löschen. Diese Liste liegt im Profil des Benutzers. Wer sie bearbeitet, kann also eine Löschung umgehen, von der er weiß: Dies räumt ein Gerät auf, es nimmt der Person am Gerät keine Daten weg.',
    },
  },
  OpenWithEnabled: {
    category: 'system',
    type: 'boolean',
    default: true,
    onInvalid: false,
    forcedOnly: true,
    sample: true,
    title: { en: 'Offer the app in "Open with" and "Send to"', de: 'App unter „Öffnen mit“ und „Senden an“ anbieten' },
    description: {
      en: 'When enabled or not configured, the app adds itself to the "Open with" list for common documents and pictures and to the "Send to" menu on Windows, so people can attach a file to a new message from the file manager. It never becomes the default program for those files. When disabled, the app removes these entries for the user. Mail links and .eml, .ics and .vcf files are not affected.',
      de: 'Wenn aktiviert oder nicht konfiguriert, trägt sich die App unter Windows in die Liste „Öffnen mit“ für gängige Dokumente und Bilder und in das Menü „Senden an“ ein, damit Benutzer eine Datei aus dem Dateimanager an eine neue Nachricht anhängen können. Sie wird nie zum Standardprogramm für diese Dateien. Wenn deaktiviert, entfernt die App diese Einträge für den Benutzer. Mail-Links und .eml-, .ics- und .vcf-Dateien sind nicht betroffen.',
    },
  },
  DeveloperToolsAvailability: {
    category: 'system',
    type: 'integer',
    default: null,
    min: 0,
    max: 2,
    // 0 allows them, so the lowest value would be the open side: not set, locked, reads as off.
    onInvalid: null,
    forcedOnly: true,
    unit: { en: 'Value (0, 1 or 2)', de: 'Wert (0, 1 oder 2)' },
    sample: 2,
    title: { en: 'Developer tools', de: 'Entwicklertools' },
    description: {
      en: 'The same values as Chrome\'s policy of this name. 2: developer tools are off and the setting is locked. 0 or 1, or not configured: people can turn them on under Settings, after a warning. Developer tools let anyone at the keyboard read everything the app holds, mail and passwords in memory included.',
      de: 'Dieselben Werte wie die gleichnamige Richtlinie von Chrome. 2: Die Entwicklertools sind aus und die Einstellung ist gesperrt. 0 oder 1 oder nicht konfiguriert: Benutzer können sie nach einer Warnung in den Einstellungen einschalten. Mit den Entwicklertools kann jeder an der Tastatur alles lesen, was die App enthält, auch E-Mails und Passwörter im Speicher.',
    },
  },
  FilesDriveEnabled: {
    category: 'system',
    type: 'boolean',
    default: true,
    onInvalid: false,
    forcedOnly: true,
    sample: true,
    title: { en: 'Allow Files as a drive', de: 'Dateien als Laufwerk zulassen' },
    description: {
      en: 'When enabled or not configured, people can show their Files in the file manager as a drive, with files downloaded when opened. Windows only for now. When disabled, the drive is not offered, and a drive that is already there is removed with the copies of files in it. Files on the server are not affected.',
      de: 'Wenn aktiviert oder nicht konfiguriert, können Benutzer ihre Dateien im Dateimanager als Laufwerk anzeigen. Dateien werden beim Öffnen heruntergeladen. Vorerst nur unter Windows. Wenn deaktiviert, wird das Laufwerk nicht angeboten, und ein vorhandenes Laufwerk wird mit den Kopien der Dateien darin entfernt. Die Dateien auf dem Server sind davon nicht betroffen.',
    },
  },
  FilesFolderSyncEnabled: {
    category: 'system',
    type: 'boolean',
    default: true,
    onInvalid: false,
    forcedOnly: true,
    sample: true,
    title: { en: 'Allow syncing folders with Files', de: 'Synchronisieren von Ordnern mit Dateien zulassen' },
    description: {
      en: 'When enabled or not configured, people can keep a folder on the computer and a folder in Files the same, in both directions. When disabled, this is not offered and folders that sync now stop. The files in those folders stay where they are.',
      de: 'Wenn aktiviert oder nicht konfiguriert, können Benutzer einen Ordner auf dem Computer und einen Ordner in Dateien in beide Richtungen gleich halten. Wenn deaktiviert, wird dies nicht angeboten, und Ordner, die gerade synchronisiert werden, hören damit auf. Die Dateien in diesen Ordnern bleiben, wo sie sind.',
    },
  },
  FilesDriveLetter: {
    category: 'system',
    forcedOnly: true,
    type: 'string',
    format: 'driveLetter',
    default: null,
    maxLength: 8,
    sample: 'none',
    label: { en: 'Drive letter', de: 'Laufwerksbuchstabe' },
    title: { en: 'Drive letter for Files', de: 'Laufwerksbuchstabe für Dateien' },
    description: {
      en: 'Windows only. A letter from D to Z gives the Files drive that letter for every user, and they can\'t change it. Enter none to never give it a letter. When not configured, people choose under Settings, and there is no letter until they do. A value the app can\'t read counts as none.',
      de: 'Nur unter Windows. Ein Buchstabe von D bis Z gibt dem Laufwerk Dateien für jeden Benutzer diesen Buchstaben, und Benutzer können ihn nicht ändern. Geben Sie none ein, damit es nie einen Buchstaben bekommt. Wenn nicht konfiguriert, wählen Benutzer in den Einstellungen, und bis dahin gibt es keinen Buchstaben. Ein Wert, den die App nicht lesen kann, gilt als none.',
    },
  },
};

export const POLICY_KEYS = Object.keys(POLICY_SCHEMA) as PolicyKey[];

export type PolicySource = 'forced-machine' | 'forced-user' | 'recommended-machine' | 'recommended-user' | 'default';

export interface PolicyEntry<K extends PolicyKey = PolicyKey> {
  value: PolicyValues[K];
  source: PolicySource;
  /** Forced: the user can't change it, and the setting shows "Set by your organisation". */
  locked: boolean;
  /** A forced value we refused: `value` is then the strict one. Names the reason. */
  invalid?: string;
  /** Part of a list we dropped, while the rest stands. */
  dropped?: number;
  /** What was set, for an error page. Capped. */
  raw?: string;
}

export type PolicySnapshot = { [K in PolicyKey]: PolicyEntry<K> };

/** One level of the registry, the profile or the file: raw values, untrusted. */
export type PolicyLayer = Partial<Record<PolicyKey, unknown>>;

export interface PolicyLayers {
  forcedMachine: PolicyLayer;
  forcedUser: PolicyLayer;
  recommendedMachine: PolicyLayer;
  recommendedUser: PolicyLayer;
}

export const EMPTY_POLICY_LAYERS: PolicyLayers = { forcedMachine: {}, forcedUser: {}, recommendedMachine: {}, recommendedUser: {} };

type Parsed<T> = { ok: true; value: T; dropped?: number } | { ok: false; reason: string };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function fail<T>(reason: string): Parsed<T> {
  return { ok: false, reason };
}

/**
 * A Bulwark server's address, normalised to `origin + path + /`. Only https, or http
 * when the policy says so. No credentials, no query, no fragment.
 */
export function parseInstanceUrl(raw: unknown, allowInsecure: boolean): Parsed<string> {
  if (typeof raw !== 'string') return fail('not_text');
  const text = raw.trim();
  if (!text) return fail('empty');
  if (text.length > POLICY_MAX_STRING) return fail('too_long');
  if (CONTROL.test(text)) return fail('invalid_url');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail('invalid_url');
  }
  if (url.protocol === 'http:') {
    if (!allowInsecure) return fail('insecure');
  } else if (url.protocol !== 'https:') {
    return fail('scheme');
  }
  if (!url.hostname || url.username || url.password || url.search || url.hash) return fail('invalid_url');
  // After the parser's work a real name is plain letters, digits, dots and hyphens (an
  // international one becomes xn--), or an IP literal. Anything else is not an address.
  if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/.test(url.hostname)) return fail('invalid_url');
  return { ok: true, value: `${url.origin}${url.pathname.replace(/\/+$/, '')}/` };
}

/**
 * One entry of AllowedJmapServers, normalised: `https://mail.example.com`,
 * `http://10.0.0.5:8080`, or `https://*.example.com`.
 */
export function parseServerPattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text || text.length > POLICY_MAX_STRING || CONTROL.test(text) || /\s/.test(text)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  const wildcard = /^([a-z]+:\/\/)\*\.(.+)$/i.exec(text);
  const candidate = wildcard ? `${wildcard[1]}${wildcard[2]}` : text;
  if (candidate.includes('*')) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  // A wildcard over a bare name would match the whole of a top-level domain.
  if (wildcard && !url.hostname.includes('.')) return null;
  return wildcard ? `${url.protocol}//*.${url.host}` : url.origin;
}

/** Whether a mail server's address is on the list. Null means no list, so everything is. */
export function jmapServerAllowed(patterns: readonly string[] | null | undefined, serverUrl: unknown): boolean {
  if (patterns === null || patterns === undefined) return true;
  if (typeof serverUrl !== 'string' || CONTROL.test(serverUrl)) return false;
  let url: URL;
  try {
    url = new URL(serverUrl.trim());
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  for (const pattern of patterns) {
    const wildcard = /^([a-z]+:)\/\/\*\.(.+)$/.exec(pattern);
    if (!wildcard) {
      if (url.origin === pattern) return true;
      continue;
    }
    const [, scheme, host] = wildcard;
    if (url.protocol === scheme && url.host.endsWith(`.${host}`)) return true;
  }
  return false;
}

/** One entry of KeystoreAllowedOrigins: an https origin. */
export function parseHttpsOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > POLICY_MAX_STRING || CONTROL.test(raw)) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' || !/^[a-z0-9.-]+$/.test(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function parsePluginId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase();
  return PLUGIN_ID.test(id) ? id : null;
}

export type PluginsMode = PolicyValues['PluginsMode'];

/** The one question every plugin gate asks, in the server and in the page. */
export function pluginAllowedByPolicy(mode: PluginsMode, allowlist: readonly string[], id: unknown): boolean {
  if (mode === 'allowed') return true;
  if (mode !== 'allowlist' || typeof id !== 'string') return false;
  return allowlist.includes(id.trim().toLowerCase());
}

const SHORTCUT = /^(?:(?:Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift|Super|Meta)\+){1,4}(?:[A-Z0-9]|F[1-9]|F1[0-9]|F2[0-4]|Space|Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|[-=,./;'`[\]\\])$/i;

/** A drive letter from D to Z, upper case, or `none`. */
function parseDriveLetter(raw: unknown): Parsed<string> {
  if (typeof raw !== 'string') return fail('not_text');
  const text = raw.trim();
  if (text.toLowerCase() === 'none') return { ok: true, value: 'none' };
  const match = /^([D-Za-z]):?$/.exec(text);
  if (!match || !/^[D-Z]$/i.test(match[1])) return fail('invalid_drive_letter');
  return { ok: true, value: match[1].toUpperCase() };
}

function parseShortcut(raw: unknown): Parsed<string> {
  if (typeof raw !== 'string') return fail('not_text');
  const text = raw.trim();
  if (text === '' || text.toLowerCase() === 'off') return { ok: true, value: 'off' };
  if (text.length > 64 || !SHORTCUT.test(text)) return fail('invalid_shortcut');
  return { ok: true, value: text };
}

const HOST_LIST = /^[A-Za-z0-9*.,:_[\]-]+$/;

const COMMON_TOP_LEVEL = /^(?:[a-z]{2}|com|net|org|edu|gov|mil|int|info|biz|name|pro|mobi|app|dev|cloud|online|site|xyz|top|shop|store|tech|club|live|blog|page|arpa)$/;

/**
 * Chromium reads a plain name in these lists as "ends with", so `com` means every .com
 * address, and `.com` is `*.com`. `intranet` or `sso` stay fine: that's how a server with
 * no domain is named.
 */
function coversTopLevelDomain(host: string): boolean {
  const name = host.replace(/:\d+$/, '').replace(/\.+$/, '').toLowerCase();
  if (name.startsWith('.')) return !/^\.+[^.]+\.[^.]/.test(name);
  return COMMON_TOP_LEVEL.test(name);
}

/** What Chromium takes for its auth lists: names and wildcards, commas between them. */
function parseHostList(raw: unknown): Parsed<string> {
  if (typeof raw !== 'string') return fail('not_text');
  const text = raw.replace(/\s*,\s*/g, ',').trim();
  if (!text) return fail('empty');
  if (text.length > POLICY_MAX_STRING) return fail('too_long');
  if (!HOST_LIST.test(text)) return fail('invalid_host_list');
  const hosts = text.split(',').filter(Boolean);
  if (hosts.length === 0 || hosts.length > POLICY_MAX_LIST_ITEMS) return fail('invalid_host_list');
  // A wildcard must sit in front of a real domain of two labels or more: `*` or `*.com`
  // would hand Windows credentials to any site that asks.
  if (hosts.some((host) => host.includes('*') && !/^\*\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+(?::\d+)?$/.test(host))) return fail('invalid_host_list');
  if (hosts.some(coversTopLevelDomain)) return fail('invalid_host_list');
  return { ok: true, value: hosts.join(',') };
}

function parseNonce(raw: unknown): Parsed<string> {
  const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
  if (typeof text !== 'string') return fail('not_text');
  const value = text.trim();
  if (!value) return fail('empty');
  if (value.length > POLICY_MAX_NONCE || CONTROL.test(value)) return fail('too_long');
  return { ok: true, value };
}

function certificateName(raw: unknown): CertificateName | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const name: CertificateName = {};
  for (const part of ['CN', 'L', 'O', 'OU'] as const) {
    const value = (raw as Record<string, unknown>)[part];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 256 || CONTROL.test(value)) return null;
    name[part] = value;
  }
  return name;
}

/**
 * Chrome's format: {"pattern":"https://[*.]example.com","filter":{"ISSUER":{"CN":"x"}}}.
 * A rule must name a site: `*` would hand the certificate to any site that asks,
 * without the user seeing it.
 */
export function parseCertificateRule(raw: unknown): CertificateRule | null {
  if (typeof raw !== 'string' || raw.length > POLICY_MAX_CERTIFICATE_RULE) return null;
  let rule: unknown;
  try {
    rule = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) return null;
  const { pattern, filter } = rule as { pattern?: unknown; filter?: unknown };
  if (typeof pattern !== 'string' || pattern.length > POLICY_MAX_STRING || CONTROL.test(pattern) || /\s/.test(pattern)) return null;
  const match = /^(?:https:\/\/)?(\[\*\.\]|\*\.)?([^/*[\]]+(?::\d+)?)\/?$/i.exec(pattern);
  if (!match) return null;
  let host: string;
  let hostname: string;
  try {
    ({ host, hostname } = new URL(`https://${match[2]}`));
  } catch {
    return null;
  }
  if (!host) return null;
  // A wildcard over a bare name is the whole of a top-level domain.
  if (match[1] && !hostname.includes('.')) return null;
  if (filter !== undefined && (typeof filter !== 'object' || filter === null || Array.isArray(filter))) return null;
  const { ISSUER, SUBJECT } = (filter ?? {}) as { ISSUER?: unknown; SUBJECT?: unknown };
  const issuer = certificateName(ISSUER);
  const subject = certificateName(SUBJECT);
  if (issuer === null || subject === null) return null;
  return { host, subdomains: Boolean(match[1]), ...(issuer ? { issuer } : {}), ...(subject ? { subject } : {}) };
}

/** Whether a rule covers this https address. */
export function certificateRuleMatchesUrl(rule: CertificateRule, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return parsed.host === rule.host || (rule.subdomains && parsed.host.endsWith(`.${rule.host}`));
}

/** What's needed from a certificate: Electron's `Certificate` fits. */
export interface CertificateFacts {
  issuer?: { commonName?: string; locality?: string; organizations?: string[]; organizationUnits?: string[] };
  subject?: { commonName?: string; locality?: string; organizations?: string[]; organizationUnits?: string[] };
}

function nameMatches(wanted: CertificateName | undefined, actual: CertificateFacts['issuer']): boolean {
  if (!wanted) return true;
  if (wanted.CN !== undefined && actual?.commonName !== wanted.CN) return false;
  if (wanted.L !== undefined && actual?.locality !== wanted.L) return false;
  if (wanted.O !== undefined && !actual?.organizations?.includes(wanted.O)) return false;
  if (wanted.OU !== undefined && !actual?.organizationUnits?.includes(wanted.OU)) return false;
  return true;
}

export function certificateMatchesRule(rule: CertificateRule, certificate: CertificateFacts): boolean {
  return nameMatches(rule.issuer, certificate.issuer) && nameMatches(rule.subject, certificate.subject);
}

function parseBoolean(raw: unknown): Parsed<boolean> {
  if (raw === true || raw === 1 || raw === '1') return { ok: true, value: true };
  if (raw === false || raw === 0 || raw === '0') return { ok: true, value: false };
  return fail('not_a_switch');
}

function parseInteger(raw: unknown, min: number, max: number): Parsed<number> {
  const value = typeof raw === 'string' && /^\d{1,10}$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value)) return fail('not_a_number');
  if (value < min || value > max) return fail('out_of_range');
  return { ok: true, value };
}

function parseList<T>(raw: unknown, item: (entry: unknown) => T | null): Parsed<T[]> {
  if (!Array.isArray(raw)) return fail('not_a_list');
  if (raw.length > POLICY_MAX_LIST_ITEMS) return fail('too_many');
  const out: T[] = [];
  let dropped = 0;
  for (const entry of raw) {
    const parsed = item(entry);
    if (parsed === null) dropped += 1;
    else out.push(parsed);
  }
  return dropped ? { ok: true, value: out, dropped } : { ok: true, value: out };
}

/**
 * A raw value into what the app uses. The InstanceUrl needs to know whether http is
 * allowed: pass the resolved AllowInsecureInstance.
 */
export function parsePolicyValue(key: PolicyKey, raw: unknown, allowInsecure = false): Parsed<PolicyValues[PolicyKey]> {
  const definition = POLICY_SCHEMA[key];
  switch (definition.type) {
    case 'boolean':
      return parseBoolean(raw);
    case 'integer':
      return parseInteger(raw, definition.min, definition.max);
    case 'enum': {
      const allowed = typeof raw === 'string' && definition.values.some((option) => option.value === raw.trim());
      return allowed ? ({ ok: true, value: (raw as string).trim() } as Parsed<PolicyValues[PolicyKey]>) : fail('unknown_value');
    }
    case 'string':
      switch (definition.format) {
        case 'instanceUrl':
          return parseInstanceUrl(raw, allowInsecure);
        case 'shortcut':
          return parseShortcut(raw);
        case 'hostList':
          return parseHostList(raw);
        case 'nonce':
          return parseNonce(raw);
        case 'driveLetter':
          return parseDriveLetter(raw);
      }
      break;
    case 'list':
      switch (definition.item) {
        case 'server':
          return parseList(raw, parseServerPattern);
        case 'plugin':
          return parseList(raw, parsePluginId);
        case 'certificate':
          return parseList(raw, parseCertificateRule);
        case 'origin':
          return parseList(raw, parseHttpsOrigin);
      }
  }
  return fail('unknown_policy');
}

/** The strict side, for a forced value we can't read. Null where that's "not set". */
function failClosedValue(key: PolicyKey): PolicyValues[PolicyKey] {
  const definition = POLICY_SCHEMA[key];
  if (definition.type === 'boolean' || definition.type === 'enum') return definition.onInvalid as PolicyValues[PolicyKey];
  // A list nobody can read allows nothing.
  if (definition.type === 'list') return [] as PolicyValues[PolicyKey];
  // A shortcut nobody can read doesn't get the built-in one instead.
  if (definition.type === 'string' && definition.format === 'shortcut') return 'off' as PolicyValues[PolicyKey];
  // A drive letter nobody can read means no letter, not the user's own.
  if (definition.type === 'string' && definition.format === 'driveLetter') return 'none' as PolicyValues[PolicyKey];
  // A limit nobody can read is the tightest one, not the user's own.
  if (definition.type === 'integer') return (definition.onInvalid !== undefined ? definition.onInvalid : definition.min) as PolicyValues[PolicyKey];
  return definition.default as PolicyValues[PolicyKey];
}

function describeRaw(raw: unknown): string {
  let text: string;
  try {
    text = typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? String(raw));
  } catch {
    text = String(raw);
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

const ORDER: { layer: keyof PolicyLayers; source: PolicySource; locked: boolean }[] = [
  { layer: 'forcedMachine', source: 'forced-machine', locked: true },
  { layer: 'forcedUser', source: 'forced-user', locked: true },
  { layer: 'recommendedMachine', source: 'recommended-machine', locked: false },
  { layer: 'recommendedUser', source: 'recommended-user', locked: false },
];

function resolveEntry<K extends PolicyKey>(key: K, layers: PolicyLayers, allowInsecure: boolean): PolicyEntry<K> {
  const definition = POLICY_SCHEMA[key];
  for (const { layer, source, locked } of ORDER) {
    if (!locked && definition.forcedOnly) continue;
    if (!Object.prototype.hasOwnProperty.call(layers[layer], key)) continue;
    const raw = layers[layer][key];
    if (raw === undefined) continue;
    const parsed = parsePolicyValue(key, raw, allowInsecure);
    if (parsed.ok) {
      const entry = { value: parsed.value as PolicyValues[K], source, locked } as PolicyEntry<K>;
      if (parsed.dropped) entry.dropped = parsed.dropped;
      return entry;
    }
    // A recommendation we can't read is no recommendation. A forced value we can't
    // read still means the admin wanted something: it fails closed, and a weaker
    // layer never gets to speak instead.
    if (!locked) continue;
    // An empty nonce is someone clearing it, not a broken value.
    if (definition.type === 'string' && definition.format === 'nonce' && parsed.reason === 'empty') {
      return { value: null as PolicyValues[K], source: 'default', locked: false } as PolicyEntry<K>;
    }
    return { value: failClosedValue(key) as PolicyValues[K], source, locked, invalid: parsed.reason, raw: describeRaw(raw) } as PolicyEntry<K>;
  }
  return { value: definition.default as PolicyValues[K], source: 'default', locked: false } as PolicyEntry<K>;
}

/** Forced machine > forced user > (the user's choice) > recommended machine > recommended user > default. */
export function resolvePolicies(layers: PolicyLayers): PolicySnapshot {
  const insecure = resolveEntry('AllowInsecureInstance', layers, false).value;
  const snapshot = {} as Record<PolicyKey, PolicyEntry>;
  for (const key of POLICY_KEYS) snapshot[key] = resolveEntry(key, layers, insecure) as PolicyEntry;
  return snapshot as PolicySnapshot;
}

/**
 * The place of the user's own choice in the order: under anything forced, over any
 * recommendation. `undefined` and `null` mean they haven't chosen.
 */
export function effectivePolicyValue<T>(entry: { value: T; locked: boolean }, choice: T | null | undefined): T {
  if (entry.locked) return entry.value;
  return choice === undefined || choice === null ? entry.value : choice;
}

export const DEFAULT_POLICY_SNAPSHOT: PolicySnapshot = resolvePolicies(EMPTY_POLICY_LAYERS);

export interface PolicyProblem {
  key: PolicyKey;
  reason: string;
  raw?: string;
}

/** Forced values the app can't use, and lists with entries it had to leave out. */
export function policyProblems(snapshot: PolicySnapshot): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  for (const key of POLICY_KEYS) {
    const { invalid, dropped, raw } = snapshot[key];
    if (invalid) problems.push({ key, reason: invalid, ...(raw ? { raw } : {}) });
    else if (dropped) problems.push({ key, reason: 'entries_left_out' });
  }
  return problems;
}

/** What the webmail reads, in `lib/` and `components/`. A page gets nothing else. */
const PAGE_POLICY_KEYS: readonly PolicyKey[] = [
  'AllowStandalone',
  'AllowedJmapServers',
  'InstanceUrl',
  'PluginsMode',
  'PluginAllowlist',
  'OfflineEnabled',
  'AppLockRequired',
  'AppLockTimeoutMinutes',
  'CrashReportsAllowed',
];

/**
 * The policies as a page gets them. A page can be any server someone chose, and the auth
 * lists and certificate rules name an organisation's internal hosts, so those stay at their
 * defaults. Nor does it get a bad value's text, or a recommended server's address: a forced
 * one is the only server such a page can be on.
 */
export function pagePolicySnapshot(snapshot: PolicySnapshot): PolicySnapshot {
  const page = { ...DEFAULT_POLICY_SNAPSHOT } as Record<PolicyKey, PolicyEntry>;
  for (const key of PAGE_POLICY_KEYS) {
    const entry: PolicyEntry = { ...snapshot[key] };
    delete entry.raw;
    if (key === 'InstanceUrl' && !entry.locked) (entry as { value: unknown }).value = null;
    page[key] = entry;
  }
  return page as PolicySnapshot;
}

/**
 * Who acts on each key, so none can sit idle: the desktop repo's test and the webmail's
 * read the named file for the key. `pendingConsumer` names who still has to wire one.
 */
export type PolicyConsumer = { repo: 'shell' | 'webmail'; file: string } | { pendingConsumer: string };

export const POLICY_CONSUMERS: Record<PolicyKey, PolicyConsumer> = {
  InstanceUrl: { repo: 'shell', file: 'src/main/policy-start.ts' },
  AllowStandalone: { repo: 'shell', file: 'src/main/policy-start.ts' },
  AllowedJmapServers: { repo: 'shell', file: 'src/main/policy-start.ts' },
  AllowInsecureInstance: { repo: 'shell', file: 'src/main/policy-start.ts' },
  PluginsMode: { repo: 'webmail', file: 'lib/desktop/policy.ts' },
  PluginAllowlist: { repo: 'webmail', file: 'lib/desktop/policy.ts' },
  OfflineEnabled: { repo: 'webmail', file: 'lib/offline/scope.ts' },
  WipeOfflineData: { repo: 'shell', file: 'src/main/features/policies.ts' },
  AuthServerAllowlist: { repo: 'shell', file: 'src/main/features/policies.ts' },
  AuthNegotiateDelegateAllowlist: { repo: 'shell', file: 'src/main/features/policies.ts' },
  AutoUpdate: { repo: 'shell', file: 'src/main/update-rules.ts' },
  UpdateChannel: { repo: 'shell', file: 'src/main/update-rules.ts' },
  AppLockRequired: { repo: 'webmail', file: 'lib/app-lock/policy.ts' },
  AppLockTimeoutMinutes: { repo: 'webmail', file: 'lib/app-lock/policy.ts' },
  TelemetryAllowed: { repo: 'shell', file: 'src/main/features/privacy.ts' },
  CrashReportsAllowed: { repo: 'shell', file: 'src/main/features/privacy.ts' },
  QuickComposeShortcut: { repo: 'shell', file: 'src/main/features/os-quick-compose.ts' },
  AutoSelectCertificateForUrls: { repo: 'shell', file: 'src/main/features/client-certificates.ts' },
  KeystoreEnabled: { repo: 'shell', file: 'src/main/features/policies.ts' },
  KeystoreAllowedOrigins: { repo: 'shell', file: 'src/main/features/policies.ts' },
  BrowserSignIn: { repo: 'shell', file: 'src/main/features/browser-sign-in.ts' },
  OpenWithEnabled: { repo: 'shell', file: 'src/main/features/os-default-app.ts' },
  DeveloperToolsAvailability: { repo: 'shell', file: 'src/main/features/dev-tools.ts' },
  FilesDriveEnabled: { repo: 'shell', file: 'src/main/features/files-drive.ts' },
  FilesFolderSyncEnabled: { repo: 'shell', file: 'src/main/features/files-folders.ts' },
  FilesDriveLetter: { repo: 'shell', file: 'src/main/features/files-drive.ts' },
};

/** The part the embedded server enforces. Sent to it by message. */
export interface ServerPolicy {
  pluginsMode: PluginsMode;
  pluginAllowlist: string[];
  allowedJmapServers: string[] | null;
}

export function serverPolicyOf(snapshot: PolicySnapshot): ServerPolicy {
  return {
    pluginsMode: snapshot.PluginsMode.value,
    pluginAllowlist: snapshot.PluginAllowlist.value,
    allowedJmapServers: snapshot.AllowedJmapServers.value,
  };
}
