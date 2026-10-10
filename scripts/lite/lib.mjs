// Shared, side-effect-free helpers for the Lite build scripts. Kept separate
// so lib/__tests__/lite-scripts.test.ts can exercise them without touching
// the filesystem or spawning `next build`.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Repository root for a script under scripts/lite/. Falls back to the current
 * directory when `import.meta.url` is not a file URL (vitest's transform).
 */
export function resolveRepoRoot(metaUrl) {
  try {
    return resolve(fileURLToPath(new URL("../..", metaUrl)));
  } catch {
    return process.cwd();
  }
}

/** True when the module was started directly (`node scripts/lite/x.mjs`). */
export function isMainModule(metaUrl) {
  try {
    return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}

/** Server-only trees the static export cannot contain. */
export const LITE_REMOVED_PATHS = [
  "proxy.ts",
  "app/api",
  "app/(main)/admin",
  "app/(main)/setup",
  "app/(sandbox)",
  "app/manifest.ts",
  "instrumentation.ts",
  "instrumentation.node.ts",
  "app/(main)/[...rest]",
  "app/(main)/protocol",
  "e2e",
  "integration",
];

/** Test trees are pruned too: they import the routes removed above. */
export const LITE_TEST_DIR_NAME = "__tests__";
export const LITE_TEST_FILE_PATTERN = /\.test\.[cm]?[jt]sx?$/;
export const LITE_PRUNE_SKIP_DIRS = new Set(["node_modules", ".git", ".next", "out", "repos", "scripts"]);

/** The client shells a deployer's host must SPA-fallback to. */
export const LITE_SURFACES = ["mail", "calendar", "contacts", "files", "settings"];

/** Locales written right-to-left; the root shim sets `dir` for them. */
export const RTL_LOCALES = ["ar", "fa", "he"];

/**
 * sessionStorage key the 404 shim parks a deep link under. Mirrors
 * LITE_PENDING_PATH_KEY in lib/lite.ts (a TS module this script cannot
 * import); lib/__tests__/lite-scripts.test.ts pins the two together.
 */
export const LITE_PENDING_PATH_KEY = "bulwark-lite:pending-path";

/** zustand persist key of stores/locale-store.ts (the user's language choice). */
export const LOCALE_STORAGE_KEY = "locale-storage";

/**
 * `/api/` strings that legitimately survive in the Lite client chunks. Each
 * one is either gated at call time (`IS_LITE`, a policy flag, a config flag
 * the Lite config pins off) or tolerates a 404 by design. Anything else is a
 * new server dependency and fails `verify.mjs`.
 */
export const LITE_API_STRING_ALLOWLIST = [
  // Path-independent generic prefix used by `apiFetch` docs/comments.
  "/api/",
  // stores/update-store.ts - startPolling() is a no-op in Lite.
  "/api/system/update-status",
  // stores/plugin-store.ts + theme-store.ts - initializePlugins()/syncServerThemes() return early in Lite.
  "/api/plugins",
  "/api/plugin-approval-status",
  "/api/plugin-signing-pubkey",
  "/api/admin/plugins",
  "/api/admin/themes",
  // stores/settings-store.ts - settingsSyncEnabled is pinned off.
  "/api/settings",
  // Stalwart's own account discovery (lib/auth/lite-oauth.ts), not a route of this app.
  "/api/discover",
  // OAuth / SSO / pairing - Lite discovers and redeems codes in the browser
  // (lib/auth/lite-oauth.ts); stalwartFeaturesEnabled is pinned off.
  "/api/auth/token",
  "/api/auth/oauth/metadata",
  "/api/auth/sso/start",
  "/api/auth/sso/complete",
  "/api/auth/reauth/sso/complete",
  "/api/auth/pair/create",
  "/api/auth/pair/status",
  "/api/auth/totp-token-exchange",
  "/api/auth/session",
  "/api/auth/verify",
  "/api/auth/stalwart-context",
  "/api/account/stalwart/jmap",
  // Admin shield probe - skipped in Lite (components/layout/navigation-rail.tsx).
  "/api/admin/auth",
  // Settings/policy - replaced by config.json / policy.json.
  "/api/config",
  "/api/admin/policy",
  // lib/account-archive-client.ts - the feature is pinned off in Lite.
  "/api/account-archive",
  // WOPI (#425) - use-wopi-status returns disabled in Lite.
  "/api/wopi/status",
  "/api/wopi/launch",
  // Calendar: ICS URL import/subscriptions + CalDAV discovery are hidden in Lite.
  "/api/fetch-ical",
  "/api/caldav/discover",
  "/api/webdav",
  // Sender favicons - disabled in Lite (initials fallback).
  "/api/favicon",
  // Web push relay paths (relative to the *relay* origin, not this host).
  "/api/push/vapid-public-key",
  "/api/push/register",
  "/api/push/active",
  "/api/push/verify",
  "/api/push/jmap",
  // Dev-only JMAP mock.
  "/api/jmap",
  "/api/dev-jmap",
];

export function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function normalizeBasePath(raw) {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (!trimmed.startsWith("/")) throw new Error(`base path must start with "/" (got ${JSON.stringify(raw)})`);
  return trimmed;
}

/**
 * config.json contents from the LITE_* build inputs. The Stalwart target is
 * served by the mail server itself: an empty server URL means "this origin"
 * there, so the server field stays hidden unless a build asks for it.
 *
 * The static target leaves `allowCustomJmapEndpoint` out unless the build sets
 * it: the app then derives it from `jmapServerUrl` at runtime. Writing the
 * derived `true` of an empty server URL kept the server field on the login
 * page after a deployer filled in `jmapServerUrl` and nothing else (#1087).
 */
export function buildLiteConfig(env = {}, { target = "static" } = {}) {
  const jmapServerUrl = (env.LITE_JMAP_SERVER_URL ?? "").trim().replace(/\/+$/, "");
  const stalwart = target === "stalwart";
  const customEndpointSet = (env.LITE_ALLOW_CUSTOM_ENDPOINT ?? "") !== "";
  return {
    _comment: stalwart
      ? "Bulwark Lite for Stalwart. Read-only inside the Application bundle: to change it, build your own zip (see LITE-README.md). An empty jmapServerUrl means the Stalwart server that serves this page."
      : "Bulwark Lite runtime configuration. Edit and re-upload; no rebuild needed. See LITE-README.md.",
    appName: (env.LITE_APP_NAME ?? "").trim() || "Bulwark Webmail",
    jmapServerUrl,
    ...(stalwart || customEndpointSet
      ? { allowCustomJmapEndpoint: parseBool(env.LITE_ALLOW_CUSTOM_ENDPOINT, false) }
      : {}),
    rememberMeEnabled: parseBool(env.LITE_REMEMBER_ME, true),
    demoMode: parseBool(env.LITE_DEMO_MODE, false),
    loginShowTotp: true,
    loginShowVersion: true,
  };
}

/** policy.json: only the gates Lite must pin; the app merges the rest over its defaults. */
/**
 * What `/api/connector/capabilities` answers on a server build, as a file.
 *
 * Lite is a static export with no route handlers, so a connector probing this
 * instance gets this instead - same document, same meaning. The connector
 * tries the API path first and falls back to `/connector.json`.
 *
 * The target names are read out of lib/connector/registry.ts rather than
 * duplicated here: a list that drifts would have this build telling connectors
 * it can resolve links it cannot.
 */
export function buildConnectorCapabilities({ appName, version, basePath = "" }) {
  const source = readFileSync(
    join(resolveRepoRoot(import.meta.url), "lib", "connector", "registry.ts"),
    "utf8",
  );
  const targets = [...source.matchAll(/^\s{4}name: '([a-z0-9_]+)',$/gm)].map((m) => m[1]);
  if (targets.length === 0) {
    throw new Error("no connector targets found in lib/connector/registry.ts");
  }
  return (
    JSON.stringify(
      {
        product: "bulwark-webmail",
        appName: appName || "Bulwark",
        version: version || null,
        connectorPath: `${basePath || ""}/connector`,
        targets,
      },
      null,
      2,
    ) + "\n"
  );
}

export function buildLitePolicy() {
  return {
    _comment: "Optional admin policy for Bulwark Lite (same shape as the admin dashboard's policy). Plugins and sidebar apps stay off in Lite.",
    features: {
      pluginsEnabled: false,
      sidebarAppsEnabled: false,
    },
  };
}

export function buildManifest({ appName, basePath = "" }) {
  const p = (path) => `${basePath}${path}`;
  return {
    name: appName,
    short_name: appName,
    description: `${appName} - webmail for JMAP servers`,
    start_url: p("/"),
    scope: p("/"),
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: p("/icon-192x192.png"), sizes: "192x192", type: "image/png" },
      { src: p("/icon-512x512.png"), sizes: "512x512", type: "image/png" },
      { src: p("/icon-maskable-light-192x192.png"), sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: p("/icon-maskable-light-512x512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

/** Root index.html: pick the visitor's locale in the browser and jump to it. */
export function buildRootRedirect({ basePath = "", locales, defaultLocale = "en" }) {
  const list = JSON.stringify(locales);
  const fallback = locales.includes(defaultLocale) ? defaultLocale : locales[0];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>Loading</title>
<script>
(function () {
  var locales = ${list};
  var fallback = ${JSON.stringify(fallback)};
  var base = ${JSON.stringify(basePath)};
  function pick(tag) {
    if (!tag) return null;
    tag = String(tag);
    if (locales.indexOf(tag) !== -1) return tag;
    var lower = tag.toLowerCase();
    if (lower.indexOf("zh") === 0) {
      var traditional = /zh-(tw|hk|mo|hant)/.test(lower);
      if (traditional && locales.indexOf("zh-TW") !== -1) return "zh-TW";
      if (locales.indexOf("zh") !== -1) return "zh";
    }
    var short = lower.split("-")[0];
    for (var i = 0; i < locales.length; i++) if (locales[i].toLowerCase() === short) return locales[i];
    return null;
  }
  var chosen = null;
  // The language picked in Settings (stores/locale-store.ts) wins over the browser's list.
  try {
    var stored = JSON.parse(localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)}) || "null");
    chosen = pick(stored && stored.state && stored.state.locale);
  } catch (e) {}
  var langs = navigator.languages || [navigator.language];
  for (var j = 0; !chosen && j < langs.length; j++) chosen = pick(langs[j]);
  location.replace(base + "/" + (chosen || fallback) + "/" + location.search + location.hash);
})();
</script>
</head>
<body><noscript>This app needs JavaScript. <a href="${basePath}/${fallback}/">Continue</a></noscript></body>
</html>
`;
}

/**
 * 404.html for hosts without rewrite rules (GitHub Pages, S3 website hosting).
 *
 * `next build` exports Next's default not-found page as 404.html: the
 * `[...rest]` catch-all that renders app/(main)/not-found.tsx in the server
 * build is deleted for the export, and a route group's not-found.tsx only
 * serves `notFound()` calls inside that group. So the park-and-replay logic
 * lives in this dependency-free shim instead: a deep link below a known
 * surface is parked in sessionStorage and the surface shell is loaded, which
 * hands the link over (hooks/use-lite-link-segments.ts). Only `<locale>` and
 * `<surface>` from the allowlists ever reach `location.replace`, so a crafted
 * URL cannot turn this into an open redirect.
 */
export function buildNotFoundShim({ basePath = "", locales, surfaces = LITE_SURFACES }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>404</title>
<script>
(function () {
  var base = ${JSON.stringify(basePath)};
  var locales = ${JSON.stringify(locales)};
  var surfaces = ${JSON.stringify(surfaces)};
  var path = location.pathname;
  if (base) {
    if (path !== base && path.indexOf(base + "/") !== 0) return;
    path = path.slice(base.length) || "/";
  }
  var parts = path.split("/").filter(Boolean);
  if (parts.length < 2 || locales.indexOf(parts[0]) === -1 || surfaces.indexOf(parts[1]) === -1) return;
  var target = base + "/" + parts[0] + "/" + parts[1] + "/";
  // The shell itself is missing (host misconfigured): show the 404 instead of looping.
  if (location.pathname === target) return;
  try { sessionStorage.setItem(${JSON.stringify(LITE_PENDING_PATH_KEY)}, location.pathname + location.search); } catch (e) {}
  location.replace(target);
})();
</script>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif; background: #fff; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #0a0a0a; color: #ededed; } }
  main { text-align: center; padding: 1rem; }
  h1 { font-size: 2.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.5rem; opacity: .7; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>404</h1>
  <p>This page could not be found.</p>
  <a href="${basePath}/">Go home</a>
</main>
</body>
</html>
`;
}

/** Netlify / Cloudflare Pages rewrite rules. */
export function buildRedirects({ basePath = "", locales, surfaces = LITE_SURFACES }) {
  const lines = [
    "# Bulwark Lite SPA fallback (Netlify / Cloudflare Pages). Deep links below a",
    "# surface serve that surface's shell; everything else keeps its own file.",
  ];
  for (const locale of locales) {
    for (const surface of surfaces) {
      lines.push(`${basePath}/${locale}/${surface}/*  ${basePath}/${locale}/${surface}/index.html  200`);
    }
    // /<locale>/login etc. resolve directly; a bare locale root goes to mail.
  }
  return lines.join("\n") + "\n";
}

/** The Content-Security-Policy every static host should send (`_headers`, the container image). */
export function buildCsp({ connectSrc = "*" } = {}) {
  return [
    "default-src 'self'",
    // The static export ships inline hydration scripts, so no nonce is possible
    // and one header cannot list every page's hashes. Each page of the static
    // target carries its own <meta> policy that allows exactly its inline
    // scripts (withScriptHashCsp); both policies apply, so this only matters
    // where that meta is missing.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' https: data:",
    `connect-src 'self' ${connectSrc}`,
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "media-src 'self' blob:",
  ].join("; ");
}

/** The `'sha256-...'` source for every inline script in an HTML document. */
export function inlineScriptHashes(html) {
  const hashes = new Set();
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(attrs)) continue;
    // Data blocks (JSON, templates) never execute.
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && type !== "module" && !/^(text|application)\/(x-)?(java|ecma)script$/.test(type)) continue;
    // Browsers normalise newlines before the script text is hashed.
    const text = body.replace(/\r\n?/g, "\n");
    hashes.add(`'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`);
  }
  return [...hashes];
}

