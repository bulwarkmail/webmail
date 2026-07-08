#!/usr/bin/env bash
# =============================================================================
# Bulwark Webmail - Interactive Setup Script
# =============================================================================
set -euo pipefail

# -- CLI Flags ----------------------------------------------------------------
DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        -h|--help)
            echo "Usage: bash setup.sh [--dry-run]"
            echo "  --dry-run   Walk through the installer without writing files or running commands"
            exit 0
            ;;
    esac
done

# -- Colors & Symbols ---------------------------------------------------------
BOLD='\033[1m'
DIM='\033[2m'
ITALIC='\033[3m'
UNDERLINE='\033[4m'
RESET='\033[0m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
BG_BLUE='\033[44m'
BG_GREEN='\033[42m'
BG_MAGENTA='\033[45m'

# ASCII-safe symbols (no Unicode that breaks when piped)
OK="${GREEN}[OK]${RESET}"
FAIL="${RED}[!!]${RESET}"
WARN="${YELLOW}[!!]${RESET}"
SKIP="${DIM}[--]${RESET}"
INFO="${CYAN}>>>${RESET}"
TIP="${YELLOW}TIP${RESET}"
ARROW="${CYAN}-->${RESET}"
STAR="${CYAN}*${RESET}"

# -- State --------------------------------------------------------------------
set +u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
set -u
ENV_FILE="${SCRIPT_DIR}/.env.local"
REPO_URL="https://github.com/bulwarkmail/webmail.git"

# Config values (defaults)
CFG_APP_NAME="Bulwark Webmail"
CFG_JMAP_SERVER_URL=""
CFG_ALLOW_CUSTOM_JMAP_ENDPOINT="false"
CFG_STALWART_FEATURES="true"
CFG_OAUTH_ENABLED="false"
CFG_OAUTH_ONLY="false"
CFG_OAUTH_CLIENT_ID=""
CFG_OAUTH_CLIENT_SECRET=""
CFG_OAUTH_ISSUER_URL=""
CFG_SESSION_SECRET=""
CFG_SETTINGS_SYNC_ENABLED="false"
CFG_SETTINGS_DATA_DIR="./data/settings"
CFG_TELEMETRY="false"
CFG_LOG_FORMAT="text"
CFG_LOG_LEVEL="info"
CFG_APP_SHORT_NAME=""
CFG_APP_DESCRIPTION=""
CFG_LOGIN_COMPANY_NAME=""
CFG_LOGIN_LOGO_LIGHT_URL=""
CFG_LOGIN_LOGO_DARK_URL=""
CFG_FAVICON_URL=""
CFG_PWA_ICON_URL=""
CFG_PWA_THEME_COLOR=""
CFG_PWA_BACKGROUND_COLOR=""
CFG_APP_LOGO_LIGHT_URL=""
CFG_APP_LOGO_DARK_URL=""
CFG_LOGIN_IMPRINT_URL=""
CFG_LOGIN_PRIVACY_POLICY_URL=""
CFG_LOGIN_WEBSITE_URL=""
CFG_EXTENSION_DIRECTORY_URL=""
CFG_DEPLOY_METHOD=""
CFG_HOSTNAME="0.0.0.0"
CFG_PORT="3000"

CURRENT_STEP=0
TOTAL_STEPS=7

STEP_NAMES=(
    ""
    "Server"
    "Auth"
    "Security"
    "Logging"
    "Branding"
    "Deploy"
    "Confirm"
)

# -- Terminal Utilities -------------------------------------------------------
get_term_size() {
    TERM_COLS=$(tput cols 2>/dev/null || echo 80)
    TERM_ROWS=$(tput lines 2>/dev/null || echo 24)
}

clear_screen() { printf '\033[2J\033[H'; }
hide_cursor() { printf '\033[?25l'; }
show_cursor() { printf '\033[?25h'; }

print_center() {
    local text="$1"
    local clean
    clean=$(echo -e "$text" | sed 's/\x1b\[[0-9;]*m//g')
    local pad=$(( (TERM_COLS - ${#clean}) / 2 ))
    [[ $pad -lt 0 ]] && pad=0
    printf "%${pad}s" ""
    echo -e "$text"
}

# Draw a horizontal line using ASCII dashes
hr() {
    local color="${1:-$DIM}"
    echo -e "${color}$(printf '%*s' "$TERM_COLS" '' | tr ' ' '-')${RESET}"
}

# Draw a box around text (ASCII-safe)
box() {
    local text="$1"
    local color="${2:-$CYAN}"
    local clean
    clean=$(echo -e "$text" | sed 's/\x1b\[[0-9;]*m//g')
    local len=${#clean}
    local inner=$(( len + 2 ))
    local top="+$(printf '%*s' "$inner" '' | tr ' ' '-')+"
    local pad=$(( (TERM_COLS - inner - 2) / 2 ))
    [[ $pad -lt 0 ]] && pad=0
    local sp
    sp=$(printf '%*s' "$pad" '')
    echo -e "${sp}${color}${top}${RESET}"
    echo -e "${sp}${color}|${RESET} ${text} ${color}|${RESET}"
    echo -e "${sp}${color}${top}${RESET}"
}

# Print an info note
note() {
    local text="$1"
    echo -e "  ${CYAN}${BOLD}NOTE:${RESET} ${DIM}${text}${RESET}"
}

# Validate that a URL points to a JMAP server
check_jmap_server() {
    local url="$1"

    # Need curl or wget
    local http_tool=""
    if command -v curl &>/dev/null; then
        http_tool="curl"
    elif command -v wget &>/dev/null; then
        http_tool="wget"
    else
        echo -e "    ${SKIP} Cannot verify server (curl/wget not found)"
        return 0
    fi

    # Strip trailing slash
    url="${url%/}"

    echo -ne "    ${DIM}Checking JMAP server...${RESET}"

    local response=""
    local http_code=""
    local jmap_found=false

    # Helper to fetch a URL and return response body
    fetch_url() {
        local target="$1"
        if [[ "$http_tool" == "curl" ]]; then
            curl -s -L --connect-timeout 5 --max-time 10 "$target" 2>/dev/null || echo ""
        else
            wget -q --timeout=10 -O - "$target" 2>/dev/null || echo ""
        fi
    }

    get_http_code() {
        local target="$1"
        if [[ "$http_tool" == "curl" ]]; then
            curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 "$target" 2>/dev/null || echo "000"
        else
            wget -q --spider --timeout=10 "$target" 2>/dev/null && echo "200" || echo "000"
        fi
    }

    # Check if a response body looks like a JMAP session
    is_jmap_session() {
        echo "$1" | grep -qiE '"capabilities"|"apiUrl"|"downloadUrl"|"urn:ietf:params:jmap'
    }

    # Try multiple known JMAP endpoints
    local endpoints=("/.well-known/jmap" "/jmap/session" "/jmap")
    for endpoint in "${endpoints[@]}"; do
        response=$(fetch_url "${url}${endpoint}")
        if [[ -n "$response" ]] && is_jmap_session "$response"; then
            jmap_found=true
            break
        fi
    done

    echo -ne "\r                                         \r"

    if [[ "$jmap_found" == true ]]; then
        echo -e "    ${OK} ${GREEN}JMAP server verified${RESET}"
        return 0
    fi

    # No JMAP session found at any endpoint -- check if server is reachable at all
    http_code=$(get_http_code "$url")

    if [[ "$http_code" == "000" ]]; then
        echo -e "    ${FAIL} ${RED}Could not connect to ${url}${RESET}"
        echo -e "         ${DIM}Check that the URL is correct and the server is running.${RESET}"
        return 1
    fi

    # Server is reachable but JMAP session not found at standard paths
    echo -e "    ${WARN} ${YELLOW}Server is reachable (HTTP ${http_code}) but JMAP session was not detected${RESET}"
    echo -e "         ${DIM}Checked: /.well-known/jmap, /jmap/session, /jmap${RESET}"
    echo -e "         ${DIM}This is OK if a reverse proxy routes JMAP traffic separately${RESET}"
    echo -e "         ${DIM}(e.g. webmail and mail server share the same domain).${RESET}"

    local continue_anyway="true"
    prompt_yesno "Continue with this URL?" "true" "continue_anyway"

    if [[ "$continue_anyway" != "true" ]]; then
        return 1
    fi
    return 0
}

# Read a single key press (for menu navigation)
read_key() {
    local key
    IFS= read -rsn1 key
    if [[ "$key" == $'\x1b' ]]; then
        read -rsn2 -t 0.1 key2 || true
        key="${key}${key2}"
    fi
    echo "$key"
}

# -- Input Helpers ------------------------------------------------------------

# Prompt with default value (safe - no eval)
prompt_value() {
    local label="$1"
    local default="$2"
    local var_name="$3"
    local required="${4:-false}"

    show_cursor
    if [[ -n "$default" ]]; then
        echo -ne "    ${BOLD}${label}${RESET} ${DIM}(${default})${RESET}: "
    else
        echo -ne "    ${BOLD}${label}${RESET}: "
    fi

    local input
    read -r input
    input="${input:-$default}"

    if [[ "$required" == "true" && -z "$input" ]]; then
        echo -e "    ${RED}This field is required. Please enter a value.${RESET}"
        prompt_value "$label" "$default" "$var_name" "$required"
        return
    fi

    printf -v "$var_name" '%s' "$input"
    hide_cursor
}

# Yes/No prompt (safe - no eval)
prompt_yesno() {
    local label="$1"
    local default="$2"
    local var_name="$3"

    local yn_display
    if [[ "$default" == "true" ]]; then
        yn_display="${GREEN}${BOLD}Y${RESET}${DIM}/n${RESET}"
    else
        yn_display="${DIM}y/${RESET}${GREEN}${BOLD}N${RESET}"
    fi

    show_cursor
    echo -ne "    ${BOLD}${label}${RESET} [${yn_display}]: "

    local input
    read -r input
    input=$(echo "$input" | tr '[:upper:]' '[:lower:]')

    local result
    case "$input" in
        y|yes) result="true" ;;
        n|no)  result="false" ;;
        *)     result="$default" ;;
    esac
    printf -v "$var_name" '%s' "$result"
    hide_cursor
}

# Interactive menu selector (ASCII arrows)
menu_select() {
    local label="$1"
    shift
    local options=("$@")
    local selected=0
    local count=${#options[@]}

    hide_cursor
    echo -e "    ${BOLD}${label}${RESET}"
    echo ""

    while true; do
        for (( i=0; i<count; i++ )); do
            if [[ $i -eq $selected ]]; then
                echo -e "      ${GREEN}${BOLD}> ${options[$i]}${RESET}"
            else
                echo -e "      ${DIM}  ${options[$i]}${RESET}"
            fi
        done
        echo ""
        echo -e "    ${DIM}Use arrow keys to navigate, Enter to select${RESET}"

        local key
        key=$(read_key)

        case "$key" in
            $'\x1b[A') selected=$(( (selected - 1 + count) % count )) ;;
            $'\x1b[B') selected=$(( (selected + 1) % count )) ;;
            "") break ;;
        esac

        local lines_up=$(( count + 2 ))
        printf '\033[%dA' "$lines_up"
    done

    show_cursor
    MENU_RESULT=$selected
    MENU_VALUE="${options[$selected]}"
}

