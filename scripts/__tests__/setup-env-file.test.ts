/**
 * @vitest-environment node
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * setup.sh writes .env.local; npm start reads it with Next's env loader,
 * docker compose and docker run with their own rules. These run the script's
 * own functions with bash and read the file back the way the app does.
 */

const ROOT = path.resolve(__dirname, '../..');
const posix = (p: string) => p.replace(/\\/g, '/');

// On Windows the bash.exe in System32 is WSL's; Git's understands these paths.
function bash(): string {
  if (process.platform !== 'win32') return 'bash';
  const git = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  return existsSync(git) ? git : 'bash';
}

// Loads setup.sh's defaults and functions (not its main), then runs "$@".
const HARNESS = String.raw`
set -euo pipefail
SETUP="$1"; shift
FUNCTIONS="env_value_problem env_format_line env_line prompt_value write_env_file load_existing_config update_docker_compose_port"
eval "$(tr -d '\r' < "$SETUP" | awk -v names="$FUNCTIONS" '
  BEGIN { n = split(names, a, " "); for (i = 1; i <= n; i++) want[a[i] "() {"] = 1 }
  /^CFG_APP_NAME=/ { defaults = 1 }
  defaults { print; if (/^CFG_PORT=/) defaults = 0; next }
  !on && ($0 in want) { on = 1 }
  on { print; if (/^}/) on = 0 }
')"
BOLD= DIM= RESET= RED= GREEN= YELLOW= CYAN= OK= FAIL= WARN=
show_cursor() { :; }; hide_cursor() { :; }
DRY_RUN=false

# write <env file> <method>, with "CFG_NAME<tab>value" lines on stdin. (On
# stdin, because Git's bash on Windows drops a lone ' from its arguments.)
write() {
  ENV_FILE="$1"; CFG_DEPLOY_METHOD="$2"
  while IFS=$'\t' read -r n v; do printf -v "$n" '%s' "$v"; done
  write_env_file
}
# reload <env file> <method> <names...>: read the file as the next run does,
# print the values, then write the file again.
reload() {
  ENV_FILE="$1"; CFG_DEPLOY_METHOD="$2"; shift 2
  load_existing_config
  for n in "$@"; do printf '%s=%s\n' "$n" "\${!n}"; done
  write_env_file >/dev/null
}
# prompt <name>: one prompt, answers from stdin; prints the value it kept.
prompt() {
  prompt_value "A value" "" "$1"
  printf '\nKEPT=%s\n' "\${!1}"
}
# port <folder with docker-compose.yml> <port>
port() {
  SCRIPT_DIR="$1"; CFG_PORT="$2"
  update_docker_compose_port
}
"$@"
`.replace(/\\\$\{/g, '${');

function run(args: string[], input = '') {
  const res = spawnSync(bash(), ['-c', HARNESS, '_', posix(path.join(ROOT, 'setup.sh')), ...args], {
    input,
    encoding: 'utf8',
  });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** What npm start would see: .env.local in `dir` read by @next/env, in a fresh process. */
function readWithNext(dir: string, keys: string[]): Record<string, string | null> {
  const script = `
    const { loadEnvConfig } = require(process.argv[1]);
    loadEnvConfig(process.argv[2], false, { info() {}, error() {} }, true);
    const keys = JSON.parse(process.argv[3]);
    process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));
  `;
  // As `npm start` runs: production mode reads .env.local (test mode would not).
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
  for (const k of keys) delete env[k];
  delete env.__NEXT_PROCESSED_ENV;
  const nextEnv = createRequire(path.join(ROOT, 'package.json')).resolve('@next/env');
  const res = spawnSync(process.execPath, ['-e', script, nextEnv, dir, JSON.stringify(keys)], {
    env,
    encoding: 'utf8',
  });
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout);
}

function lines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n');
}

/**
 * What docker compose's env_file passes on, after compose-go's dotenv parser
 * (dotenv/parser.go): a single-quoted value is taken as it is, except that a
 * backslash before the quote escapes it. Double-quoted and unquoted values
 * with a $ are interpolated, so they count as not read back.
 */