/**
 * The page-level policy of a static-target HTML file: its own inline scripts
 * and scripts from this origin, nothing else. Enforced together with the
 * host's header policy, it takes away the header's 'unsafe-inline'.
 */
export function buildScriptHashCsp(hashes) {
  return [`script-src 'self'${hashes.map((h) => ` ${h}`).join("")}`, "object-src 'none'", "base-uri 'self'"].join("; ");
}

/**
 * `html` with a <meta> CSP naming its inline script hashes, ahead of every
 * script: right after <meta charset> (which has to stay within the first
 * 1024 bytes), else as early in the document as possible.
 */
export function withScriptHashCsp(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${buildScriptHashCsp(inlineScriptHashes(html))}"/>`;
  // Without a <head> the parser still places a leading <meta> in the implied one.
  const anchor = /<meta\s+charset\s*=[^>]*>/i.exec(html) ?? /<head\b[^>]*>/i.exec(html)
    ?? /<html\b[^>]*>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);
  const at = anchor ? anchor.index + anchor[0].length : 0;
  return html.slice(0, at) + meta + html.slice(at);
}

/**
 * The policy of the Stalwart target's entry document. Stalwart sends no
 * security headers for an Application, so this <meta> is all there is. The
 * shells it writes in are rewritten for the mount at runtime, which rules
 * out build-time hashes; it still forbids plugins, eval, foreign scripts and
 * a moved <base>. frame-ancestors cannot be set from a <meta>: the entry
 * refuses to run in a frame of another origin instead.
 */
export function buildStalwartEntryCsp() {
  return buildCsp({ connectSrc: "*" })
    .split("; ")
    .filter((directive) => !directive.startsWith("frame-ancestors"))
    .join("; ");
}

/** Security headers for hosts that read a `_headers` file. */
export function buildHeaders({ basePath = "", connectSrc = "*" }) {
  const csp = buildCsp({ connectSrc });
  return `${basePath || ""}/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Content-Security-Policy: ${csp}
${basePath || ""}/_next/static/*
  Cache-Control: public, max-age=31536000, immutable
${basePath || ""}/connector.json
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=300
`;
}