# -- Progress Bar -------------------------------------------------------------
draw_progress_bar() {
    local current="$1"
    local total="$2"
    local max_width=56
    local width=$max_width
    [[ $(( TERM_COLS - 30 )) -lt $width ]] && width=$(( TERM_COLS - 30 ))
    [[ $width -lt 20 ]] && width=20

    local filled=$(( width * current / total ))
    local empty=$(( width - filled ))
    local pct=$(( 100 * current / total ))

    local bar=""
    [[ $filled -gt 0 ]] && bar=$(printf '%*s' "$filled" '' | tr ' ' '#')
    [[ $empty -gt 0 ]] && bar="${bar}$(printf '%*s' "$empty" '' | tr ' ' '.')"

    # Build step label row
    local label_row="  "
    for (( s=1; s<=total; s++ )); do
        if [[ $s -lt $current ]]; then
            label_row+="${GREEN}${STEP_NAMES[$s]}${RESET} "
        elif [[ $s -eq $current ]]; then
            label_row+="${WHITE}${BOLD}${STEP_NAMES[$s]}${RESET} "
        else
            label_row+="${DIM}${STEP_NAMES[$s]}${RESET} "
        fi
        [[ $s -lt $total ]] && label_row+="${DIM}>${RESET} "
    done

    print_center "${label_row}"
    echo ""
    echo -e "  ${DIM}[${RESET}${GREEN}${bar:0:$filled}${RESET}${DIM}${bar:$filled}${RESET}${DIM}]${RESET} ${BOLD}${pct}%%${RESET} ${DIM}(step ${current}/${total})${RESET}"
}