function composeRead(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([\w.\-[\]]+)[ \t]*[=:][ \t]*(.*)$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, key, rest] = m;
    if (rest.startsWith("'")) {
      let value = '';
      let escaped = false;
      let closed = false;
      for (const c of rest.slice(1)) {
        if (c === "'" && !escaped) { closed = true; break; }
        if (c === '\\' && !escaped) { escaped = true; continue; }
        if (escaped && c !== "'") value += '\\';
        escaped = false;
        value += c;
      }
      if (!closed) throw new Error(`compose: unterminated quoted value for ${key}`);
      out[key] = value;
    } else if (rest.startsWith('"') || rest.includes('$')) {
      throw new Error(`compose: ${key} would be interpolated`);
    } else {
      out[key] = rest.split(' #')[0].trimEnd();
    }
  }
  return out;
}

/**
 * What `docker run --env-file` passes on (docker/cli pkg/kvfile): the line's
 * leading whitespace goes, # lines are skipped, and everything after the
 * first = is the value, quotes included.
 */
function dockerRead(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s+/, '');
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq < 1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** The typed values a reader didn't get back, as "KEY: typed …, read …". */
function differences(read: Record<string, string | null | undefined>, typed: Record<string, string>): string[] {
  return Object.entries(typed)
    .filter(([name, value]) => read[KEY(name)] !== value)
    .map(([name, value]) => `${KEY(name)}: typed ${JSON.stringify(value)}, read ${JSON.stringify(read[KEY(name)])}`);
}

// Made-up values: a client secret with $ and #, names with # and $PATH, and
// the variants (backslashes, a trailing space, a value that starts with #).
const TYPED = {
  CFG_OAUTH_ENABLED: 'true',
  CFG_OAUTH_CLIENT_ID: 'made-up-client',
  CFG_OAUTH_CLIENT_SECRET: 'Zk3$tQ9w#Lm2',
  CFG_LOGIN_COMPANY_NAME: 'Acme #1 GmbH',
  CFG_APP_NAME: 'Mail $PATH',
  CFG_APP_DESCRIPTION: 'back\\slash, a\\$b and ${HOME}',
  CFG_APP_SHORT_NAME: 'Mail ',
  CFG_PWA_THEME_COLOR: '#3b82f6',
  CFG_HOSTNAME: '0.0.0.0',
  CFG_PORT: '3000',
} as const;
const KEY = (name: string) => name.replace(/^CFG_/, '');
const write = (file: string, method: string, values: Record<string, string>) =>
  run(['write', file, method], Object.entries(values).map(([name, value]) => `${name}\t${value}\n`).join(''));

let dir: string | undefined;
function scratch(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'setup-env-'));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

// Each case starts bash and node a few times, which takes seconds on Windows.
const SLOW = { timeout: 60_000 };

describe('setup.sh .env.local for npm start', SLOW, () => {
  it('writes values that Next reads back unchanged', () => {
    const d = scratch();
    const res = write(posix(path.join(d, '.env.local')), 'node', TYPED);
    expect(res.code, res.out).toBe(0);
    const read = readWithNext(d, Object.keys(TYPED).map(KEY));
    const changed = Object.entries(TYPED).filter(([name, typed]) => read[KEY(name)] !== typed);
    expect(changed.map(([name, typed]) => `${KEY(name)}: typed ${JSON.stringify(typed)}, read ${JSON.stringify(read[KEY(name)])}`)).toEqual([]);
  });

  it('writes an empty value as empty', () => {
    const d = scratch();
    expect(write(posix(path.join(d, '.env.local')), 'node', { CFG_APP_NAME: '' }).code).toBe(0);
    expect(readWithNext(d, ['APP_NAME']).APP_NAME).toBe('');
  });

  it('reads its own file back on the next run and writes the same file again', () => {
    const d = scratch();
    const file = posix(path.join(d, '.env.local'));
    expect(write(file, 'node', TYPED).code).toBe(0);
    const first = lines(file).filter((l) => !l.startsWith('# Generated by'));
    const res = run(['reload', file, 'node', ...Object.keys(TYPED)]);
    expect(res.code, res.out).toBe(0);
    for (const [name, typed] of Object.entries(TYPED)) expect(res.out).toContain(`${name}=${typed}\n`);
    expect(lines(file).filter((l) => !l.startsWith('# Generated by'))).toEqual(first);
    // The run backed the old file up; the values stay readable for Next.
    expect(readdirSync(d).some((f) => f.startsWith('.env.local.backup.'))).toBe(true);
    expect(readWithNext(d, ['OAUTH_CLIENT_SECRET']).OAUTH_CLIENT_SECRET).toBe(TYPED.CFG_OAUTH_CLIENT_SECRET);
  });

  it('still reads a file an older setup.sh wrote, with keys missing', () => {
    const d = scratch();
    const file = posix(path.join(d, '.env.local'));
    writeFileSync(file, [
      '# Generated by setup.sh on 2026-01-01 00:00:00',
      'APP_NAME=Mail $PATH',
      'JMAP_SERVER_URL=https://mail.example.com',
      'LOGIN_COMPANY_NAME="Acme Corp"',
      'OAUTH_ENABLED=false',
      '',
    ].join('\n'));
    const res = run(['reload', file, 'node', 'CFG_APP_NAME', 'CFG_JMAP_SERVER_URL', 'CFG_LOGIN_COMPANY_NAME']);
    expect(res.code, res.out).toBe(0);
    expect(res.out).toContain('CFG_APP_NAME=Mail $PATH\n');
    expect(res.out).toContain('CFG_JMAP_SERVER_URL=https://mail.example.com\n');
    expect(res.out).toContain('CFG_LOGIN_COMPANY_NAME=Acme Corp\n');
    // Written again in the new form, what was typed then reaches the app now.
    expect(readWithNext(d, ['APP_NAME']).APP_NAME).toBe('Mail $PATH');
  });
});