/**
 * Where the unzipped folder has to live for the nginx/Caddy examples: every
 * rule below is root-relative, so a sub-path mount means the files sit in a
 * folder named after the mount path inside the web root (no `alias` needed,
 * which does not work inside a regex `location`).
 */
export function exampleDocRoot(basePath = "") {
  return { root: "/var/www/bulwark-lite", files: `/var/www/bulwark-lite${basePath}` };
}

export function buildNginxExample({ basePath = "", surfaces = LITE_SURFACES, connectSrc = "*" }) {
  const location = basePath ? `${basePath}/` : "/";
  const csp = buildCsp({ connectSrc });
  const { root, files } = exampleDocRoot(basePath);
  const surfaceAlternation = surfaces.join("|");
  return `# Bulwark Lite - nginx example. Unzip the archive into ${files}
# so that ${basePath}/index.html is served at ${location}; deep links below a surface
# are rewritten to that surface's shell.
server {
    listen 80;
    server_name webmail.example.com;
    root ${root};

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    # connect-src names the JMAP server this bundle was built for. Every page
    # also carries a <meta> policy that allows only its own inline scripts.
    add_header Content-Security-Policy "${csp}" always;

    # Hashed assets never change. (add_header inside a location replaces the
    # inherited set, so the security headers are repeated here.)
    location ${basePath}/_next/static/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header X-Content-Type-Options nosniff always;
        add_header X-Frame-Options DENY always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
        add_header Content-Security-Policy "${csp}" always;
    }

    # Older mime.types files do not know the PWA manifest extension.
    location = ${basePath}/manifest.webmanifest {
        types { }
        default_type application/manifest+json;
    }

    # /<locale>/<surface>/anything -> /<locale>/<surface>/index.html
    location ~ ^${basePath}/(?<locale>[a-zA-Z-]+)/(?<surface>${surfaceAlternation})(/.*)?$ {
        try_files $uri $uri/ $uri/index.html ${basePath}/$locale/$surface/index.html;
    }

    location ${location} {
        try_files $uri $uri/ $uri/index.html =404;
        error_page 404 ${basePath}/404.html;
    }
}
`;
}

/** Env var the container image substitutes into the CSP's connect-src. */
export const CONTAINER_CONNECT_SRC_ENV = "LITE_CSP_CONNECT_SRC";
/** Set by the image's entrypoint hook: the IPv6 `listen` line, or empty on hosts without IPv6. */
export const CONTAINER_LISTEN_IPV6_ENV = "LITE_LISTEN_IPV6";
export const CONTAINER_PORT = 8080;
/** Static-host helpers that mean nothing inside the image. */
export const CONTAINER_EXCLUDED_FILES = ["_redirects", "_headers", "nginx.conf.example", "Caddyfile.example", "LITE-README.md"];

/**
 * nginx config for the container image (Dockerfile.lite), as a template for
 * the nginx image's envsubst hook (/etc/nginx/templates/*.template): the same
 * routing as the nginx example, plus the full security headers - nginx does
 * not read `_headers` - with connect-src left to the deployer, because the
 * JMAP server is only known once config.json is mounted. Root mount only.
 */
export function buildNginxContainerTemplate({ surfaces = LITE_SURFACES } = {}) {
  const surfaceAlternation = surfaces.join("|");
  const csp = buildCsp({ connectSrc: `\${${CONTAINER_CONNECT_SRC_ENV}}` });
  // add_header inside a location replaces the inherited set, so every
  // location with headers of its own repeats these.
  const securityHeaders = (indent) => [
    "add_header X-Content-Type-Options nosniff always;",
    "add_header X-Frame-Options DENY always;",
    "add_header Referrer-Policy strict-origin-when-cross-origin always;",
    'add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;',
    `add_header Content-Security-Policy "${csp}" always;`,
  ].map((line) => indent + line).join("\n");
  return `# Bulwark Lite - nginx config of the container image. Generated by
# scripts/lite/container.mjs; the ${CONTAINER_CONNECT_SRC_ENV} and ${CONTAINER_LISTEN_IPV6_ENV} placeholders
# are filled in when the container starts.
server {
    listen ${CONTAINER_PORT};
    \${${CONTAINER_LISTEN_IPV6_ENV}}
    server_name _;
    root /usr/share/nginx/html;

    server_tokens off;
    # The published port rarely is ${CONTAINER_PORT}: never put it into a redirect.
    absolute_redirect off;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/css text/plain application/javascript application/json application/manifest+json image/svg+xml;

${securityHeaders("    ")}
    # Shells, config.json and policy.json are revalidated, so an image update
    # or an edited mount shows up on the next load.
    add_header Cache-Control "no-cache" always;

    # Hashed assets never change.
    location /_next/static/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
${securityHeaders("        ")}
    }

    # Older mime.types files do not know the PWA manifest extension.
    location = /manifest.webmanifest {
        types { }
        default_type application/manifest+json;
    }

    # Connectors probe this cross-origin.
    location = /connector.json {
        add_header Access-Control-Allow-Origin "*" always;
        add_header Cache-Control "public, max-age=300" always;
${securityHeaders("        ")}
    }

    # /<locale>/<surface>/anything -> /<locale>/<surface>/index.html
    location ~ ^/(?<locale>[a-zA-Z-]+)/(?<surface>${surfaceAlternation})(/.*)?$ {
        try_files $uri $uri/ $uri/index.html /$locale/$surface/index.html;
    }

    location / {
        try_files $uri $uri/ $uri/index.html =404;
        error_page 404 /404.html;
    }
}
`;
}

export function buildCaddyExample({ basePath = "", surfaces = LITE_SURFACES, connectSrc = "*" }) {
  const { root, files } = exampleDocRoot(basePath);
  const csp = buildCsp({ connectSrc });
  const surfaceAlternation = surfaces.join("|");
  return `# Bulwark Lite - Caddy example. Unzip the archive into ${files}
# so that ${basePath}/index.html is served at ${basePath || ""}/.
webmail.example.com {
    root * ${root}
    encode gzip

    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
        # connect-src names the JMAP server this bundle was built for.
        Content-Security-Policy "${csp}"
    }

    @manifest path ${basePath}/manifest.webmanifest
    header @manifest Content-Type application/manifest+json

    # /<locale>/<surface>/anything -> /<locale>/<surface>/index.html
    @surface path_regexp surface ^${basePath}/([a-zA-Z-]+)/(${surfaceAlternation})(/.*)?$
    handle @surface {
        try_files {path} {path}/ {path}/index.html ${basePath}/{re.surface.1}/{re.surface.2}/index.html
    }

    handle {
        try_files {path} {path}/ {path}/index.html
    }

    file_server

    # Anything else is a real 404, answered by the shim that replays parked deep links.
    handle_errors {
        @notfound expression {http.error.status_code} == 404
        rewrite @notfound ${basePath}/404.html
        file_server
    }
}
`;
}