# Spinner for async operations (ASCII-safe)
spinner() {
    local pid=$1
    local message="${2:-Working...}"
    local frames=('|' '/' '-' '\')
    local i=0

    hide_cursor
    while kill -0 "$pid" 2>/dev/null; do
        echo -ne "\r    ${CYAN}${frames[$i]}${RESET} ${message}"
        i=$(( (i + 1) % ${#frames[@]} ))
        sleep 0.1
    done
    echo -ne "\r    ${OK} ${message}          \n"
    show_cursor
}

# -- Screen Rendering ---------------------------------------------------------

draw_header() {
    get_term_size
    clear_screen
    echo ""

    if [[ "$DRY_RUN" == true ]]; then
        box "BULWARK WEBMAIL SETUP  --  DRY RUN" "$MAGENTA"
    else
        box "BULWARK WEBMAIL SETUP" "$CYAN"
    fi

    echo ""

    if [[ $CURRENT_STEP -gt 0 ]]; then
        draw_progress_bar "$CURRENT_STEP" "$TOTAL_STEPS"
        echo ""
    fi
    hr
    echo ""
}

draw_footer() {
    echo ""
    hr
    echo ""
    if [[ $CURRENT_STEP -eq 0 ]]; then
        print_center "${DIM}Press Enter to begin${RESET}"
    elif [[ $CURRENT_STEP -le $TOTAL_STEPS ]]; then
        print_center "${DIM}Press Enter to continue  |  Ctrl+C to abort${RESET}"
    fi
}

# -- Section header inside a step
section_header() {
    local number="$1"
    local title="$2"
    local subtitle="${3:-}"

    echo -e "  ${CYAN}${BOLD}Step ${number}: ${title}${RESET}"
    if [[ -n "$subtitle" ]]; then
        echo -e "  ${DIM}${subtitle}${RESET}"
    fi
    echo ""
}

# -- Screens ------------------------------------------------------------------

screen_welcome() {
    CURRENT_STEP=0
    draw_header

    local version
    version=$(cat "${SCRIPT_DIR}/VERSION" 2>/dev/null || echo "dev")

    print_center "${BOLD}Welcome to Bulwark Webmail${RESET}"
    print_center "${DIM}v${version}${RESET}"
    echo ""
    echo ""

    echo -e "  This wizard will walk you through configuring your webmail instance."
    echo -e "  It takes about ${BOLD}2 minutes${RESET} and will generate a ${BOLD}.env.local${RESET} file."
    echo ""
    echo -e "  ${BOLD}What we'll set up:${RESET}"
    echo ""
    echo -e "    ${STAR} ${BOLD}Server${RESET}      - Connect to your JMAP mail server (Stalwart, etc.)"
    echo -e "    ${STAR} ${BOLD}Auth${RESET}        - Choose Basic Auth, OAuth2/OIDC, or both"
    echo -e "    ${STAR} ${BOLD}Security${RESET}    - Session secrets, \"Remember me\", settings sync"
    echo -e "    ${STAR} ${BOLD}Logging${RESET}     - Log format and verbosity"
    echo -e "    ${STAR} ${BOLD}Branding${RESET}    - Company name, links on the login page"
    echo -e "    ${STAR} ${BOLD}Deployment${RESET}  - Node.js, Docker, or Docker Compose"
    echo ""

    hr
    echo ""
    echo -e "  ${BOLD}System Check${RESET}"
    echo ""

    local all_ok=true

    # Node.js
    if command -v node &>/dev/null; then
        local node_ver
        node_ver=$(node --version)
        local node_major
        node_major=$(echo "$node_ver" | grep -oP '(?<=v)\d+' || echo "0")
        if [[ "$node_major" -ge 18 ]]; then
            echo -e "    ${OK}  Node.js ${node_ver}"
        else
            echo -e "    ${WARN}  Node.js ${node_ver} ${YELLOW}(v18+ recommended)${RESET}"
        fi
    else
        echo -e "    ${FAIL}  Node.js not found ${RED}(required for local builds)${RESET}"
        all_ok=false
    fi

    # npm
    if command -v npm &>/dev/null; then
        local npm_ver
        npm_ver=$(npm --version)
        echo -e "    ${OK}  npm v${npm_ver}"
    else
        echo -e "    ${FAIL}  npm not found ${RED}(required for local builds)${RESET}"
        all_ok=false
    fi

    # Docker
    if command -v docker &>/dev/null; then
        local docker_ver
        docker_ver=$(docker --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1 || echo "installed")
        echo -e "    ${OK}  Docker v${docker_ver}"
    else
        echo -e "    ${SKIP}  Docker not found ${DIM}(needed only for Docker deployments)${RESET}"
    fi

    # Git
    if command -v git &>/dev/null; then
        local git_ver
        git_ver=$(git --version | grep -oP '\d+\.\d+\.\d+' || echo "installed")
        echo -e "    ${OK}  Git v${git_ver}"
    else
        echo -e "    ${SKIP}  Git not found ${DIM}(optional)${RESET}"
    fi

    # openssl
    if command -v openssl &>/dev/null; then
        echo -e "    ${OK}  OpenSSL available"
    else
        echo -e "    ${SKIP}  OpenSSL not found ${DIM}(needed for auto-generating secrets)${RESET}"
    fi

    echo ""

    if [[ "$all_ok" == false ]]; then
        echo -e "  ${YELLOW}${BOLD}WARNING:${RESET} ${YELLOW}Some required tools are missing.${RESET}"
        echo -e "  ${YELLOW}Install Node.js 18+ and npm before deploying with Node.js.${RESET}"
        echo -e "  ${YELLOW}You can still proceed if you plan to use Docker.${RESET}"
        echo ""
    fi

    if [[ -f "$ENV_FILE" ]]; then
        note "Found existing .env.local -- your current values will be used as defaults."
    fi

    draw_footer
    read -r
}

screen_server_config() {
    CURRENT_STEP=1
    draw_header

    section_header 1 "Server Configuration" \
        "Point Bulwark Webmail at your mail server."

    echo -e "  ${BOLD}General${RESET}"
    echo -e "    ${DIM}This name appears in the browser tab and on the login page.${RESET}"
    echo ""
    prompt_value "Application name" "$CFG_APP_NAME" "CFG_APP_NAME"
    echo ""

    echo -e "  ${BOLD}Mail Server${RESET}"
    echo -e "    ${DIM}Enter the base URL of your Stalwart (or JMAP-compatible) server.${RESET}"
    echo -e "    ${DIM}Example: https://mail.example.com${RESET}"
    echo ""

    local jmap_url_valid=false
    while [[ "$jmap_url_valid" == false ]]; do
        prompt_value "JMAP server URL" "$CFG_JMAP_SERVER_URL" "CFG_JMAP_SERVER_URL" "true"

        # Validate URL format
        if [[ ! "$CFG_JMAP_SERVER_URL" =~ ^https?:// ]]; then
            echo -e "    ${WARN} URL should start with https:// or http://"
            CFG_JMAP_SERVER_URL="https://${CFG_JMAP_SERVER_URL}"
            echo -e "    ${DIM}Auto-corrected to: ${CFG_JMAP_SERVER_URL}${RESET}"
        fi

        echo ""

        # Validate it's actually a JMAP server
        if check_jmap_server "$CFG_JMAP_SERVER_URL"; then
            jmap_url_valid=true
        else
            echo ""
            echo -e "    ${DIM}Please enter a different URL or fix the server.${RESET}"
            echo ""
            CFG_JMAP_SERVER_URL=""
        fi
    done

    echo ""

    echo -e "  ${BOLD}Features${RESET}"
    echo -e "    ${DIM}Adds password change and Sieve filter management.${RESET}"
    echo -e "    ${DIM}Safe to enable even on non-Stalwart servers.${RESET}"
    echo ""
    prompt_yesno "Enable Stalwart-specific features?" "$CFG_STALWART_FEATURES" "CFG_STALWART_FEATURES"
    echo ""

    echo -e "    ${DIM}Adds a \"JMAP Server\" field to the login form so users can${RESET}"
    echo -e "    ${DIM}connect to any JMAP-compatible server (not just the one above).${RESET}"
    echo -e "    ${DIM}The external server must allow this domain in its CORS headers.${RESET}"
    prompt_yesno "Allow users to override the JMAP server at login?" "$CFG_ALLOW_CUSTOM_JMAP_ENDPOINT" "CFG_ALLOW_CUSTOM_JMAP_ENDPOINT"
    echo ""

    echo -e "  ${BOLD}Network${RESET}"
    echo -e "    ${DIM}The address the server binds to. Use \"0.0.0.0\" for all IPv4${RESET}"
    echo -e "    ${DIM}interfaces or \"::\" for dual-stack IPv4+IPv6.${RESET}"
    echo ""
    prompt_value "Hostname" "$CFG_HOSTNAME" "CFG_HOSTNAME"
    echo ""
    echo -e "    ${DIM}The port the web UI will listen on. Default is 3000.${RESET}"
    prompt_value "Port" "$CFG_PORT" "CFG_PORT"

    draw_footer
    read -r
}

screen_auth_config() {
    CURRENT_STEP=2
    draw_header

    section_header 2 "Authentication" \
        "Choose how users log in to the webmail."

    echo -e "  Basic Auth (username + password) is ${BOLD}always available${RESET}."
    echo -e "  You can optionally add ${BOLD}OAuth2 / OpenID Connect${RESET} for single sign-on."
    echo ""

    prompt_yesno "Enable OAuth2/OIDC?" "$CFG_OAUTH_ENABLED" "CFG_OAUTH_ENABLED"

    if [[ "$CFG_OAUTH_ENABLED" == "true" ]]; then
        echo ""
        hr
        echo ""
        echo -e "  ${BOLD}OAuth2 / OIDC Configuration${RESET}"
        echo ""

        echo -e "    ${DIM}Enable this if ALL users authenticate via your identity provider.${RESET}"
        prompt_yesno "OAuth-only mode? (hides the password form)" "$CFG_OAUTH_ONLY" "CFG_OAUTH_ONLY"
        echo ""

        prompt_value "OAuth Client ID" "$CFG_OAUTH_CLIENT_ID" "CFG_OAUTH_CLIENT_ID" "true"
        echo ""

        echo -e "    ${DIM}Leave empty for public clients using PKCE only (no secret needed).${RESET}"
        prompt_value "OAuth Client Secret" "$CFG_OAUTH_CLIENT_SECRET" "CFG_OAUTH_CLIENT_SECRET"
        echo ""

        echo -e "    ${DIM}For external IdPs (Keycloak, Authentik, Entra ID, etc.).${RESET}"
        echo -e "    ${DIM}Leave empty to use Stalwart's built-in OAuth.${RESET}"
        prompt_value "OAuth Issuer URL" "$CFG_OAUTH_ISSUER_URL" "CFG_OAUTH_ISSUER_URL"
    else
        echo ""
        note "Users will log in with their email and password (Basic Auth over HTTPS)."
        echo -e "    ${DIM}You can enable OAuth2 later by editing .env.local.${RESET}"
    fi

    draw_footer
    read -r
}

screen_security_config() {
    CURRENT_STEP=3
    draw_header

    section_header 3 "Security & Sessions" \
        "Configure session persistence and cross-device settings sync."

    echo -e "  A ${BOLD}session secret${RESET} is a random key used to encrypt the \"Remember me\""
    echo -e "  cookie. Without it, users must log in every time they open the app."
    echo ""

    local generate_secret="false"

    if [[ -z "$CFG_SESSION_SECRET" ]]; then
        prompt_yesno "Auto-generate a secure session secret? (recommended)" "true" "generate_secret"

        if [[ "$generate_secret" == "true" ]]; then
            if command -v openssl &>/dev/null; then
                CFG_SESSION_SECRET=$(openssl rand -base64 32)
                echo -e "    ${OK} Session secret generated (via openssl)"
            else
                CFG_SESSION_SECRET=$(head -c 32 /dev/urandom | base64)
                echo -e "    ${OK} Session secret generated (via /dev/urandom)"
            fi
        else
            prompt_value "Session secret (paste your own)" "" "CFG_SESSION_SECRET"
        fi
    else
        echo -e "    ${OK} Session secret is already configured"
        prompt_yesno "Regenerate it?" "false" "generate_secret"
        if [[ "$generate_secret" == "true" ]]; then
            if command -v openssl &>/dev/null; then
                CFG_SESSION_SECRET=$(openssl rand -base64 32)
            else
                CFG_SESSION_SECRET=$(head -c 32 /dev/urandom | base64)
            fi
            echo -e "    ${OK} Session secret regenerated"
        fi
    fi

    echo ""

    if [[ -n "$CFG_SESSION_SECRET" ]]; then
        echo -e "  ${BOLD}With a session secret, you get:${RESET}"
        echo -e "    ${STAR} \"Remember me\" checkbox on the login page"
        echo -e "    ${STAR} Credentials encrypted at rest with AES-256-GCM"
        echo ""

        hr
        echo ""
        echo -e "  ${BOLD}Settings Sync${RESET}"
        echo ""
        echo -e "  Sync user preferences (theme, layout, etc.) across devices."
        echo -e "  Settings are stored server-side in a local directory."
        echo ""

        prompt_yesno "Enable settings sync?" "$CFG_SETTINGS_SYNC_ENABLED" "CFG_SETTINGS_SYNC_ENABLED"

        if [[ "$CFG_SETTINGS_SYNC_ENABLED" == "true" ]]; then
            echo ""
            echo -e "    ${DIM}Make sure this directory is persistent and backed up.${RESET}"
            prompt_value "Data directory for synced settings" "$CFG_SETTINGS_DATA_DIR" "CFG_SETTINGS_DATA_DIR"
        fi
    else
        echo ""
        note "Without a session secret, \"Remember me\" and settings sync are disabled."
        echo -e "    ${DIM}You can add a SESSION_SECRET to .env.local at any time.${RESET}"
    fi

    echo ""
    hr
    echo ""
    echo -e "  ${BOLD}Anonymous Usage Stats${RESET}"
    echo ""
    echo -e "  Bulwark can send one anonymous heartbeat per day. It helps us see how"
    echo -e "  many instances run, on what platforms, and which features are enabled"
    echo -e "  so we can ${BOLD}make the product better${RESET}."
    echo ""
    echo -e "    ${STAR} ${BOLD}No private data${RESET} - no email addresses, hostnames, or IPs"
    echo -e "    ${STAR} Just version, platform, and which features are turned on"
    echo -e "    ${STAR} ${BOLD}Off by default${RESET} - you can change it any time in the admin UI"
    echo ""

    prompt_yesno "Enable anonymous telemetry to help improve Bulwark?" "$CFG_TELEMETRY" "CFG_TELEMETRY"

    if [[ "$CFG_TELEMETRY" == "true" ]]; then
        echo ""
        echo -e "    ${OK} ${GREEN}Thanks! Telemetry will be enabled. We appreciate it.${RESET}"
    else
        echo ""
        note "Telemetry stays off. No heartbeats will be sent."
    fi

    draw_footer
    read -r
}

screen_logging_config() {
    CURRENT_STEP=4
    draw_header

    section_header 4 "Logging" \
        "Control how Bulwark Webmail writes logs."

    echo -e "  ${BOLD}Log Format${RESET}"
    echo ""

    menu_select "Choose a format:" \
        "text   - Colored, human-readable (good for terminals)" \
        "json   - Structured JSON (good for log aggregation)"
    case $MENU_RESULT in
        0) CFG_LOG_FORMAT="text" ;;
        1) CFG_LOG_FORMAT="json" ;;
    esac

    echo ""
    echo -e "  ${BOLD}Log Level${RESET}"
    echo ""

    menu_select "Choose verbosity:" \
        "error  - Errors only" \
        "warn   - Errors + warnings" \
        "info   - Standard output (recommended)" \
        "debug  - Verbose (for development/troubleshooting)"
    case $MENU_RESULT in
        0) CFG_LOG_LEVEL="error" ;;
        1) CFG_LOG_LEVEL="warn" ;;
        2) CFG_LOG_LEVEL="info" ;;
        3) CFG_LOG_LEVEL="debug" ;;
    esac

    echo ""
    note "Use 'info' for production. Switch to 'debug' temporarily when troubleshooting."

    draw_footer
    read -r
}