describe('setup.sh .env.local for docker compose and docker run', SLOW, () => {
  it('writes values that docker compose reads back unchanged', () => {
    const d = scratch();
    const file = posix(path.join(d, '.env.local'));
    expect(write(file, 'compose', TYPED).code).toBe(0);
    expect(differences(composeRead(readFileSync(file, 'utf8')), TYPED)).toEqual([]);
    const res = run(['reload', file, 'compose', ...Object.keys(TYPED)]);
    for (const [name, typed] of Object.entries(TYPED)) expect(res.out).toContain(`${name}=${typed}\n`);
  });

  it('writes values that docker run --env-file reads back unchanged', () => {
    const d = scratch();
    const file = posix(path.join(d, '.env.local'));
    expect(write(file, 'docker', TYPED).code).toBe(0);
    expect(differences(dockerRead(readFileSync(file, 'utf8')), TYPED)).toEqual([]);
    const res = run(['reload', file, 'docker', ...Object.keys(TYPED)]);
    for (const [name, typed] of Object.entries(TYPED)) expect(res.out).toContain(`${name}=${typed}\n`);
  });
});

describe('setup.sh values .env.local cannot hold', SLOW, () => {
  it.each([
    ['a single quote', "Bob's Mail"],
    ['a backslash at the end', 'ends with \\'],
  ])('the prompt refuses one with %s and asks again', (_what, bad) => {
    const res = run(['prompt', 'CFG_APP_NAME'], `${bad}\nGood Name\n`);
    expect(res.code, res.out).toBe(0);
    expect(res.out).toMatch(/can't hold this value unchanged/);
    expect(res.out).toContain('KEPT=Good Name\n');
  });

  it('writes nothing while a value read back from an old file has a single quote', () => {
    const d = scratch();
    const file = posix(path.join(d, '.env.local'));
    writeFileSync(file, 'APP_NAME=Old\n');
    const res = write(file, 'node', { CFG_SESSION_SECRET: "made-up-secret-with-a-'-in-it-0123456789" });
    expect(res.code).not.toBe(0);
    expect(res.out).toMatch(/SESSION_SECRET can't be written to \.env\.local unchanged/);
    expect(readFileSync(file, 'utf8')).toBe('APP_NAME=Old\n');
    expect(readdirSync(d)).toEqual(['.env.local']);
  });
});

describe('setup.sh port in docker-compose.yml', SLOW, () => {
  it('moves the published port and leaves no backup copy behind', () => {
    const d = scratch();
    copyFileSync(path.join(ROOT, 'docker-compose.yml'), path.join(d, 'docker-compose.yml'));
    const res = run(['port', posix(d), '8080']);
    expect(res.code, res.out).toBe(0);
    const compose = readFileSync(path.join(d, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('- "127.0.0.1:8080:3000"');
    expect(compose).not.toContain('- "127.0.0.1:3000:3000"');
    expect(readdirSync(d)).toEqual(['docker-compose.yml']);
  });
});