export function buildReadme({ version, commit, basePath = "", locales, jmapServerUrl = "", demoMode = false }) {
  return `# Bulwark Lite ${version} (${commit})

A static build of Bulwark Webmail: the same mail, calendar, contacts and files
client, without the Node.js server. Upload this folder to any static host and
point it at your Stalwart (or other JMAP) server.

Built for mount path: ${basePath || "/ (site root)"}
Locales included: ${locales.join(", ")}
${demoMode ? "Demo mode is ON: the login page offers a built-in demo account and no server is needed.\n" : ""}
## Three steps

1. Unzip this archive and upload the whole folder to your web host, so that
   \`${basePath || ""}/index.html\` and \`${basePath || ""}/config.json\` are served from the mount path above.
2. Edit \`config.json\`:
   - \`jmapServerUrl\`: your mail server, e.g. \`https://mail.example.com\`${jmapServerUrl ? ` (currently \`${jmapServerUrl}\`)` : ""}.
   - \`appName\`: the name shown in the tab and on the login page.
   - \`allowCustomJmapEndpoint\` (optional): \`true\` always shows a server field
     on the login page, \`false\` never does. Left out, the field shows only
     while \`jmapServerUrl\` is empty.
   - \`rememberMeEnabled\`: \`false\` hides "remember me" (sessions then end with the tab).
   Optional keys: \`demoMode\`, \`jmapServers\`, \`jmapServerAutoPickByDomain\`, the login logo/company/link keys and \`loginShow*\` toggles (same names as the Docker env vars, camelCased).
3. Allow the browser to talk to the mail server (CORS). In Stalwart:

   \`\`\`toml
   [http]
   permissive-cors = true
   \`\`\`

   or an equivalent reverse-proxy rule that allows your Lite origin with the
   \`Authorization\` and \`Content-Type\` headers on \`/.well-known/jmap\`, \`/jmap/*\`,
   \`/api/auth\` and \`/auth/token\`.

## Host configuration

Deep links such as \`${basePath}/en/mail/thread/abc\` are served by the shell at
\`${basePath}/en/mail/index.html\`. Configure your host to fall back to it:

- Netlify / Cloudflare Pages: the shipped \`_redirects\` and \`_headers\` files do this.
- nginx: see \`nginx.conf.example\`.
- Caddy: see \`Caddyfile.example\`.
${basePath ? `  Both examples serve root-relative paths, so unzip into \`<web root>${basePath}\`\n  (e.g. \`${exampleDocRoot(basePath).files}\`), not into the web root itself.\n` : ""}- GitHub Pages and other hosts without rewrites: \`404.html\` replays the link
  in the browser. It works, with one extra page load.

\`_headers\` also carries the recommended security headers. Adjust
\`connect-src\` to your JMAP server's origin if you prefer a strict policy.

## What is different from the full Bulwark Webmail

Everything that runs in the browser works: mail, threads, search, compose,
multiple accounts, calendar, contacts, files, themes, settings export/import,
password and TOTP login, demo mode, deep links.

Not available in Lite (they need the Node.js server): the admin console and
setup wizard, plugins and sidebar apps, settings sync across devices, OAuth /
SSO login, the account security tab (app passwords, 2FA setup), ICS URL
subscriptions and CalDAV discovery, sender favicons, office (WOPI) editing,
web push notifications, the update banner, device pairing, and the
"Default apps" page (registering Lite as the mailto:/webcal: handler).

## Security notes

- No cookies and no server session. Requests to the mail server carry the
  token or credentials of the signed-in account only.
- "Remember me" keeps a Stalwart refresh token in the browser's localStorage
  (a plain token, never the password). Without "remember me" the token lives
  in sessionStorage and the session ends with the tab. Both are readable by
  any script running on your Lite origin, so serve Lite from an origin you
  control and keep the Content-Security-Policy from \`_headers\`.
- Servers without Stalwart's token login (\`/api/auth\`) fall back to Basic
  auth. "Remember me" is then hidden; the credentials stay in sessionStorage
  for the lifetime of the tab so a reload does not sign you out. The same
  fallback applies when a reverse proxy in front of Stalwart answers
  \`/api/auth\` without CORS headers: the login still works, but "remember me"
  then only lasts for the tab, so add the CORS rule from step 3 there too.
- Because the export contains inline scripts, \`script-src\` must allow
  \`'unsafe-inline'\`. Email HTML is still rendered sanitised in a sandboxed
  frame, exactly as in the full build.
`;
}

/** Locales actually present in the export (dirs that hold a mail shell). */
export function discoverBuiltLocales(outDir) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((name) => {
      const dir = join(outDir, name);
      return statSync(dir).isDirectory() && existsSync(join(dir, "mail", "index.html"));
    })
    .sort();
}

/** Every `"/api/...` string literal found in the client chunks, deduplicated. */
export function collectApiStrings(chunksDir) {
  const found = new Set();
  if (!existsSync(chunksDir)) return [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".js")) {
        const text = readFileSync(full, "utf8");
        for (const match of text.matchAll(/["'`](\/api\/[A-Za-z0-9/_-]*)/g)) found.add(match[1]);
      }
    }
  };
  walk(chunksDir);
  return [...found].sort();
}

export function unexpectedApiStrings(strings, allowlist = LITE_API_STRING_ALLOWLIST) {
  return strings.filter((s) => !allowlist.some((allowed) => s === allowed || s.startsWith(`${allowed}/`) || (allowed.endsWith("/") && s === allowed.slice(0, -1))));
}

// ---------------------------------------------------------------------------
// Stalwart `Application` target (`npm run build:lite -- --target=stalwart`)
// ---------------------------------------------------------------------------
//
// Stalwart 0.16 downloads a zip from the Application's `resourceUrl` and
// serves it under `urlPrefix` (crates/common/src/manager/application.rs,
// crates/http/src/request.rs). The rules that shape this target:
//
//   - lookup is an exact match of the path after `/<prefix>/` against a zip
//     entry name; everything else (directories, deep links, typos) gets the
//     root index.html - there is no directory index and no 404;
//   - only that root index.html is rewritten (`<base href="/"` -> the prefix,
//     `<meta name="oauth-client-id" content=""` -> the Application's client
//     id) and sent `no-cache`; every other entry is `immutable` for a year;
//   - content types come from a fixed extension map (below), the rest is
//     application/octet-stream;
//   - the bundle is same-origin with /jmap, /api/auth and /auth/token.

export const LITE_TARGETS = ["static", "stalwart"];

/** `--target=stalwart` (or `--target stalwart`) wins over LITE_TARGET. */
export function parseLiteTarget(argv = [], env = {}) {
  let value = env.LITE_TARGET;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--target=")) value = argv[i].slice("--target=".length);
    else if (argv[i] === "--target" && argv[i + 1]) value = argv[i + 1];
  }
  const target = (value ?? "").trim().toLowerCase() || "static";
  if (!LITE_TARGETS.includes(target)) throw new Error(`unknown Lite target ${JSON.stringify(value)} (expected ${LITE_TARGETS.join(" or ")})`);
  return target;
}

/**
 * Release asset name. It carries no version, so `releases/latest/download/<this>`
 * exists too, but the README points `resourceUrl` at a tagged release.
 */
export const STALWART_ZIP_NAME = "bulwark-lite-stalwart.zip";

/** The mount prefix the docs and the one-line install use. */
export const STALWART_DEFAULT_PREFIX = "/webmail";

/**
 * First path segments Stalwart routes itself before it ever looks at an
 * Application (crates/http/src/request.rs, 0.16.22), plus the WebUI's own
 * default Applications. An Application mounted at one of these is
 * unreachable (`mail` and `calendar` included: Stalwart answers
 * /mail/config-v1.1.xml and /calendar/rsvp and 404s everything else there).
 */
export const STALWART_RESERVED_SEGMENTS = [
  "jmap", "dav", ".well-known", "auth", "scim", "api", "mail", "calendar",
  "autodiscover", "robots.txt", "healthz", "metrics", "logo", "form", "login", "device",
  "admin", "account",
];

/** Case-insensitive for autodiscover, which Stalwart matches in three spellings. */
export function isReservedStalwartSegment(segment) {
  const s = String(segment ?? "");
  return STALWART_RESERVED_SEGMENTS.includes(s) || s.toLowerCase() === "autodiscover";
}

/** Problems with an admin-chosen `urlPrefix` (empty list = fine). */
export function stalwartPrefixProblems(prefix) {
  const raw = String(prefix ?? "");
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return ["the prefix is empty (Stalwart needs one path segment, e.g. /webmail)"];
  if (trimmed.includes("/")) return [`${raw} has more than one segment; Stalwart matches the first segment only`];
  if (!/^[A-Za-z0-9._~-]+$/.test(trimmed)) return [`${raw} contains characters outside [A-Za-z0-9._~-]`];
  if (isReservedStalwartSegment(trimmed)) return [`/${trimmed} is routed by Stalwart itself and would never reach the Application`];
  return [];
}