screen_login_customization() {
    CURRENT_STEP=5
    draw_header

    section_header 5 "Branding" \
        "Customize logos, favicon, and login page for your domain identity."

    echo -e "  All fields are ${BOLD}optional${RESET}. Press Enter to skip any field."
    echo ""

    echo -e "  ${BOLD}App Identity${RESET}"
    echo -e "    ${DIM}Short name used where space is limited (e.g. mobile home screen).${RESET}"
    echo -e "    ${DIM}Defaults to the application name set in step 1.${RESET}"
    prompt_value "Short app name" "$CFG_APP_SHORT_NAME" "CFG_APP_SHORT_NAME"
    echo ""
    echo -e "    ${DIM}Description shown by the OS when installing as a PWA.${RESET}"
    prompt_value "App description" "$CFG_APP_DESCRIPTION" "CFG_APP_DESCRIPTION"
    echo ""

    echo -e "  ${BOLD}Icons${RESET}"
    echo -e "    ${DIM}Custom favicon for the browser tab (SVG recommended, 32×32 to 512×512px)${RESET}"
    echo -e "    ${DIM}Leave blank to use the default Bulwark favicon.${RESET}"
    prompt_value "Favicon URL" "$CFG_FAVICON_URL" "CFG_FAVICON_URL"
    echo ""
    echo -e "    ${DIM}Source image for PWA icons (192×192 and 512×512 are auto-generated).${RESET}"
    echo -e "    ${DIM}Falls back to FAVICON_URL if blank.${RESET}"
    prompt_value "PWA icon URL" "$CFG_PWA_ICON_URL" "CFG_PWA_ICON_URL"
    echo ""

    echo -e "  ${BOLD}PWA Colors${RESET}"
    echo -e "    ${DIM}Hex color (e.g. #3b82f6) used for the browser UI chrome when installed.${RESET}"
    prompt_value "PWA theme color" "$CFG_PWA_THEME_COLOR" "CFG_PWA_THEME_COLOR"
    echo ""
    echo -e "    ${DIM}Hex color shown on the PWA splash screen while loading.${RESET}"
    prompt_value "PWA background color" "$CFG_PWA_BACKGROUND_COLOR" "CFG_PWA_BACKGROUND_COLOR"
    echo ""

    echo -e "  ${BOLD}Logos${RESET}"
    echo -e "    ${DIM}App logo shown in the sidebar (SVG recommended, 24×24 to 128×128px)${RESET}"
    echo -e "    ${DIM}Leave blank for no sidebar logo.${RESET}"
    prompt_value "App logo URL (light mode)" "$CFG_APP_LOGO_LIGHT_URL" "CFG_APP_LOGO_LIGHT_URL"
    echo ""
    prompt_value "App logo URL (dark mode)" "$CFG_APP_LOGO_DARK_URL" "CFG_APP_LOGO_DARK_URL"
    echo ""
    echo -e "    ${DIM}Custom logo URLs for the login page (SVG recommended, 32×32 to 512×512px)${RESET}"
    echo -e "    ${DIM}Leave blank to use the default Bulwark logo.${RESET}"
    prompt_value "Login logo URL (light mode)" "$CFG_LOGIN_LOGO_LIGHT_URL" "CFG_LOGIN_LOGO_LIGHT_URL"
    echo ""
    prompt_value "Login logo URL (dark mode)" "$CFG_LOGIN_LOGO_DARK_URL" "CFG_LOGIN_LOGO_DARK_URL"
    echo ""

    echo -e "  ${BOLD}Login Page Links${RESET}"
    echo -e "    ${DIM}Shown on the login page footer. Example: Acme Corp${RESET}"
    prompt_value "Company / organization name" "$CFG_LOGIN_COMPANY_NAME" "CFG_LOGIN_COMPANY_NAME"
    echo ""
    prompt_value "Website URL" "$CFG_LOGIN_WEBSITE_URL" "CFG_LOGIN_WEBSITE_URL"
    echo ""
    prompt_value "Imprint / legal notice URL" "$CFG_LOGIN_IMPRINT_URL" "CFG_LOGIN_IMPRINT_URL"
    echo ""
    prompt_value "Privacy policy URL" "$CFG_LOGIN_PRIVACY_POLICY_URL" "CFG_LOGIN_PRIVACY_POLICY_URL"
    echo ""

    echo -e "  ${BOLD}Extension Directory${RESET}"
    echo -e "    ${DIM}URL of the BulwarkMail extension directory for the admin marketplace.${RESET}"
    echo -e "    ${DIM}Set this to enable browsing and installing plugins/themes.${RESET}"
    echo -e "    ${DIM}Leave blank to disable the marketplace.${RESET}"
    prompt_value "Extension directory URL" "$CFG_EXTENSION_DIRECTORY_URL" "CFG_EXTENSION_DIRECTORY_URL"

    if [[ -z "$CFG_APP_SHORT_NAME" && -z "$CFG_APP_DESCRIPTION" && -z "$CFG_LOGIN_COMPANY_NAME" && -z "$CFG_LOGIN_LOGO_LIGHT_URL" && -z "$CFG_LOGIN_LOGO_DARK_URL" && -z "$CFG_FAVICON_URL" && -z "$CFG_PWA_ICON_URL" && -z "$CFG_PWA_THEME_COLOR" && -z "$CFG_PWA_BACKGROUND_COLOR" && -z "$CFG_APP_LOGO_LIGHT_URL" && -z "$CFG_APP_LOGO_DARK_URL" && -z "$CFG_LOGIN_WEBSITE_URL" && -z "$CFG_LOGIN_IMPRINT_URL" && -z "$CFG_LOGIN_PRIVACY_POLICY_URL" && -z "$CFG_EXTENSION_DIRECTORY_URL" ]]; then
        echo ""
        note "No branding configured. The app will use defaults."
    fi

    draw_footer
    read -r
}