/** Stalwart's extension -> content type map (application.rs). No charset. */
export const STALWART_CONTENT_TYPES = {
  html: "text/html",
  css: "text/css",
  wasm: "application/wasm",
  js: "application/javascript",
  json: "application/json",
  png: "image/png",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

export function stalwartContentType(name) {
  const text = String(name);
  const at = text.lastIndexOf(".");
  const ext = at === -1 ? "" : text.slice(at + 1);
  return STALWART_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** Stalwart refuses bundles above this (MAX_APP_SIZE, compressed). */
export const STALWART_MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
/** verify.mjs fails the build above this, leaving headroom for growth. */
export const STALWART_SAFE_BUNDLE_BYTES = 90 * 1024 * 1024;

/** The two literals Stalwart replaces in the root index.html. */
export const STALWART_BASE_HREF_LITERAL = '<base href="/"';
export const STALWART_OAUTH_META_LITERAL = '<meta name="oauth-client-id" content=""';
/** Marks the entry document so it never writes itself into the page. */
export const STALWART_ENTRY_MARKER = "data-bulwark-lite-entry";

/** Files of the static-host target that make no sense inside a Stalwart bundle. */
export const STALWART_EXCLUDED_FILES = ["404.html", "_redirects", "_headers", "nginx.conf.example", "Caddyfile.example", "manifest.webmanifest"];
export const STALWART_EXCLUDED_DIRS = ["404"];

/** A build id that changes with every build: version, commit, build time. */
export function makeBuildId({ version = "0.0.0", commit = "local", now = Date.now() } = {}) {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9.-]/g, "");
  return `${safe(version)}-${safe(commit).slice(0, 7) || "local"}-${Math.floor(now / 1000).toString(36)}`;
}

/**
 * Directories below `<outDir>/<locale>/` that hold an index.html: the shells
 * the entry can boot ('' is the locale root, i.e. the mail client).
 */
export function discoverShellDirs(outDir, locale) {
  const root = join(outDir, locale);
  const found = [];
  const walk = (dir, rel) => {
    if (existsSync(join(dir, "index.html"))) found.push(rel);
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith("__next") || entry.startsWith("_")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, rel ? `${rel}/${entry}` : entry);
    }
  };
  if (existsSync(root)) walk(root, "");
  return found.sort();
}

/*
 * The three functions below run in the browser: buildStalwartEntry embeds
 * them with Function#toString, and lib/__tests__/lite-scripts.test.ts tests
 * the very same code. Keep them self-contained (no imports, no module scope).
 */

/**
 * Which shell to boot for `pathname` under `mount`. Returns
 * `{ locale, shell, canonical }`: `shell` is the zip entry to fetch
 * (`en/calendar/index.html`), `canonical` a URL to `replaceState` to first
 * (no locale in the address, or a path no shell owns) or null to keep the
 * address. Returns null when `pathname` is not below `mount`.
 */
export function resolveStalwartBoot(pathname, mount, locales, shells, preferredLocale) {
  var rest = pathname;
  if (mount) {
    if (rest !== mount && rest.indexOf(mount + "/") !== 0) return null;
    rest = rest.slice(mount.length) || "/";
  }
  var parts = rest.split("/").filter(function (p) { return p.length > 0; });
  var locale = locales.indexOf(parts[0]) !== -1 ? parts[0] : null;
  if (!locale) {
    // The OAuth redirect URI (lib/auth/lite-oauth.ts) names no locale, so one
    // registration covers every language: boot the callback in the preferred
    // one. The entry keeps the query string, which holds the code.
    if (parts.length === 2 && parts[0] === "oauth" && parts[1] === "callback" && shells.indexOf("auth/callback") !== -1) {
      return { locale: preferredLocale, shell: preferredLocale + "/auth/callback/index.html", canonical: mount + "/" + preferredLocale + "/auth/callback/" };
    }
    return { locale: preferredLocale, shell: preferredLocale + "/index.html", canonical: mount + "/" + preferredLocale + "/" };
  }
  var best = null;
  for (var i = 0; i < shells.length; i++) {
    var dir = shells[i];
    if (!dir) continue;
    var segs = dir.split("/");
    var match = true;
    for (var j = 0; j < segs.length; j++) if (parts[1 + j] !== segs[j]) { match = false; break; }
    if (match && (!best || segs.length > best.split("/").length)) best = dir;
  }
  if (best) return { locale: locale, shell: locale + "/" + best + "/index.html", canonical: null };
  if (parts.length === 1) return { locale: locale, shell: locale + "/index.html", canonical: null };
  return { locale: locale, shell: locale + "/index.html", canonical: mount + "/" + locale + "/" };
}

/**
 * Points a prerendered shell at the runtime mount. Next wrote root-absolute
 * URLs (`/_next/...`, the manifest, the favicon) into the HTML and into the
 * inline RSC payload; both spellings (`"/_next/` and `\"/_next/`) contain
 * `"/_next/`, so one split/join covers them. `bootScript` goes first into
 * <head> so the globals exist before any chunk runs.
 */
export function rewriteShellForMount(html, mount, buildId, bootScript) {
  // The needles are assembled so the entry itself holds no root-absolute
  // literal (verify.mjs checks for them).
  var q = '"';
  var out = html
    .split(q + "/_next/").join(q + mount + "/_next/")
    .split(q + "/manifest.webmanifest" + q).join(q + mount + "/manifest.json?v=" + encodeURIComponent(buildId) + q)
    .split(q + "/branding/").join(q + mount + "/branding/");
  var at = out.indexOf("<head>");
  return at === -1 ? bootScript + out : out.slice(0, at + 6) + bootScript + out.slice(at + 6);
}

/**
 * The same mount rewrite for a prerendered RSC payload (`*.txt`), which the
 * router fetches on client-side navigation and whose module rows name their
 * chunks as `/_next/static/chunks/...` (Turbopack loads those URLs as they
 * are). Rows are `<id>:<json>\n`, except `<id>:T<hex byte length>,<text>`
 * rows, which are length-prefixed and copied untouched so the lengths stay
 * right (verify.mjs checks that no text row ever holds one of the needles).
 */
export function rewriteFlightForMount(text, mount, buildId) {
  var q = '"';
  function fix(part) {
    return part
      .split(q + "/_next/").join(q + mount + "/_next/")
      .split(q + "/manifest.webmanifest" + q).join(q + mount + "/manifest.json?v=" + encodeURIComponent(buildId) + q)
      .split(q + "/branding/").join(q + mount + "/branding/");
  }
  var out = "";
  var i = 0;
  var n = text.length;
  while (i < n) {
    var colon = text.indexOf(":", i);
    var newline = text.indexOf("\n", i);
    if (colon !== -1 && (newline === -1 || colon < newline) && /^[0-9a-f]*$/.test(text.slice(i, colon)) && text.charAt(colon + 1) === "T") {
      var comma = text.indexOf(",", colon);
      var bytes = comma === -1 ? NaN : parseInt(text.slice(colon + 2, comma), 16);
      if (!(bytes >= 0)) {
        out += text.slice(i);
        break;
      }
      var j = comma + 1;
      var seen = 0;
      while (j < n && seen < bytes) {
        var code = text.charCodeAt(j);
        if (code < 0x80) seen += 1;
        else if (code < 0x800) seen += 2;
        else if (code >= 0xd800 && code <= 0xdbff) { seen += 4; j++; }
        else seen += 3;
        j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    var end = newline === -1 ? n : newline + 1;
    out += fix(text.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * Makes Next's client-side navigation work on Stalwart. For RSC payloads
 * (same origin, below the mount, `.txt`):
 *
 *  - Stalwart labels them application/octet-stream, and Next's router only
 *    accepts text/plain: anything else turns every navigation into a full
 *    page load. They are relabeled.
 *  - their chunk URLs are pointed at the mount (`rewriteFlight`).
 *
 * HTML (Stalwart's answer for a payload the bundle lacks) and everything
 * else pass through untouched.
 */
export function installStalwartFetchShim(win, mount, buildId, rewriteFlight) {
  if (!win || !win.fetch || win.__bulwarkLiteFetchShim) return;
  var original = win.fetch;
  win.__bulwarkLiteFetchShim = true;
  win.fetch = function () {
    return original.apply(this, arguments).then(function (res) {
      var url;
      try {
        var type = res.headers.get("content-type") || "";
        if (type.indexOf("application/octet-stream") !== 0 && type.indexOf("text/plain") !== 0) return res;
        url = new URL(res.url);
        if (url.origin !== win.location.origin || !/\.txt$/.test(url.pathname)) return res;
        if (mount && url.pathname.indexOf(mount + "/") !== 0) return res;
      } catch {
        return res;
      }
      return res.text().then(function (body) {
        var headers = new Headers(res.headers);
        headers.set("content-type", "text/plain; charset=utf-8");
        headers.delete("content-length");
        var relabeled = new Response(rewriteFlight(body, mount, buildId), { status: res.status, statusText: res.statusText, headers: headers });
        Object.defineProperty(relabeled, "url", { value: res.url });
        Object.defineProperty(relabeled, "redirected", { value: res.redirected });
        return relabeled;
      });
    });
  };
}

// Built from char codes: the literal escapes would be unescaped by editors and tools.
const BACKSLASH = String.fromCharCode(92);
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), "g");
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), "g");

/** Serialises a value for an inline <script> (no `</script>` breakout). */
export function inlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, BACKSLASH + "u003c")
    .replace(LINE_SEPARATOR, BACKSLASH + "u2028")
    .replace(PARAGRAPH_SEPARATOR, BACKSLASH + "u2029");
}

/**
 * The root index.html of the Stalwart bundle, the only document Stalwart
 * ever serves for a route. It reads the mount from the rewritten
 * `<base href>` and the client id from the rewritten meta tag, fetches the
 * matching prerendered shell (build-id URL, since shells are cached
 * immutably), points it at the mount and writes it into the page in place:
 * the address bar keeps the deep link and the shell hydrates exactly as it
 * would behind an nginx SPA fallback.
 */
export function buildStalwartEntry({ locales, shells, defaultLocale = "en", buildId, appName = "Bulwark Webmail" }) {
  const fallback = locales.includes(defaultLocale) ? defaultLocale : locales[0];
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const script = `
(function () {
  var BUILD_ID = ${inlineJson(buildId)};
  var LOCALES = ${inlineJson(locales)};
  var SHELLS = ${inlineJson(shells)};
  var FALLBACK = ${inlineJson(fallback)};
  var MOUNT_GLOBAL = "__BULWARK_LITE_MOUNT__";
  var CLIENT_ID_GLOBAL = "__BULWARK_LITE_OAUTH_CLIENT_ID__";
  var ENTRY_MARKER = ${inlineJson(STALWART_ENTRY_MARKER)};
  var resolveStalwartBoot = ${resolveStalwartBoot.toString()};
  var rewriteShellForMount = ${rewriteShellForMount.toString()};
  var rewriteFlightForMount = ${rewriteFlightForMount.toString()};
  var installStalwartFetchShim = ${installStalwartFetchShim.toString()};

  try {
    var theme = JSON.parse(localStorage.getItem("theme-storage") || "null");
    var chosen = theme && theme.state && theme.state.theme;
    if (chosen === "dark" || chosen === "light") document.documentElement.className = chosen;
  } catch (e) {}

  // Stalwart sends no X-Frame-Options or frame-ancestors for an Application:
  // inside another origin's frame the app would be open to clickjacking.
  var foreignFrame = false;
  try { foreignFrame = window.top !== window.self && window.top.location.origin !== location.origin; } catch (e) { foreignFrame = true; }
  if (foreignFrame) return fail("Bulwark Webmail cannot be shown inside another site's page. Open it directly.");

  function fail(message) {
    function show() {
      var box = document.getElementById("bulwark-lite-boot");
      if (!box) return;
      var p = document.createElement("p");
      p.textContent = message;
      box.innerHTML = "";
      box.appendChild(p);
      box.removeAttribute("aria-busy");
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", show); else show();
  }

  function pick(tag) {
    if (!tag) return null;
    tag = String(tag);
    if (LOCALES.indexOf(tag) !== -1) return tag;
    var lower = tag.toLowerCase();
    if (lower.indexOf("zh") === 0) {
      if (/zh-(tw|hk|mo|hant)/.test(lower) && LOCALES.indexOf("zh-TW") !== -1) return "zh-TW";
      if (LOCALES.indexOf("zh") !== -1) return "zh";
    }
    var short = lower.split("-")[0];
    for (var i = 0; i < LOCALES.length; i++) if (LOCALES[i].toLowerCase() === short) return LOCALES[i];
    return null;
  }
  var preferred = null;
  try {
    var stored = JSON.parse(localStorage.getItem(${inlineJson(LOCALE_STORAGE_KEY)}) || "null");
    preferred = pick(stored && stored.state && stored.state.locale);
  } catch (e) {}
  var langs = navigator.languages || [navigator.language];
  for (var j = 0; !preferred && j < langs.length; j++) preferred = pick(langs[j]);
  preferred = preferred || FALLBACK;

  // Stalwart rewrote the base element to point at the Application's prefix.
  var mount = new URL(document.baseURI).pathname.replace(/[/]+$/, "");
  if (!/^([/][A-Za-z0-9._~-]+)?$/.test(mount)) {
    return fail("Bulwark Webmail cannot run under " + mount + "/: the mount prefix must be a single path segment such as /webmail.");
  }
  var metaTag = document.querySelector('meta[name="oauth-client-id"]');
  var clientId = (metaTag && metaTag.getAttribute("content")) || "";
  var boot = resolveStalwartBoot(location.pathname, mount, LOCALES, SHELLS, preferred);
  if (!boot) {
    return fail("This page was opened at " + location.pathname + ", but the bundle is mounted at " + (mount || "/") + ".");
  }
  if (boot.canonical) {
    try { history.replaceState(history.state, "", boot.canonical + location.search + location.hash); } catch (e) {}
  }

  window[MOUNT_GLOBAL] = mount;
  window[CLIENT_ID_GLOBAL] = clientId;
  window.TURBOPACK_CHUNK_BASE_PATH = mount + "/_next/";
  installStalwartFetchShim(window, mount, BUILD_ID, rewriteFlightForMount);

  // Repeated inside the written shell, in case a browser gives it a fresh global.
  var bootScript = "<scr" + "ipt>(function(w){w[" + JSON.stringify(MOUNT_GLOBAL) + "]=" + JSON.stringify(mount) +
    ";w[" + JSON.stringify(CLIENT_ID_GLOBAL) + "]=" + JSON.stringify(clientId).replace(/</g, "\\\\u003c") +
    ";w.TURBOPACK_CHUNK_BASE_PATH=" + JSON.stringify(mount + "/_next/") +
    ";(" + installStalwartFetchShim.toString() + ")(w," + JSON.stringify(mount) + "," + JSON.stringify(BUILD_ID) + "," + rewriteFlightForMount.toString() + ");})(window)</scr" + "ipt>";

  fetch(mount + "/" + boot.shell + "?v=" + encodeURIComponent(BUILD_ID), { credentials: "same-origin" })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    })
    .then(function (html) {
      // A shell missing from the zip is answered with this very document.
      if (html.indexOf(ENTRY_MARKER) !== -1) throw new Error(boot.shell + " is not part of this bundle");
      var page = rewriteShellForMount(html, mount, BUILD_ID, bootScript);
      document.open();
      document.write(page);
      document.close();
    })
    .catch(function (err) {
      fail("Bulwark Webmail could not start (" + (err && err.message ? err.message : err) + "). Reload the page; if this keeps happening, the installed bundle may be incomplete.");
    });
})();
`;
  return `<!doctype html>
<html lang="en" ${STALWART_ENTRY_MARKER}="">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${buildStalwartEntryCsp()}" />
${STALWART_BASE_HREF_LITERAL} />
${STALWART_OAUTH_META_LITERAL} />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<title>${esc(appName)}</title>
<style>
  html, body { margin: 0; min-height: 100vh; background: #fff; color: #111; font-family: system-ui, sans-serif; }
  html.dark, html.dark body { background: #0a0a0a; color: #ededed; }
  @media (prefers-color-scheme: dark) { html:not(.light), html:not(.light) body { background: #0a0a0a; color: #ededed; } }
  #bulwark-lite-boot { display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 1rem; box-sizing: border-box; text-align: center; }
  #bulwark-lite-boot p { max-width: 36rem; opacity: .8; line-height: 1.5; }
</style>
<script>${script}</script>
</head>
<body>
<div id="bulwark-lite-boot" aria-busy="true"><noscript><p>Bulwark Webmail needs JavaScript.</p></noscript></div>
</body>
</html>
`;
}