screen_deployment() {
    CURRENT_STEP=6
    draw_header

    section_header 6 "Deployment Method" \
        "Choose how you want to run Bulwark Webmail."

    local docker_available=false
    command -v docker &>/dev/null && docker_available=true

    echo -e "  ${BOLD}Available options:${RESET}"
    echo ""

    menu_select "Choose deployment method:" \
        "Node.js        - Build locally (npm install + npm run build + npm start)" \
        "Docker         - Pull and run a pre-built container image" \
        "Docker Compose - Use the included docker-compose.yml"

    case $MENU_RESULT in
        0) CFG_DEPLOY_METHOD="node" ;;
        1) CFG_DEPLOY_METHOD="docker" ;;
        2) CFG_DEPLOY_METHOD="compose" ;;
    esac

    echo ""

    case "$CFG_DEPLOY_METHOD" in
        "node")
            note "Good for development or when you want full control over the build."
            echo -e "    ${DIM}Requires: Node.js 18+, npm${RESET}"
            ;;
        "docker")
            note "Easiest option for production. No build tools needed on the host."
            echo -e "    ${DIM}Requires: Docker${RESET}"
            ;;
        "compose")
            note "Best for production. Easy to manage with 'docker compose up/down'."
            echo -e "    ${DIM}Requires: Docker + Docker Compose v2${RESET}"
            ;;
    esac

    if [[ "$CFG_DEPLOY_METHOD" != "node" && "$docker_available" == false ]]; then
        echo ""
        echo -e "  ${WARN} ${YELLOW}Docker is not installed on this machine.${RESET}"
        echo -e "       ${YELLOW}You can still generate the .env.local and deploy later.${RESET}"
    fi

    draw_footer
    read -r
}

screen_summary() {
    CURRENT_STEP=7
    draw_header

    section_header 7 "Review Configuration" \
        "Please review your settings before applying."

    # Server
    echo -e "  ${CYAN}${BOLD}SERVER${RESET}"
    echo -e "    App Name .............. ${BOLD}${CFG_APP_NAME}${RESET}"
    echo -e "    JMAP Server URL ....... ${BOLD}${CFG_JMAP_SERVER_URL}${RESET}"
    echo -e "    Allow Custom JMAP ..... ${BOLD}${CFG_ALLOW_CUSTOM_JMAP_ENDPOINT}${RESET}"
    echo -e "    Stalwart Features ..... ${BOLD}${CFG_STALWART_FEATURES}${RESET}"
    echo -e "    Hostname .............. ${BOLD}${CFG_HOSTNAME}${RESET}"
    echo -e "    Port .................. ${BOLD}${CFG_PORT}${RESET}"
    echo ""

    # Auth
    echo -e "  ${CYAN}${BOLD}AUTHENTICATION${RESET}"
    if [[ "$CFG_OAUTH_ENABLED" == "true" ]]; then
        echo -e "    OAuth2/OIDC ........... ${GREEN}${BOLD}Enabled${RESET}"
        echo -e "    OAuth-only mode ....... ${BOLD}${CFG_OAUTH_ONLY}${RESET}"
        echo -e "    Client ID ............. ${BOLD}${CFG_OAUTH_CLIENT_ID}${RESET}"
        [[ -n "$CFG_OAUTH_CLIENT_SECRET" ]] && \
        echo -e "    Client Secret ......... ${BOLD}********${RESET}"
        [[ -n "$CFG_OAUTH_ISSUER_URL" ]] && \
        echo -e "    Issuer URL ............ ${BOLD}${CFG_OAUTH_ISSUER_URL}${RESET}"
    else
        echo -e "    Method ................ ${DIM}Basic Auth only${RESET}"
    fi
    echo ""

    # Security
    echo -e "  ${CYAN}${BOLD}SECURITY${RESET}"
    if [[ -n "$CFG_SESSION_SECRET" ]]; then
        echo -e "    Session Secret ........ ${GREEN}${BOLD}Set${RESET} ${DIM}(Remember me enabled)${RESET}"
        echo -e "    Settings Sync ......... ${BOLD}${CFG_SETTINGS_SYNC_ENABLED}${RESET}"
        [[ "$CFG_SETTINGS_SYNC_ENABLED" == "true" ]] && \
        echo -e "    Settings Directory .... ${BOLD}${CFG_SETTINGS_DATA_DIR}${RESET}"
    else
        echo -e "    Session Secret ........ ${DIM}Not set${RESET}"
    fi
    if [[ "$CFG_TELEMETRY" == "true" ]]; then
        echo -e "    Anonymous Telemetry ... ${GREEN}${BOLD}Enabled${RESET} ${DIM}(thank you!)${RESET}"
    else
        echo -e "    Anonymous Telemetry ... ${DIM}Off${RESET}"
    fi
    echo ""

    # Logging
    echo -e "  ${CYAN}${BOLD}LOGGING${RESET}"
    echo -e "    Format ................ ${BOLD}${CFG_LOG_FORMAT}${RESET}"
    echo -e "    Level ................. ${BOLD}${CFG_LOG_LEVEL}${RESET}"
    echo ""

    # Login page
    echo -e "  ${CYAN}${BOLD}BRANDING${RESET}"
    if [[ -n "$CFG_APP_SHORT_NAME" || -n "$CFG_APP_DESCRIPTION" || -n "$CFG_LOGIN_COMPANY_NAME" || -n "$CFG_LOGIN_LOGO_LIGHT_URL" || -n "$CFG_LOGIN_LOGO_DARK_URL" || -n "$CFG_FAVICON_URL" || -n "$CFG_PWA_ICON_URL" || -n "$CFG_PWA_THEME_COLOR" || -n "$CFG_PWA_BACKGROUND_COLOR" || -n "$CFG_APP_LOGO_LIGHT_URL" || -n "$CFG_APP_LOGO_DARK_URL" || -n "$CFG_LOGIN_WEBSITE_URL" || -n "$CFG_LOGIN_IMPRINT_URL" || -n "$CFG_LOGIN_PRIVACY_POLICY_URL" ]]; then
        [[ -n "$CFG_APP_SHORT_NAME" ]] && \
        echo -e "    Short Name ............ ${BOLD}${CFG_APP_SHORT_NAME}${RESET}"
        [[ -n "$CFG_APP_DESCRIPTION" ]] && \
        echo -e "    Description ........... ${BOLD}${CFG_APP_DESCRIPTION}${RESET}"
        [[ -n "$CFG_FAVICON_URL" ]] && \
        echo -e "    Favicon URL ........... ${BOLD}${CFG_FAVICON_URL}${RESET}"
        [[ -n "$CFG_PWA_ICON_URL" ]] && \
        echo -e "    PWA Icon URL .......... ${BOLD}${CFG_PWA_ICON_URL}${RESET}"
        [[ -n "$CFG_PWA_THEME_COLOR" ]] && \
        echo -e "    PWA Theme Color ....... ${BOLD}${CFG_PWA_THEME_COLOR}${RESET}"
        [[ -n "$CFG_PWA_BACKGROUND_COLOR" ]] && \
        echo -e "    PWA Background Color .. ${BOLD}${CFG_PWA_BACKGROUND_COLOR}${RESET}"
        [[ -n "$CFG_APP_LOGO_LIGHT_URL" ]] && \
        echo -e "    App Logo (light) ...... ${BOLD}${CFG_APP_LOGO_LIGHT_URL}${RESET}"
        [[ -n "$CFG_APP_LOGO_DARK_URL" ]] && \
        echo -e "    App Logo (dark) ....... ${BOLD}${CFG_APP_LOGO_DARK_URL}${RESET}"
        [[ -n "$CFG_LOGIN_COMPANY_NAME" ]] && \
        echo -e "    Company Name .......... ${BOLD}${CFG_LOGIN_COMPANY_NAME}${RESET}"
        [[ -n "$CFG_LOGIN_LOGO_LIGHT_URL" ]] && \
        echo -e "    Login Logo (light) .... ${BOLD}${CFG_LOGIN_LOGO_LIGHT_URL}${RESET}"
        [[ -n "$CFG_LOGIN_LOGO_DARK_URL" ]] && \
        echo -e "    Login Logo (dark) ..... ${BOLD}${CFG_LOGIN_LOGO_DARK_URL}${RESET}"
        [[ -n "$CFG_LOGIN_WEBSITE_URL" ]] && \
        echo -e "    Website URL ........... ${BOLD}${CFG_LOGIN_WEBSITE_URL}${RESET}"
        [[ -n "$CFG_LOGIN_IMPRINT_URL" ]] && \
        echo -e "    Imprint URL ........... ${BOLD}${CFG_LOGIN_IMPRINT_URL}${RESET}"
        [[ -n "$CFG_LOGIN_PRIVACY_POLICY_URL" ]] && \
        echo -e "    Privacy Policy URL .... ${BOLD}${CFG_LOGIN_PRIVACY_POLICY_URL}${RESET}"
    else
        echo -e "    ${DIM}(using defaults)${RESET}"
    fi
    echo ""

    # Extensions
    if [[ -n "$CFG_EXTENSION_DIRECTORY_URL" ]]; then
        echo -e "  ${CYAN}${BOLD}EXTENSIONS${RESET}"
        echo -e "    Directory URL ......... ${BOLD}${CFG_EXTENSION_DIRECTORY_URL}${RESET}"
        echo ""
    fi

    # Deployment
    echo -e "  ${CYAN}${BOLD}DEPLOYMENT${RESET}"
    case "$CFG_DEPLOY_METHOD" in
        "node")    echo -e "    Method ................ ${BOLD}Node.js (local build)${RESET}" ;;
        "docker")  echo -e "    Method ................ ${BOLD}Docker (container)${RESET}" ;;
        "compose") echo -e "    Method ................ ${BOLD}Docker Compose${RESET}" ;;
    esac

    echo ""
    hr
    echo ""

    local confirm
    prompt_yesno "Apply this configuration and proceed?" "true" "confirm"

    if [[ "$confirm" != "true" ]]; then
        echo ""
        echo -e "  ${YELLOW}Setup cancelled. No files were modified.${RESET}"
        echo ""
        show_cursor
        exit 0
    fi
}

# -- Write Configuration -----------------------------------------------------

write_env_file() {
    if [[ "$DRY_RUN" == true ]]; then
        echo -e "    ${DIM}[dry-run] Would back up existing .env.local${RESET}"
        echo -e "    ${DIM}[dry-run] Would write .env.local with the above configuration${RESET}"
        return
    fi

    # Backup existing if present
    if [[ -f "$ENV_FILE" ]]; then
        local backup="${ENV_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$ENV_FILE" "$backup"
        echo -e "    ${OK} Backed up existing .env.local --> $(basename "$backup")"
    fi

    cat > "$ENV_FILE" << ENVEOF
# =============================================================================
# Bulwark Webmail -- Configuration
# Generated by setup.sh on $(date '+%Y-%m-%d %H:%M:%S')
# =============================================================================

# -- JMAP Server (required) ---------------------------------------------------
APP_NAME=${CFG_APP_NAME}
JMAP_SERVER_URL=${CFG_JMAP_SERVER_URL}
ALLOW_CUSTOM_JMAP_ENDPOINT=${CFG_ALLOW_CUSTOM_JMAP_ENDPOINT}

# -- Stalwart Mail Server Integration -----------------------------------------
STALWART_FEATURES=${CFG_STALWART_FEATURES}

# -- Server Listen Address ----------------------------------------------------
HOSTNAME=${CFG_HOSTNAME}
PORT=${CFG_PORT}

# -- OAuth / OpenID Connect ---------------------------------------------------
OAUTH_ENABLED=${CFG_OAUTH_ENABLED}
ENVEOF

    if [[ "$CFG_OAUTH_ENABLED" == "true" ]]; then
        cat >> "$ENV_FILE" << ENVEOF
OAUTH_ONLY=${CFG_OAUTH_ONLY}
OAUTH_CLIENT_ID=${CFG_OAUTH_CLIENT_ID}
ENVEOF
        [[ -n "$CFG_OAUTH_CLIENT_SECRET" ]] && echo "OAUTH_CLIENT_SECRET=${CFG_OAUTH_CLIENT_SECRET}" >> "$ENV_FILE"
        [[ -n "$CFG_OAUTH_ISSUER_URL" ]] && echo "OAUTH_ISSUER_URL=${CFG_OAUTH_ISSUER_URL}" >> "$ENV_FILE"
    fi

    cat >> "$ENV_FILE" << ENVEOF

# -- Session & Security -------------------------------------------------------
ENVEOF

    if [[ -n "$CFG_SESSION_SECRET" ]]; then
        echo "SESSION_SECRET=${CFG_SESSION_SECRET}" >> "$ENV_FILE"
    else
        echo "# SESSION_SECRET=" >> "$ENV_FILE"
    fi

    cat >> "$ENV_FILE" << ENVEOF

# -- Settings Sync -------------------------------------------------------------
SETTINGS_SYNC_ENABLED=${CFG_SETTINGS_SYNC_ENABLED}
ENVEOF

    if [[ "$CFG_SETTINGS_SYNC_ENABLED" == "true" ]]; then
        echo "SETTINGS_DATA_DIR=${CFG_SETTINGS_DATA_DIR}" >> "$ENV_FILE"
    fi

    cat >> "$ENV_FILE" << ENVEOF

# -- Anonymous Telemetry -------------------------------------------------------
# Opt-in, anonymous heartbeats (no PII). Off by default; helps improve Bulwark.
# Toggleable later in the admin UI unless this is set. See
# https://bulwarkmail.org/docs/legal/privacy/telemetry
ENVEOF

    if [[ "$CFG_TELEMETRY" == "true" ]]; then
        echo "BULWARK_TELEMETRY=on" >> "$ENV_FILE"
    else
        echo "# BULWARK_TELEMETRY=on" >> "$ENV_FILE"
    fi

    cat >> "$ENV_FILE" << ENVEOF

# -- Logging -------------------------------------------------------------------
LOG_FORMAT=${CFG_LOG_FORMAT}
LOG_LEVEL=${CFG_LOG_LEVEL}

# -- Branding ------------------------------------------------------------------
ENVEOF

    [[ -n "$CFG_APP_SHORT_NAME" ]] && echo "APP_SHORT_NAME=${CFG_APP_SHORT_NAME}" >> "$ENV_FILE"
    [[ -n "$CFG_APP_DESCRIPTION" ]] && echo "APP_DESCRIPTION=${CFG_APP_DESCRIPTION}" >> "$ENV_FILE"
    [[ -n "$CFG_FAVICON_URL" ]] && echo "FAVICON_URL=${CFG_FAVICON_URL}" >> "$ENV_FILE"
    [[ -n "$CFG_PWA_ICON_URL" ]] && echo "PWA_ICON_URL=${CFG_PWA_ICON_URL}" >> "$ENV_FILE"
    [[ -n "$CFG_PWA_THEME_COLOR" ]] && echo "PWA_THEME_COLOR=${CFG_PWA_THEME_COLOR}" >> "$ENV_FILE"
    [[ -n "$CFG_PWA_BACKGROUND_COLOR" ]] && echo "PWA_BACKGROUND_COLOR=${CFG_PWA_BACKGROUND_COLOR}" >> "$ENV_FILE"
    [[ -n "$CFG_APP_LOGO_LIGHT_URL" ]] && echo "APP_LOGO_LIGHT_URL=${CFG_APP_LOGO_LIGHT_URL}" >> "$ENV_FILE"
    [[ -n "$CFG_APP_LOGO_DARK_URL" ]] && echo "APP_LOGO_DARK_URL=${CFG_APP_LOGO_DARK_URL}" >> "$ENV_FILE"
    [[ -n "$CFG_LOGIN_COMPANY_NAME" ]] && echo "LOGIN_COMPANY_NAME=${CFG_LOGIN_COMPANY_NAME}" >> "$ENV_FILE"
    [[ -n "$CFG_LOGIN_LOGO_LIGHT_URL" ]] && echo "LOGIN_LOGO_LIGHT_URL=${CFG_LOGIN_LOGO_LIGHT_URL}" >> "$ENV_FILE"
    [[ -n "$CFG_LOGIN_LOGO_DARK_URL" ]] && echo "LOGIN_LOGO_DARK_URL=${CFG_LOGIN_LOGO_DARK_URL}" >> "$ENV_FILE"
    [[ -n "$CFG_LOGIN_IMPRINT_URL" ]] && echo "LOGIN_IMPRINT_URL=${CFG_LOGIN_IMPRINT_URL}" >> "$ENV_FILE"
    [[ -n "$CFG_LOGIN_PRIVACY_POLICY_URL" ]] && echo "LOGIN_PRIVACY_POLICY_URL=${CFG_LOGIN_PRIVACY_POLICY_URL}" >> "$ENV_FILE"
    [[ -n "$CFG_LOGIN_WEBSITE_URL" ]] && echo "LOGIN_WEBSITE_URL=${CFG_LOGIN_WEBSITE_URL}" >> "$ENV_FILE"

    if [[ -n "$CFG_EXTENSION_DIRECTORY_URL" ]]; then
        cat >> "$ENV_FILE" << ENVEOF

# -- Extension Directory / Marketplace ----------------------------------------
EXTENSION_DIRECTORY_URL=${CFG_EXTENSION_DIRECTORY_URL}
ENVEOF
    fi

    cat >> "$ENV_FILE" << ENVEOF

# -- Advanced (uncomment and set if needed) -----------------------------------
# SESSION_SECRET_FILE=/run/secrets/session_secret
# OAUTH_CLIENT_SECRET_FILE=/run/secrets/oauth_client_secret
# OAUTH_SCOPES=openid profile email
# OAUTH_EXTRA_SCOPES=
# COOKIE_SAME_SITE=lax
# COOKIE_SECURE=true
# TRUSTED_PROXY_DEPTH=1
# ALLOWED_FRAME_ANCESTORS='none'
# ADMIN_DATA_DIR=./data/admin
# ADMIN_SESSION_TTL=3600
ENVEOF

    echo -e "    ${OK} Written ${BOLD}.env.local${RESET}"
}