/** manifest.json with relative URLs: they resolve against the manifest's own (mounted) URL. */
export function buildStalwartManifest({ appName }) {
  return {
    name: appName,
    short_name: appName,
    description: `${appName} - webmail for Stalwart`,
    start_url: "./",
    scope: "./",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "icon-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "icon-512x512.png", sizes: "512x512", type: "image/png" },
      { src: "icon-maskable-light-192x192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "icon-maskable-light-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

/** Problems with the root index.html of a Stalwart bundle (empty = fine). */
export function stalwartEntryProblems(html) {
  const problems = [];
  const count = (needle) => html.split(needle).length - 1;
  if (count(STALWART_BASE_HREF_LITERAL) !== 1) problems.push(`index.html must contain ${STALWART_BASE_HREF_LITERAL} exactly once (found ${count(STALWART_BASE_HREF_LITERAL)})`);
  if (count(STALWART_OAUTH_META_LITERAL) !== 1) problems.push(`index.html must contain ${STALWART_OAUTH_META_LITERAL} exactly once (found ${count(STALWART_OAUTH_META_LITERAL)})`);
  if (!html.includes(STALWART_ENTRY_MARKER)) problems.push("index.html is not the Stalwart entry document");
  // Root-absolute URLs would escape the mount prefix Stalwart put into <base>.
  for (const attr of html.replace(STALWART_BASE_HREF_LITERAL, "").match(/\b(?:src|href)="\/(?!\/)[^"]*"/g) ?? []) {
    problems.push(`index.html has a root-absolute ${attr}; it must follow the runtime mount`);
  }
  for (const absolute of ['"/_next/static', '"/config.json', '"/policy.json']) {
    if (html.includes(absolute)) problems.push(`index.html references ${absolute.slice(1)} absolutely; it must follow the runtime mount`);
  }
  return problems;
}

/** Problems with the entry list of a Stalwart zip (empty = fine). */
export function stalwartZipEntryProblems(names) {
  const problems = [];
  if (!names.includes("index.html")) problems.push("index.html is not at the archive root (no wrapping folder allowed)");
  if (names.length >= 0xffff) problems.push(`${names.length} entries need ZIP64, which this writer does not produce`);
  const reserved = new Set();
  for (const name of names) {
    const first = name.split("/")[0];
    if (isReservedStalwartSegment(first)) reserved.add(first);
    if (STALWART_EXCLUDED_FILES.includes(name) || (name.includes("/") && STALWART_EXCLUDED_DIRS.includes(first))) {
      problems.push(`${name} belongs to the static-host target and must not ship in the Stalwart bundle`);
    }
    if (name.includes("\\") || name.startsWith("/") || name.split("/").includes("..")) problems.push(`unsafe entry name ${JSON.stringify(name)}`);
  }
  for (const first of reserved) problems.push(`top-level entry ${first} shares its name with a Stalwart route; keep top-level names app-specific`);
  return problems;
}

// --- zip ---------------------------------------------------------------------

function dosDateTime(date) {
  const d = new Date(date);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Minimal zip writer (no dependencies, no ZIP64): deflate when it helps,
 * store otherwise, UTF-8 names, entries in the given order, a fixed
 * timestamp so identical inputs give identical archives.
 */
export function buildZip(entries, { date = new Date(2000, 0, 1) } = {}) {
  const { time, day } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const crc = crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

/** Reads a zip's central directory: `[{ name, method, compressedSize, size, offset }]`. */
export function listZipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("not a zip archive (no end-of-central-directory record)");
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("corrupt central directory");
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    entries.push({
      name: buffer.toString("utf8", at + 46, at + 46 + nameLen),
      method: buffer.readUInt16LE(at + 10),
      compressedSize: buffer.readUInt32LE(at + 20),
      size: buffer.readUInt32LE(at + 24),
      offset: buffer.readUInt32LE(at + 42),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extracts one entry listed by `listZipEntries`. */
export function readZipEntry(buffer, entry) {
  const nameLen = buffer.readUInt16LE(entry.offset + 26);
  const extraLen = buffer.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const body = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(body);
  if (entry.method === 8) return inflateRawSync(body);
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}

/** Every file below `dir` as a zip entry, `/`-separated and sorted. */
export function collectZipEntries(dir) {
  const out = [];
  const walk = (full, rel) => {
    for (const entry of readdirSync(full).sort()) {
      const path = join(full, entry);
      const name = rel ? `${rel}/${entry}` : entry;
      if (statSync(path).isDirectory()) walk(path, name);
      else out.push({ name, data: readFileSync(path) });
    }
  };
  walk(dir, "");
  return out;
}

/** LITE-README.md for the Stalwart bundle. */
export function buildStalwartReadme({ version, commit, locales, buildId, demoMode = false }) {
  const url = `https://github.com/bulwarkmail/webmail/releases/download/v${version}/${STALWART_ZIP_NAME}`;
  const latestUrl = `https://github.com/bulwarkmail/webmail/releases/latest/download/${STALWART_ZIP_NAME}`;
  return `# Bulwark Lite ${version} (${commit}) for Stalwart

Bulwark Webmail as a Stalwart \`Application\`: Stalwart downloads this zip,
serves it under a path of its own HTTP listener, and the webmail talks to the
same server's JMAP, login and token endpoints. There is nothing to configure:
no server URL, no CORS, no second web server.

Build: ${buildId}
Locales: ${locales.join(", ")}
Requires: Stalwart 0.16.0 or later (0.16.19 or later to use \`oauthClientId\`).
${demoMode ? "\nDemo mode is ON in this build: the login page offers the built-in demo account.\n" : ""}
## Install

An administrator creates one Application and then runs the \`UpdateApps\`
action: Stalwart only downloads and mounts Applications on that action or at
startup, so creating the object alone serves nothing. Permissions:
\`sysApplicationCreate\` (plus \`sysApplicationGet\`/\`sysApplicationQuery\` to
list, \`sysApplicationUpdate\` to change and \`sysApplicationDestroy\` to remove
it) and \`actionUpdateApps\`. Any of these is equivalent:

- Web admin: **Settings > Web Applications > Create**, description
  \`Bulwark Webmail\`, resource URL \`${url}\`, URL prefix \`/webmail\`; then run
  the update-applications action (or restart Stalwart).
- CLI:

  \`\`\`bash
  stalwart-cli create Application \\
    --field description='Bulwark Webmail' \\
    --field resourceUrl='${url}' \\
    --field 'urlPrefix={"/webmail":true}'
  stalwart-cli create Action/UpdateApps
  \`\`\`

- JMAP (\`urn:stalwart:jmap\`), as an administrator:

  \`\`\`json
  {
    "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
    "methodCalls": [
      ["x:Application/set", { "create": { "webmail": {
        "description": "Bulwark Webmail",
        "resourceUrl": "${url}",
        "urlPrefix": { "/webmail": true }
      } } }, "0"],
      ["x:Action/set", { "create": { "u": { "@type": "UpdateApps" } } }, "1"]
    ]
  }
  \`\`\`

Then open \`https://<your stalwart host>/webmail/\` and sign in with a mail
account.

## Mount prefix

\`urlPrefix\` is matched against the first path segment only (\`/webmail\`,
not \`/apps/webmail\`), and several prefixes may serve the same bundle. The
bundle works under any prefix: it reads it from the \`<base href>\` Stalwart
writes into index.html. Stalwart routes these first segments itself, so an
Application mounted there is never reached: \`jmap\`, \`dav\`, \`.well-known\`,
\`auth\`, \`api\`, \`scim\`, \`mail\`, \`calendar\`, \`autodiscover\`, \`login\`,
\`device\`, \`metrics\`, \`healthz\`, \`logo\`, \`form\`, \`robots.txt\`, and the web
admin's own \`admin\` and \`account\`.

## Updates

The resource URL above names one release, so what Stalwart serves only
changes when you change it: to update, point \`resourceUrl\` at the new
release's tag and run \`UpdateApps\` (it always downloads again; a failed
download keeps the previous bundle online). Every release also carries
\`${STALWART_ZIP_NAME}.sha256\`; check a download with
\`sha256sum -c ${STALWART_ZIP_NAME}.sha256\` before you switch.

The bundle runs as script on your Stalwart origin, next to the web admin.
Stalwart checks no hash or signature when it downloads, so a floating URL
such as \`${latestUrl}\` would run whatever the newest release holds, at the
next restart or \`UpdateApps\` after \`autoUpdateFrequency\` (default 90
days). Use it only if you accept that in exchange for automatic updates.

Open tabs move to the new build on their next navigation (one full page
load); a freshly opened tab gets it immediately. Nothing stays stuck on old
files although Stalwart sends a year-long cache header for every file but
index.html: every file the app fetches without a content hash carries the
build id.

## Sign-in

Passwords (and TOTP codes) go to Stalwart's \`/api/auth\` and are exchanged at
\`/auth/token\` for an access token and a refresh token, all on the same
origin. "Remember me" keeps the refresh token in localStorage, otherwise it
lives with the tab.

The OAuth client id is the Application's \`oauthClientId\` (Stalwart writes it
into index.html) or \`bulwark-webmail\` when that field is empty. If your
server requires registered OAuth clients, register that client id with the
redirect URI \`https://<your stalwart host>/<prefix>/\` (for example
\`https://mail.example.com/webmail/\`), once per prefix you mount.

### Single sign-on (OpenID Connect)

An account whose directory is an external OpenID provider has no password
Stalwart could check, so the form above cannot sign it in. The app asks
Stalwart who signs an address in (\`/api/discover/<address>\`, the lookup
Stalwart's own web admin uses): for such an account the password field gives
way to **Sign in with SSO**, which sends the user to the provider
(authorization code with PKCE) and redeems the code in the browser. Accounts
Stalwart authenticates itself keep the password form.

At the provider, register a **public** client (no secret, PKCE \`S256\`) with:

- the client id you put into the Application's \`oauthClientId\` (or
  \`bulwark-webmail\` if you leave that empty);
- the redirect URI \`https://<your stalwart host>/<prefix>/oauth/callback\`
  (for example \`https://mail.example.com/webmail/oauth/callback\`). It names
  no language, so one URI per prefix covers every locale;
- CORS on its token endpoint for \`https://<your stalwart host>\`, because the
  browser redeems and renews tokens there directly. Stalwart's web admin needs
  the same, so a provider already set up for it only needs the extra client.

Setting \`oauthClientId\` also shows **Sign in with SSO** next to the password
form for accounts Stalwart authenticates itself; that route goes through
Stalwart's own login page and needs the \`.../oauth/callback\` URI registered
as well if your server requires registered clients. Per-domain directories
are a Stalwart Enterprise feature; the community edition has one directory
for every account.

## Branding and settings

The bundle is read-only once Stalwart has unpacked it. To change the app
name, turn "remember me" off or build any other variant, run the
**Build Static Lite** workflow (or \`npm run build:lite -- --target=stalwart\`)
with your settings, publish the resulting \`${STALWART_ZIP_NAME}\` at a URL
you control, and use that URL as \`resourceUrl\`. \`config.json\` and
\`policy.json\` inside the zip take the same keys as in the static-host build.

## Differences from the static-host zip

- One entry document (\`index.html\`) boots every route: Stalwart has no
  rewrite rules and answers every unknown path with it.
- No \`_redirects\`, \`_headers\`, nginx/Caddy examples or \`404.html\`.
- \`config.json\` defaults to the serving Stalwart and hides the server field;
  no CORS settings are needed.
- The mount prefix is detected at runtime instead of being baked in.
- \`manifest.json\` replaces \`manifest.webmanifest\` (Stalwart would serve the
  latter as \`application/octet-stream\`).

Everything the static-host build leaves out (admin console, plugins,
settings sync, OAuth/SSO via an external identity provider, web push, office
editing, ICS subscriptions) is also missing here.
`;
}

/** Stalwart's escaping of the client id for the meta attribute (application.rs). */
export function stalwartOauthMeta(clientId) {
  const escaped = String(clientId).replace(/[&"<>]/g, (ch) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[ch]);
  return `<meta name="oauth-client-id" content="${escaped}"`;
}

/**
 * Stalwart's rewrite of the root index.html (0.16.19+: first occurrence of
 * each literal; 0.16.0-0.16.18 replaced every `<base href="/"` and had no
 * client id support - `legacy: true` emulates that).
 */
export function stalwartRewriteIndex(html, prefix, oauthClientId, { legacy = false } = {}) {
  const base = `<base href="/${prefix}/"`;
  if (legacy) return html.split(STALWART_BASE_HREF_LITERAL).join(base);
  let out = html.replace(STALWART_BASE_HREF_LITERAL, () => base);
  if (oauthClientId) out = out.replace(STALWART_OAUTH_META_LITERAL, () => stalwartOauthMeta(oauthClientId));
  return out;
}

/**
 * One request as Stalwart's HTTP listener answers it for Applications
 * (the `external =>` arm of crates/http/src/request.rs plus
 * WebApplications::serve). `entries` maps zip entry names to contents,
 * `prefixes` are the mounted urlPrefix values.
 *
 * @param {{ pathname: string, entries: Map<string, Buffer>, prefixes: string[], oauthClientId?: string, legacy?: boolean }} request
 * @returns {{ status: number, headers: Record<string, string>, body: Buffer }}
 */
export function emulateStalwartRequest({ pathname, entries, prefixes, oauthClientId = "", legacy = false }) {
  const mounted = prefixes.map((p) => String(p).replace(/^\/+|\/+$/g, ""));
  const segments = pathname.split("/");
  const first = segments[1] ?? "";
  const notFound = { status: 404, headers: { "content-type": "application/problem+json" }, body: Buffer.from('{"type":"about:blank","status":404,"title":"Not Found"}') };
  if (!first || isReservedStalwartSegment(first) || !mounted.includes(first)) return notFound;
  // HttpResponse::redirect answers 302 (verified against 0.16.22).
  if (segments.length === 2) return { status: 302, headers: { location: `/${first}/` }, body: Buffer.alloc(0) };
  const path = pathname.slice(first.length + 2);
  const direct = entries.get(path);
  const isIndex = direct ? path === "index.html" : true;
  const name = direct ? path : "index.html";
  const contents = direct ?? entries.get("index.html");
  if (!contents) return notFound;
  const body = isIndex ? Buffer.from(stalwartRewriteIndex(contents.toString("utf8"), first, oauthClientId, { legacy })) : contents;
  return {
    status: 200,
    headers: {
      "content-type": stalwartContentType(name),
      "cache-control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
    },
    body,
  };
}

/**
 * RSC text rows (`<id>:T<hex length>,...`) that contain a string the runtime
 * mount rewrite replaces. Those rows are length-prefixed, so
 * rewriteFlightForMount leaves them alone; a hit here would mean a URL that
 * is never pointed at the mount. Returns the offending row ids.
 */
export function flightTextRowsWithNeedles(text) {
  const needles = ['"/_next/', '"/manifest.webmanifest"', '"/branding/'];
  const hits = [];
  const buffer = Buffer.from(text, "utf8");
  const pattern = /(?:^|\n)([0-9a-f]+):T([0-9a-f]+),/g;
  let match;
  while ((match = pattern.exec(text))) {
    const start = Buffer.byteLength(text.slice(0, match.index + match[0].length), "utf8");
    const body = buffer.subarray(start, start + parseInt(match[2], 16)).toString("utf8");
    if (needles.some((needle) => body.includes(needle))) hits.push(match[1]);
  }
  return hits;
}

/**
 * Next 16.3 exports segment-prefetch payloads as nested directories
 * (`<route>/__next.<a>/<b>/__PAGE__.txt`) but requests them with dots
 * (`<route>/__next.<a>.<b>.__PAGE__.txt`). On Stalwart the dotted request is
 * answered with the entry index.html, which the router ignores before
 * fetching `index.txt`, so the nested trees are never read: the Stalwart
 * target drops them (about 40% of the zip). `__next._tree.txt` and
 * `__next._full.txt` are plain files and stay.
 */
export function findSegmentPrefetchDirs(outDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      if (entry.startsWith("__next.")) found.push(full);
      else if (entry !== "_next") walk(full);
    }
  };
  if (existsSync(outDir)) walk(outDir);
  return found;
}