update_docker_compose_port() {
    if [[ "$CFG_PORT" != "3000" && -f "${SCRIPT_DIR}/docker-compose.yml" ]]; then
        if [[ "$DRY_RUN" == true ]]; then
            echo -e "    ${DIM}[dry-run] Would update docker-compose.yml port --> ${CFG_PORT}:3000${RESET}"
            return
        fi
        sed -i.bak "s/\"3000:3000\"/\"${CFG_PORT}:3000\"/" "${SCRIPT_DIR}/docker-compose.yml" 2>/dev/null || true
        echo -e "    ${OK} Updated docker-compose.yml port mapping"
    fi
}

# Ensure a source checkout is available for build-based deployments.
# When setup.sh is run on its own (e.g. piped via `curl ... | bash`), SCRIPT_DIR
# resolves to the user's cwd, which has no package.json -- so npm/compose run in
# the wrong place. In that case, clone the repo and repoint SCRIPT_DIR at it.
ensure_repo() {
    # Already inside a checkout -- nothing to do.
    [[ -f "${SCRIPT_DIR}/package.json" ]] && return 0

    echo ""
    echo -e "  ${WARN} ${YELLOW}No source checkout found in ${SCRIPT_DIR}.${RESET}"
    echo -e "       ${DIM}(setup.sh was run on its own, e.g. via curl | bash)${RESET}"
    echo ""

    if [[ "$DRY_RUN" == true ]]; then
        echo -e "    ${DIM}[dry-run] Would clone ${REPO_URL} into ./webmail${RESET}"
        return 0
    fi

    if ! command -v git &>/dev/null; then
        echo -e "    ${FAIL} ${RED}git is required to fetch the source but was not found.${RESET}"
        echo -e "         ${DIM}Install git, or clone the repo manually and run setup.sh from inside it:${RESET}"
        echo -e "         ${CYAN}git clone ${REPO_URL}${RESET}"
        echo -e "         ${CYAN}cd webmail && bash setup.sh${RESET}"
        show_cursor
        exit 1
    fi

    local target="$(pwd)/webmail"
    prompt_value "Directory to clone the source into" "$target" "target"

    if [[ -e "$target" && -n "$(ls -A "$target" 2>/dev/null)" ]]; then
        if [[ -f "$target/package.json" ]]; then
            echo -e "    ${OK} Using existing checkout at ${target}"
        else
            echo -e "    ${FAIL} ${RED}${target} exists and is not an empty dir or a checkout.${RESET}"
            show_cursor
            exit 1
        fi
    else
        (git clone --depth 1 "$REPO_URL" "$target" >/dev/null 2>&1) &
        spinner $! "Cloning ${REPO_URL}"
        if [[ ! -f "$target/package.json" ]]; then
            echo -e "    ${FAIL} ${RED}Clone failed -- ${target}/package.json not found.${RESET}"
            show_cursor
            exit 1
        fi
    fi

    SCRIPT_DIR="$target"
    ENV_FILE="${SCRIPT_DIR}/.env.local"
}

run_deployment() {
    echo ""

    if [[ "$DRY_RUN" == true ]]; then
        echo -e "  ${BOLD}Deployment Preview${RESET}"
        echo ""
        case "$CFG_DEPLOY_METHOD" in
            "node")
                echo -e "    ${DIM}[dry-run] Would run:  npm install${RESET}"
                echo -e "    ${DIM}[dry-run] Would run:  npm run build${RESET}"
                echo -e "    ${DIM}[dry-run] Would start: npm start (port ${CFG_PORT})${RESET}"
                ;;
            "docker")
                echo -e "    ${DIM}[dry-run] Would run:  docker pull ghcr.io/bulwarkmail/webmail:latest${RESET}"
                echo -e "    ${DIM}[dry-run] Would start: container on port ${CFG_PORT}${RESET}"
                ;;
            "compose")
                echo -e "    ${DIM}[dry-run] Would update: docker-compose.yml port mapping${RESET}"
                echo -e "    ${DIM}[dry-run] Would run:    docker compose up -d${RESET}"
                ;;
        esac
        return
    fi

    case "$CFG_DEPLOY_METHOD" in
        "node")
            echo -e "  ${BOLD}Building...${RESET}"
            echo ""
            (cd "$SCRIPT_DIR" && npm install --loglevel=warn) &
            spinner $! "Installing npm packages"

            (cd "$SCRIPT_DIR" && npm run build 2>&1 | tail -5) &
            spinner $! "Building Next.js application"

            echo ""
            echo -e "    ${OK} Build complete!"
            echo ""
            echo -e "  ${BOLD}To start the application:${RESET}"
            echo ""
            echo -e "    ${CYAN}cd ${SCRIPT_DIR}${RESET}"
            if [[ "$CFG_PORT" != "3000" ]]; then
                echo -e "    ${CYAN}PORT=${CFG_PORT} npm start${RESET}"
            else
                echo -e "    ${CYAN}npm start${RESET}"
            fi
            ;;

        "docker")
            echo -e "  ${BOLD}Pulling Docker image...${RESET}"
            echo ""
            (docker pull ghcr.io/bulwarkmail/webmail:latest 2>&1) &
            spinner $! "Pulling ghcr.io/bulwarkmail/webmail:latest"

            echo ""
            echo -e "    ${OK} Image pulled!"
            echo ""
            echo -e "  ${BOLD}To run the container:${RESET}"
            echo ""
            echo -e "    ${CYAN}docker run -d \\${RESET}"
            echo -e "    ${CYAN}  --name bulwark-webmail \\${RESET}"
            echo -e "    ${CYAN}  -p ${CFG_PORT}:3000 \\${RESET}"
            echo -e "    ${CYAN}  --env-file .env.local \\${RESET}"
            echo -e "    ${CYAN}  --restart unless-stopped \\${RESET}"
            echo -e "    ${CYAN}  ghcr.io/bulwarkmail/webmail:latest${RESET}"
            ;;

        "compose")
            update_docker_compose_port

            echo -e "  ${BOLD}Starting services...${RESET}"
            echo ""
            (cd "$SCRIPT_DIR" && docker compose up -d 2>&1) &
            spinner $! "Starting Docker Compose services"

            echo ""
            echo -e "    ${OK} Services started!"
            echo ""
            echo -e "  ${BOLD}Manage with:${RESET}"
            echo ""
            echo -e "    ${CYAN}docker compose logs -f${RESET}     ${DIM}# View logs${RESET}"
            echo -e "    ${CYAN}docker compose restart${RESET}     ${DIM}# Restart${RESET}"
            echo -e "    ${CYAN}docker compose down${RESET}        ${DIM}# Stop${RESET}"
            ;;
    esac
}

# -- Completion Screen --------------------------------------------------------

screen_complete() {
    draw_header

    echo ""
    if [[ "$DRY_RUN" == true ]]; then
        box "DRY RUN COMPLETE" "$MAGENTA"
    else
        box "SETUP COMPLETE" "$GREEN"
    fi
    echo ""

    echo -e "  ${BOLD}Configuration${RESET}"
    echo ""

    # Build-based methods need the repo source. If we're running detached
    # (curl | bash), fetch it now and repoint SCRIPT_DIR/ENV_FILE before we
    # write .env.local or run the build.
    if [[ "$CFG_DEPLOY_METHOD" == "node" || "$CFG_DEPLOY_METHOD" == "compose" ]]; then
        ensure_repo
    fi

    write_env_file

    run_deployment

    echo ""
    hr
    echo ""

    local url="http://localhost:${CFG_PORT}"
    print_center "${BOLD}Your webmail will be available at:${RESET}"
    echo ""
    print_center "${CYAN}${BOLD}${url}${RESET}"
    echo ""

    echo -e "  ${BOLD}Next steps:${RESET}"
    echo ""
    echo -e "    ${STAR} Edit ${BOLD}.env.local${RESET} to change settings at any time"
    echo -e "    ${STAR} Read ${BOLD}README.md${RESET} for full documentation"
    echo -e "    ${STAR} Run ${CYAN}bash setup.sh${RESET} again to reconfigure"
    echo ""
    hr
    echo ""
    print_center "${DIM}Thank you for using Bulwark Webmail!${RESET}"
    echo ""
}

# -- Signal Handling ----------------------------------------------------------

cleanup() {
    show_cursor
    clear_screen
    echo ""
    echo -e "  ${YELLOW}Setup interrupted. No changes were made.${RESET}"
    echo ""
    exit 1
}

trap cleanup INT TERM

# -- Main ---------------------------------------------------------------------

main() {
    get_term_size
    if [[ $TERM_COLS -lt 60 || $TERM_ROWS -lt 20 ]]; then
        echo "Terminal too small. Minimum: 60x20 (current: ${TERM_COLS}x${TERM_ROWS})"
        exit 1
    fi

    if [[ -f "$ENV_FILE" ]]; then
        load_existing_config
    fi

    hide_cursor

    screen_welcome
    screen_server_config
    screen_auth_config
    screen_security_config
    screen_logging_config
    screen_login_customization
    screen_deployment
    screen_summary
    screen_complete

    show_cursor
}

load_existing_config() {
    local val
    get_env_val() {
        local key="$1"
        val=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2-)
        val="${val#\"}" ; val="${val%\"}"
        val="${val#\'}" ; val="${val%\'}"
    }

    get_env_val "APP_NAME";                 [[ -n "$val" ]] && CFG_APP_NAME="$val"
    get_env_val "JMAP_SERVER_URL";          [[ -n "$val" ]] && CFG_JMAP_SERVER_URL="$val"
    get_env_val "STALWART_FEATURES";        [[ -n "$val" ]] && CFG_STALWART_FEATURES="$val"
    get_env_val "OAUTH_ENABLED";            [[ -n "$val" ]] && CFG_OAUTH_ENABLED="$val"
    get_env_val "OAUTH_ONLY";              [[ -n "$val" ]] && CFG_OAUTH_ONLY="$val"
    get_env_val "OAUTH_CLIENT_ID";          [[ -n "$val" ]] && CFG_OAUTH_CLIENT_ID="$val"
    get_env_val "OAUTH_CLIENT_SECRET";      [[ -n "$val" ]] && CFG_OAUTH_CLIENT_SECRET="$val"
    get_env_val "OAUTH_ISSUER_URL";         [[ -n "$val" ]] && CFG_OAUTH_ISSUER_URL="$val"
    get_env_val "SESSION_SECRET";           [[ -n "$val" ]] && CFG_SESSION_SECRET="$val"
    get_env_val "SETTINGS_SYNC_ENABLED";    [[ -n "$val" ]] && CFG_SETTINGS_SYNC_ENABLED="$val"
    get_env_val "SETTINGS_DATA_DIR";        [[ -n "$val" ]] && CFG_SETTINGS_DATA_DIR="$val"
    get_env_val "BULWARK_TELEMETRY"
    case "$(echo "$val" | tr '[:upper:]' '[:lower:]')" in
        on|true|1|yes)  CFG_TELEMETRY="true" ;;
        off|false|0|no) CFG_TELEMETRY="false" ;;
    esac
    get_env_val "LOG_FORMAT";               [[ -n "$val" ]] && CFG_LOG_FORMAT="$val"
    get_env_val "LOG_LEVEL";                [[ -n "$val" ]] && CFG_LOG_LEVEL="$val"
    get_env_val "LOGIN_COMPANY_NAME";       [[ -n "$val" ]] && CFG_LOGIN_COMPANY_NAME="$val"
    get_env_val "LOGIN_LOGO_LIGHT_URL";      [[ -n "$val" ]] && CFG_LOGIN_LOGO_LIGHT_URL="$val"
    get_env_val "LOGIN_LOGO_DARK_URL";       [[ -n "$val" ]] && CFG_LOGIN_LOGO_DARK_URL="$val"
    get_env_val "LOGIN_IMPRINT_URL";        [[ -n "$val" ]] && CFG_LOGIN_IMPRINT_URL="$val"
    get_env_val "LOGIN_PRIVACY_POLICY_URL"; [[ -n "$val" ]] && CFG_LOGIN_PRIVACY_POLICY_URL="$val"
    get_env_val "LOGIN_WEBSITE_URL";        [[ -n "$val" ]] && CFG_LOGIN_WEBSITE_URL="$val"
}

# When piped (e.g. curl | bash), reopen stdin from the terminal
if [[ -t 0 ]]; then
    main "$@"
elif [[ -r /dev/tty ]] 2>/dev/null && (echo < /dev/tty) 2>/dev/null; then
    main "$@" < /dev/tty
else
    echo "Error: No interactive terminal available."
    echo "Download and run the script directly instead:"
    echo "  curl -fsSL https://raw.githubusercontent.com/bulwarkmail/webmail/main/setup.sh -o setup.sh"
    echo "  bash setup.sh --dry-run"
    exit 1
fi
