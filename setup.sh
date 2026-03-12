#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# JMAP Webmail — Interactive Setup Script
# Fullscreen terminal installer for configuring and deploying JMAP Webmail
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── CLI Flags ───────────────────────────────────────────────────────────────
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

# ── Colors & Symbols ────────────────────────────────────────────────────────
BOLD='\033[1m'
DIM='\033[2m'
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
BG_RED='\033[41m'
BG_MAGENTA='\033[45m'
BG_CYAN='\033[46m'
BG_DARK='\033[40m'

CHECKMARK="${GREEN}✓${RESET}"
CROSSMARK="${RED}✗${RESET}"
ARROW="${CYAN}➜${RESET}"
DOT="${DIM}·${RESET}"
BULLET="${BLUE}●${RESET}"

# ── State ───────────────────────────────────────────────────────────────────
set +u
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
    SCRIPT_DIR="$(pwd)"
fi
set -u
ENV_FILE="${SCRIPT_DIR}/.env.local"

# Config values (defaults)
CFG_APP_NAME="JMAP Webmail"
CFG_JMAP_SERVER_URL=""
CFG_STALWART_FEATURES="true"
CFG_OAUTH_ENABLED="false"
CFG_OAUTH_ONLY="false"
CFG_OAUTH_CLIENT_ID=""
CFG_OAUTH_CLIENT_SECRET=""
CFG_OAUTH_ISSUER_URL=""
CFG_SESSION_SECRET=""
CFG_SETTINGS_SYNC_ENABLED="false"
CFG_SETTINGS_DATA_DIR="./data/settings"
CFG_LOG_FORMAT="text"
CFG_LOG_LEVEL="info"
CFG_LOGIN_COMPANY_NAME=""
CFG_LOGIN_IMPRINT_URL=""
CFG_LOGIN_PRIVACY_POLICY_URL=""
CFG_LOGIN_WEBSITE_URL=""
CFG_DEPLOY_METHOD="" # "docker" | "node" | "compose"
CFG_PORT="3000"

# Navigation
CURRENT_STEP=0
TOTAL_STEPS=7

# ── Terminal Utilities ──────────────────────────────────────────────────────
get_term_size() {
    TERM_COLS=$(tput cols 2>/dev/null || echo 80)
    TERM_ROWS=$(tput lines 2>/dev/null || echo 24)
}

clear_screen() {
    printf '\033[2J\033[H'
}

hide_cursor() {
    printf '\033[?25l'
}

show_cursor() {
    printf '\033[?25h'
}

move_to() {
    printf '\033[%d;%dH' "$1" "$2"
}

# Print centered text
print_center() {
    local text="$1"
    local clean_text
    clean_text=$(echo -e "$text" | sed 's/\x1b\[[0-9;]*m//g')
    local padding=$(( (TERM_COLS - ${#clean_text}) / 2 ))
    [[ $padding -lt 0 ]] && padding=0
    printf "%${padding}s" ""
    echo -e "$text"
}

# Print a horizontal rule
print_hr() {
    local char="${1:-─}"
    local color="${2:-$DIM}"
    echo -e "${color}$(printf '%*s' "$TERM_COLS" '' | tr ' ' "$char")${RESET}"
}

# Print text right-aligned
print_right() {
    local text="$1"
    local clean_text
    clean_text=$(echo -e "$text" | sed 's/\x1b\[[0-9;]*m//g')
    local padding=$(( TERM_COLS - ${#clean_text} ))
    [[ $padding -lt 0 ]] && padding=0
    printf "%${padding}s" ""
    echo -e "$text"
}

# Read a single key press
read_key() {
    local key
    IFS= read -rsn1 key
    # Handle escape sequences (arrow keys, etc.)
    if [[ "$key" == $'\x1b' ]]; then
        read -rsn2 -t 0.1 key2 || true
        key="${key}${key2}"
    fi
    echo "$key"
}

# Prompt with default value
prompt_value() {
    local label="$1"
    local default="$2"
    local var_name="$3"
    local required="${4:-false}"

    show_cursor
    if [[ -n "$default" ]]; then
        echo -ne "  ${BOLD}${label}${RESET} ${DIM}[${default}]${RESET}: "
    else
        echo -ne "  ${BOLD}${label}${RESET}: "
    fi

    local input
    read -r input
    input="${input:-$default}"

    if [[ "$required" == "true" && -z "$input" ]]; then
        echo -e "  ${RED}This field is required.${RESET}"
        prompt_value "$label" "$default" "$var_name" "$required"
        return
    fi

    eval "$var_name='$input'"
    hide_cursor
}

# Yes/No selector
prompt_yesno() {
    local label="$1"
    local default="$2"  # "true" or "false"
    local var_name="$3"

    local yn_display
    if [[ "$default" == "true" ]]; then
        yn_display="${GREEN}${BOLD}Y${RESET}${DIM}/n${RESET}"
    else
        yn_display="${DIM}y/${RESET}${GREEN}${BOLD}N${RESET}"
    fi

    show_cursor
    echo -ne "  ${BOLD}${label}${RESET} [${yn_display}]: "

    local input
    read -r input
    input=$(echo "$input" | tr '[:upper:]' '[:lower:]')

    case "$input" in
        y|yes) eval "$var_name='true'" ;;
        n|no)  eval "$var_name='false'" ;;
        "")    eval "$var_name='$default'" ;;
        *)     eval "$var_name='$default'" ;;
    esac
    hide_cursor
}

# Interactive menu selector
menu_select() {
    local label="$1"
    shift
    local options=("$@")
    local selected=0
    local count=${#options[@]}

    hide_cursor
    echo -e "  ${BOLD}${label}${RESET}"
    echo ""

    # Save cursor position
    local start_row
    start_row=$(get_cursor_row)

    while true; do
        # Move back to the start
        for (( i=0; i<count; i++ )); do
            if [[ $i -eq $selected ]]; then
                echo -e "    ${BG_BLUE}${WHITE} ${options[$i]} ${RESET}  "
            else
                echo -e "    ${DIM} ${options[$i]} ${RESET}  "
            fi
        done
        echo ""
        echo -e "  ${DIM}↑↓ navigate · Enter select${RESET}"

        local key
        key=$(read_key)

        case "$key" in
            $'\x1b[A') # Up
                selected=$(( (selected - 1 + count) % count ))
                ;;
            $'\x1b[B') # Down
                selected=$(( (selected + 1) % count ))
                ;;
            "") # Enter
                break
                ;;
        esac

        # Move cursor back up
        local lines_up=$(( count + 2 ))
        printf '\033[%dA' "$lines_up"
    done

    show_cursor
    MENU_RESULT=$selected
    MENU_VALUE="${options[$selected]}"
}

get_cursor_row() {
    local pos
    IFS=';' read -sdR -p $'\033[6n' pos
    echo "${pos#*[}"
}

# Progress bar
draw_progress() {
    local current="$1"
    local total="$2"
    local width=$(( TERM_COLS - 20 ))
    [[ $width -gt 60 ]] && width=60
    local filled=$(( width * current / total ))
    local empty=$(( width - filled ))

    echo -ne "  ${DIM}["
    [[ $filled -gt 0 ]] && printf "${GREEN}%${filled}s${RESET}" '' | tr ' ' '█'
    [[ $empty -gt 0 ]] && printf "${DIM}%${empty}s${RESET}" '' | tr ' ' '░'
    echo -e "${DIM}]${RESET} ${BOLD}${current}${RESET}${DIM}/${total}${RESET}"
}

# Spinner for async operations
spinner() {
    local pid=$1
    local message="${2:-Working...}"
    local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
    local i=0

    hide_cursor
    while kill -0 "$pid" 2>/dev/null; do
        echo -ne "\r  ${CYAN}${frames[$i]}${RESET} ${message}"
        i=$(( (i + 1) % ${#frames[@]} ))
        sleep 0.08
    done
    echo -ne "\r  ${CHECKMARK} ${message}    \n"
    show_cursor
}

# ── Screen Rendering ────────────────────────────────────────────────────────

draw_header() {
    get_term_size
    clear_screen

    echo ""
    print_center "${BG_BLUE}${WHITE}${BOLD}                                            ${RESET}"
    print_center "${BG_BLUE}${WHITE}${BOLD}          JMAP WEBMAIL  SETUP          ${RESET}"
    print_center "${BG_BLUE}${WHITE}${BOLD}                                            ${RESET}"
    echo ""

    if [[ "$DRY_RUN" == true ]]; then
        print_center "${BG_MAGENTA}${WHITE}${BOLD} DRY RUN — no files will be written ${RESET}"
        echo ""
    fi

    if [[ $CURRENT_STEP -gt 0 ]]; then
        draw_progress "$CURRENT_STEP" "$TOTAL_STEPS"
        echo ""
    fi
    print_hr "─"
    echo ""
}

draw_footer() {
    echo ""
    print_hr "─"
    echo ""
    if [[ $CURRENT_STEP -eq 0 ]]; then
        print_center "${DIM}Press Enter to begin${RESET}"
    elif [[ $CURRENT_STEP -le $TOTAL_STEPS ]]; then
        print_center "${DIM}Press Enter to continue · Ctrl+C to abort${RESET}"
    fi
}

# ── Screens ─────────────────────────────────────────────────────────────────

screen_welcome() {
    CURRENT_STEP=0
    draw_header

    local version
    version=$(cat "${SCRIPT_DIR}/VERSION" 2>/dev/null || echo "unknown")

    print_center "${BOLD}Welcome to the JMAP Webmail installer${RESET}"
    echo ""
    print_center "${DIM}Version ${version}${RESET}"
    echo ""
    echo ""
    print_center "This script will guide you through:"
    echo ""
    print_center "${BULLET} Configuring your JMAP mail server connection"
    print_center "${BULLET} Setting up authentication (Basic / OAuth2)"
    print_center "${BULLET} Configuring security & session settings"
    print_center "${BULLET} Customizing the login page"
    print_center "${BULLET} Choosing a deployment method"
    print_center "${BULLET} Installing dependencies & building"
    echo ""
    echo ""

    # System checks
    print_center "${BOLD}System Check${RESET}"
    echo ""

    local all_ok=true

    # Node.js
    if command -v node &>/dev/null; then
        local node_ver
        node_ver=$(node --version)
        print_center "${CHECKMARK} Node.js ${node_ver}"
    else
        print_center "${CROSSMARK} Node.js not found"
        all_ok=false
    fi

    # npm
    if command -v npm &>/dev/null; then
        local npm_ver
        npm_ver=$(npm --version)
        print_center "${CHECKMARK} npm v${npm_ver}"
    else
        print_center "${CROSSMARK} npm not found"
        all_ok=false
    fi

    # Docker
    if command -v docker &>/dev/null; then
        local docker_ver
        docker_ver=$(docker --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1 || echo "installed")
        print_center "${CHECKMARK} Docker v${docker_ver}"
    else
        print_center "${DIM}${DOT} Docker not found (optional)${RESET}"
    fi

    # Git
    if command -v git &>/dev/null; then
        local git_ver
        git_ver=$(git --version | grep -oP '\d+\.\d+\.\d+' || echo "installed")
        print_center "${CHECKMARK} Git v${git_ver}"
    else
        print_center "${DIM}${DOT} Git not found (optional)${RESET}"
    fi

    # openssl
    if command -v openssl &>/dev/null; then
        print_center "${CHECKMARK} OpenSSL available"
    else
        print_center "${DIM}${DOT} OpenSSL not found (can generate secrets manually)${RESET}"
    fi

    echo ""

    if [[ "$all_ok" == false ]]; then
        echo ""
        print_center "${YELLOW}⚠  Some required tools are missing.${RESET}"
        print_center "${YELLOW}   Install Node.js 18+ before continuing.${RESET}"
    fi

    draw_footer
    read -r
}

screen_server_config() {
    CURRENT_STEP=1
    draw_header

    print_center "${BOLD}${CYAN}Step 1: Server Configuration${RESET}"
    echo ""
    echo ""

    echo -e "  ${BOLD}Configure your JMAP mail server connection.${RESET}"
    echo -e "  ${DIM}This is the URL of your Stalwart (or compatible) mail server.${RESET}"
    echo ""

    prompt_value "Application name" "$CFG_APP_NAME" "CFG_APP_NAME"
    echo ""
    prompt_value "JMAP Server URL" "$CFG_JMAP_SERVER_URL" "CFG_JMAP_SERVER_URL" "true"
    echo ""

    # Validate URL format
    if [[ "$CFG_JMAP_SERVER_URL" =~ ^https?:// ]]; then
        echo -e "  ${CHECKMARK} URL format looks valid"
    else
        echo -e "  ${YELLOW}⚠  URL should start with https:// or http://${RESET}"
        prompt_value "JMAP Server URL" "https://${CFG_JMAP_SERVER_URL}" "CFG_JMAP_SERVER_URL" "true"
    fi

    echo ""
    prompt_yesno "Enable Stalwart-specific features? (password change, sieve filters)" "$CFG_STALWART_FEATURES" "CFG_STALWART_FEATURES"

    echo ""
    echo -e "  ${DIM}Select the port to run on:${RESET}"
    prompt_value "Port" "$CFG_PORT" "CFG_PORT"

    draw_footer
    read -r
}

screen_auth_config() {
    CURRENT_STEP=2
    draw_header

    print_center "${BOLD}${CYAN}Step 2: Authentication${RESET}"
    echo ""
    echo ""

    echo -e "  ${BOLD}Configure how users authenticate.${RESET}"
    echo -e "  ${DIM}Basic Auth is always available. You can add OAuth2/OIDC for SSO.${RESET}"
    echo ""

    prompt_yesno "Enable OAuth2/OIDC?" "$CFG_OAUTH_ENABLED" "CFG_OAUTH_ENABLED"

    if [[ "$CFG_OAUTH_ENABLED" == "true" ]]; then
        echo ""
        echo -e "  ${ARROW} ${BOLD}OAuth2 Configuration${RESET}"
        echo ""

        prompt_yesno "OAuth-only mode? (hides password form)" "$CFG_OAUTH_ONLY" "CFG_OAUTH_ONLY"
        echo ""
        prompt_value "OAuth Client ID" "$CFG_OAUTH_CLIENT_ID" "CFG_OAUTH_CLIENT_ID" "true"
        echo ""
        prompt_value "OAuth Client Secret" "$CFG_OAUTH_CLIENT_SECRET" "CFG_OAUTH_CLIENT_SECRET"
        echo -e "  ${DIM}Leave empty for public clients (PKCE-only).${RESET}"
        echo ""
        prompt_value "OAuth Issuer URL" "$CFG_OAUTH_ISSUER_URL" "CFG_OAUTH_ISSUER_URL"
        echo -e "  ${DIM}Set this for external IdPs (Keycloak, Authentik). Leave empty for Stalwart's built-in OAuth.${RESET}"
    fi

    draw_footer
    read -r
}

screen_security_config() {
    CURRENT_STEP=3
    draw_header

    print_center "${BOLD}${CYAN}Step 3: Security & Sessions${RESET}"
    echo ""
    echo ""

    echo -e "  ${BOLD}Configure session security and \"Remember me\" functionality.${RESET}"
    echo -e "  ${DIM}A session secret enables encrypted persistent sessions and settings sync.${RESET}"
    echo ""

    local generate_secret="false"

    if [[ -z "$CFG_SESSION_SECRET" ]]; then
        prompt_yesno "Generate a secure session secret?" "true" "generate_secret"

        if [[ "$generate_secret" == "true" ]]; then
            if command -v openssl &>/dev/null; then
                CFG_SESSION_SECRET=$(openssl rand -base64 32)
                echo -e "  ${CHECKMARK} Generated session secret"
            else
                CFG_SESSION_SECRET=$(head -c 32 /dev/urandom | base64)
                echo -e "  ${CHECKMARK} Generated session secret (via /dev/urandom)"
            fi
        else
            prompt_value "Session secret" "" "CFG_SESSION_SECRET"
        fi
    else
        echo -e "  ${CHECKMARK} Session secret is already set"
        prompt_yesno "Regenerate session secret?" "false" "generate_secret"
        if [[ "$generate_secret" == "true" ]]; then
            if command -v openssl &>/dev/null; then
                CFG_SESSION_SECRET=$(openssl rand -base64 32)
            else
                CFG_SESSION_SECRET=$(head -c 32 /dev/urandom | base64)
            fi
            echo -e "  ${CHECKMARK} Regenerated session secret"
        fi
    fi

    echo ""

    if [[ -n "$CFG_SESSION_SECRET" ]]; then
        echo -e "  ${BULLET} \"Remember me\" checkbox will appear on login"
        echo -e "  ${BULLET} Credentials encrypted with AES-256-GCM"
        echo ""

        prompt_yesno "Enable settings sync across devices?" "$CFG_SETTINGS_SYNC_ENABLED" "CFG_SETTINGS_SYNC_ENABLED"

        if [[ "$CFG_SETTINGS_SYNC_ENABLED" == "true" ]]; then
            echo ""
            prompt_value "Settings data directory" "$CFG_SETTINGS_DATA_DIR" "CFG_SETTINGS_DATA_DIR"
        fi
    else
        echo -e "  ${DIM}Without a session secret, \"Remember me\" and settings sync are disabled.${RESET}"
    fi

    draw_footer
    read -r
}

screen_logging_config() {
    CURRENT_STEP=4
    draw_header

    print_center "${BOLD}${CYAN}Step 4: Logging${RESET}"
    echo ""
    echo ""

    echo -e "  ${BOLD}Configure application logging.${RESET}"
    echo ""

    menu_select "Log format:" "text  (colored, human-readable)" "json  (structured, for log aggregation)"
    case $MENU_RESULT in
        0) CFG_LOG_FORMAT="text" ;;
        1) CFG_LOG_FORMAT="json" ;;
    esac

    echo ""

    menu_select "Log level:" "error  (errors only)" "warn   (errors + warnings)" "info   (standard — recommended)" "debug  (verbose, for development)"
    case $MENU_RESULT in
        0) CFG_LOG_LEVEL="error" ;;
        1) CFG_LOG_LEVEL="warn" ;;
        2) CFG_LOG_LEVEL="info" ;;
        3) CFG_LOG_LEVEL="debug" ;;
    esac

    draw_footer
    read -r
}

screen_login_customization() {
    CURRENT_STEP=5
    draw_header

    print_center "${BOLD}${CYAN}Step 5: Login Page Customization${RESET}"
    echo ""
    echo ""

    echo -e "  ${BOLD}Customize the login page appearance.${RESET}"
    echo -e "  ${DIM}All fields are optional. Leave blank to skip.${RESET}"
    echo ""

    prompt_value "Company / organization name" "$CFG_LOGIN_COMPANY_NAME" "CFG_LOGIN_COMPANY_NAME"
    echo ""
    prompt_value "Website URL" "$CFG_LOGIN_WEBSITE_URL" "CFG_LOGIN_WEBSITE_URL"
    echo ""
    prompt_value "Imprint / legal notice URL" "$CFG_LOGIN_IMPRINT_URL" "CFG_LOGIN_IMPRINT_URL"
    echo ""
    prompt_value "Privacy policy URL" "$CFG_LOGIN_PRIVACY_POLICY_URL" "CFG_LOGIN_PRIVACY_POLICY_URL"

    draw_footer
    read -r
}

screen_deployment() {
    CURRENT_STEP=6
    draw_header

    print_center "${BOLD}${CYAN}Step 6: Deployment Method${RESET}"
    echo ""
    echo ""

    echo -e "  ${BOLD}How would you like to deploy JMAP Webmail?${RESET}"
    echo ""

    local docker_available=false
    command -v docker &>/dev/null && docker_available=true

    menu_select "Choose deployment method:" \
        "Node.js       (npm install → npm run build → npm start)" \
        "Docker        (pull pre-built image and run)" \
        "Docker Compose (use docker-compose.yml)"

    case $MENU_RESULT in
        0) CFG_DEPLOY_METHOD="node" ;;
        1) CFG_DEPLOY_METHOD="docker" ;;
        2) CFG_DEPLOY_METHOD="compose" ;;
    esac

    if [[ "$CFG_DEPLOY_METHOD" != "node" && "$docker_available" == false ]]; then
        echo ""
        echo -e "  ${YELLOW}⚠  Docker is not installed. You can still generate the config${RESET}"
        echo -e "  ${YELLOW}   and run Docker commands later.${RESET}"
    fi

    draw_footer
    read -r
}

screen_summary() {
    CURRENT_STEP=7
    draw_header

    print_center "${BOLD}${CYAN}Step 7: Review & Confirm${RESET}"
    echo ""
    echo ""

    echo -e "  ${BOLD}Configuration Summary${RESET}"
    echo ""
    print_hr "─"
    echo ""

    # Server
    echo -e "  ${UNDERLINE}Server${RESET}"
    echo -e "    App Name          ${BOLD}${CFG_APP_NAME}${RESET}"
    echo -e "    JMAP Server URL   ${BOLD}${CFG_JMAP_SERVER_URL}${RESET}"
    echo -e "    Stalwart Features ${BOLD}${CFG_STALWART_FEATURES}${RESET}"
    echo -e "    Port              ${BOLD}${CFG_PORT}${RESET}"
    echo ""

    # Auth
    echo -e "  ${UNDERLINE}Authentication${RESET}"
    if [[ "$CFG_OAUTH_ENABLED" == "true" ]]; then
        echo -e "    OAuth2/OIDC       ${GREEN}Enabled${RESET}"
        echo -e "    OAuth-only        ${BOLD}${CFG_OAUTH_ONLY}${RESET}"
        echo -e "    Client ID         ${BOLD}${CFG_OAUTH_CLIENT_ID}${RESET}"
        [[ -n "$CFG_OAUTH_CLIENT_SECRET" ]] && echo -e "    Client Secret     ${BOLD}••••••••${RESET}"
        [[ -n "$CFG_OAUTH_ISSUER_URL" ]] && echo -e "    Issuer URL        ${BOLD}${CFG_OAUTH_ISSUER_URL}${RESET}"
    else
        echo -e "    OAuth2/OIDC       ${DIM}Disabled (Basic Auth only)${RESET}"
    fi
    echo ""

    # Security
    echo -e "  ${UNDERLINE}Security${RESET}"
    if [[ -n "$CFG_SESSION_SECRET" ]]; then
        echo -e "    Session Secret    ${GREEN}Set${RESET} ${DIM}(Remember me enabled)${RESET}"
        echo -e "    Settings Sync     ${BOLD}${CFG_SETTINGS_SYNC_ENABLED}${RESET}"
        [[ "$CFG_SETTINGS_SYNC_ENABLED" == "true" ]] && \
        echo -e "    Settings Dir      ${BOLD}${CFG_SETTINGS_DATA_DIR}${RESET}"
    else
        echo -e "    Session Secret    ${DIM}Not set${RESET}"
    fi
    echo ""

    # Logging
    echo -e "  ${UNDERLINE}Logging${RESET}"
    echo -e "    Format            ${BOLD}${CFG_LOG_FORMAT}${RESET}"
    echo -e "    Level             ${BOLD}${CFG_LOG_LEVEL}${RESET}"
    echo ""

    # Login page
    echo -e "  ${UNDERLINE}Login Page${RESET}"
    [[ -n "$CFG_LOGIN_COMPANY_NAME" ]] && echo -e "    Company Name      ${BOLD}${CFG_LOGIN_COMPANY_NAME}${RESET}"
    [[ -n "$CFG_LOGIN_WEBSITE_URL" ]] && echo -e "    Website URL       ${BOLD}${CFG_LOGIN_WEBSITE_URL}${RESET}"
    [[ -n "$CFG_LOGIN_IMPRINT_URL" ]] && echo -e "    Imprint URL       ${BOLD}${CFG_LOGIN_IMPRINT_URL}${RESET}"
    [[ -n "$CFG_LOGIN_PRIVACY_POLICY_URL" ]] && echo -e "    Privacy Policy    ${BOLD}${CFG_LOGIN_PRIVACY_POLICY_URL}${RESET}"
    if [[ -z "$CFG_LOGIN_COMPANY_NAME" && -z "$CFG_LOGIN_WEBSITE_URL" && -z "$CFG_LOGIN_IMPRINT_URL" && -z "$CFG_LOGIN_PRIVACY_POLICY_URL" ]]; then
        echo -e "    ${DIM}(defaults)${RESET}"
    fi
    echo ""

    # Deployment
    echo -e "  ${UNDERLINE}Deployment${RESET}"
    case "$CFG_DEPLOY_METHOD" in
        "node")    echo -e "    Method            ${BOLD}Node.js (local build)${RESET}" ;;
        "docker")  echo -e "    Method            ${BOLD}Docker (pre-built image)${RESET}" ;;
        "compose") echo -e "    Method            ${BOLD}Docker Compose${RESET}" ;;
    esac

    echo ""
    print_hr "─"
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

# ── Write Configuration ────────────────────────────────────────────────────

write_env_file() {
    if [[ "$DRY_RUN" == true ]]; then
        echo -e "  ${DIM}[dry-run]${RESET} Would back up existing .env.local"
        echo -e "  ${DIM}[dry-run]${RESET} Would write .env.local with the above configuration"
        return
    fi

    # Backup existing if present
    if [[ -f "$ENV_FILE" ]]; then
        local backup="${ENV_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$ENV_FILE" "$backup"
        echo -e "  ${CHECKMARK} Backed up existing .env.local → ${DIM}$(basename "$backup")${RESET}"
    fi

    cat > "$ENV_FILE" << ENVEOF
# ─────────────────────────────────────────────────────────────────────────────
# JMAP Webmail — Configuration
# Generated by setup.sh on $(date '+%Y-%m-%d %H:%M:%S')
# ─────────────────────────────────────────────────────────────────────────────

# =============================================================================
# JMAP Server (required)
# =============================================================================

APP_NAME=${CFG_APP_NAME}
JMAP_SERVER_URL=${CFG_JMAP_SERVER_URL}

# =============================================================================
# Stalwart Mail Server Integration
# =============================================================================

STALWART_FEATURES=${CFG_STALWART_FEATURES}

# =============================================================================
# OAuth / OpenID Connect
# =============================================================================

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

# =============================================================================
# Session & Security
# =============================================================================

ENVEOF

    if [[ -n "$CFG_SESSION_SECRET" ]]; then
        echo "SESSION_SECRET=${CFG_SESSION_SECRET}" >> "$ENV_FILE"
    else
        echo "# SESSION_SECRET=" >> "$ENV_FILE"
    fi

    cat >> "$ENV_FILE" << ENVEOF

# =============================================================================
# Settings Sync
# =============================================================================

SETTINGS_SYNC_ENABLED=${CFG_SETTINGS_SYNC_ENABLED}
ENVEOF

    if [[ "$CFG_SETTINGS_SYNC_ENABLED" == "true" ]]; then
        echo "SETTINGS_DATA_DIR=${CFG_SETTINGS_DATA_DIR}" >> "$ENV_FILE"
    fi

    cat >> "$ENV_FILE" << ENVEOF

# =============================================================================
# Logging
# =============================================================================

LOG_FORMAT=${CFG_LOG_FORMAT}
LOG_LEVEL=${CFG_LOG_LEVEL}

# =============================================================================
# Login Page Customization
# =============================================================================

ENVEOF

    [[ -n "$CFG_LOGIN_COMPANY_NAME" ]] && echo "LOGIN_COMPANY_NAME=${CFG_LOGIN_COMPANY_NAME}" >> "$ENV_FILE"
    [[ -n "$CFG_LOGIN_IMPRINT_URL" ]] && echo "LOGIN_IMPRINT_URL=${CFG_LOGIN_IMPRINT_URL}" >> "$ENV_FILE"
    [[ -n "$CFG_LOGIN_PRIVACY_POLICY_URL" ]] && echo "LOGIN_PRIVACY_POLICY_URL=${CFG_LOGIN_PRIVACY_POLICY_URL}" >> "$ENV_FILE"
    [[ -n "$CFG_LOGIN_WEBSITE_URL" ]] && echo "LOGIN_WEBSITE_URL=${CFG_LOGIN_WEBSITE_URL}" >> "$ENV_FILE"

    echo -e "  ${CHECKMARK} Written ${BOLD}.env.local${RESET}"
}

update_docker_compose_port() {
    if [[ "$CFG_PORT" != "3000" && -f "${SCRIPT_DIR}/docker-compose.yml" ]]; then
        if [[ "$DRY_RUN" == true ]]; then
            echo -e "  ${DIM}[dry-run]${RESET} Would update docker-compose.yml port → ${CFG_PORT}:3000"
            return
        fi
        sed -i.bak "s/\"3000:3000\"/\"${CFG_PORT}:3000\"/" "${SCRIPT_DIR}/docker-compose.yml" 2>/dev/null || true
        echo -e "  ${CHECKMARK} Updated docker-compose.yml port mapping"
    fi
}

run_deployment() {
    echo ""

    if [[ "$DRY_RUN" == true ]]; then
        case "$CFG_DEPLOY_METHOD" in
            "node")
                echo -e "  ${DIM}[dry-run]${RESET} Would run: npm install"
                echo -e "  ${DIM}[dry-run]${RESET} Would run: npm run build"
                echo -e "  ${DIM}[dry-run]${RESET} Would start with: npm start (port ${CFG_PORT})"
                ;;
            "docker")
                echo -e "  ${DIM}[dry-run]${RESET} Would run: docker pull ghcr.io/root-fr/jmap-webmail:latest"
                echo -e "  ${DIM}[dry-run]${RESET} Would start container on port ${CFG_PORT}"
                ;;
            "compose")
                echo -e "  ${DIM}[dry-run]${RESET} Would update docker-compose.yml port mapping"
                echo -e "  ${DIM}[dry-run]${RESET} Would run: docker compose up -d"
                ;;
        esac
        return
    fi

    case "$CFG_DEPLOY_METHOD" in
        "node")
            echo -e "  ${ARROW} Installing dependencies..."
            (cd "$SCRIPT_DIR" && npm install --loglevel=warn) &
            spinner $! "Installing npm packages"

            echo -e "  ${ARROW} Building application..."
            (cd "$SCRIPT_DIR" && npm run build 2>&1 | tail -5) &
            spinner $! "Building Next.js application"

            echo ""
            echo -e "  ${CHECKMARK} Build complete!"
            echo ""
            echo -e "  ${BOLD}Start the application:${RESET}"
            echo ""
            echo -e "    ${CYAN}cd ${SCRIPT_DIR}${RESET}"
            if [[ "$CFG_PORT" != "3000" ]]; then
                echo -e "    ${CYAN}PORT=${CFG_PORT} npm start${RESET}"
            else
                echo -e "    ${CYAN}npm start${RESET}"
            fi
            ;;

        "docker")
            echo -e "  ${ARROW} Pulling Docker image..."
            (docker pull ghcr.io/root-fr/jmap-webmail:latest 2>&1) &
            spinner $! "Pulling ghcr.io/root-fr/jmap-webmail:latest"

            echo ""
            echo -e "  ${CHECKMARK} Image pulled!"
            echo ""
            echo -e "  ${BOLD}Run the container:${RESET}"
            echo ""
            echo -e "    ${CYAN}docker run -d \\"
            echo -e "      --name jmap-webmail \\"
            echo -e "      -p ${CFG_PORT}:3000 \\"
            echo -e "      --env-file .env.local \\"
            echo -e "      --restart unless-stopped \\"
            echo -e "      ghcr.io/root-fr/jmap-webmail:latest${RESET}"
            ;;

        "compose")
            update_docker_compose_port

            echo -e "  ${ARROW} Starting with Docker Compose..."
            (cd "$SCRIPT_DIR" && docker compose up -d 2>&1) &
            spinner $! "Starting Docker Compose services"

            echo ""
            echo -e "  ${CHECKMARK} Services started!"
            echo ""
            echo -e "  ${BOLD}Manage with:${RESET}"
            echo ""
            echo -e "    ${CYAN}docker compose logs -f${RESET}     ${DIM}# View logs${RESET}"
            echo -e "    ${CYAN}docker compose restart${RESET}     ${DIM}# Restart${RESET}"
            echo -e "    ${CYAN}docker compose down${RESET}        ${DIM}# Stop${RESET}"
            ;;
    esac
}

# ── Completion Screen ───────────────────────────────────────────────────────

screen_complete() {
    draw_header

    echo ""
    if [[ "$DRY_RUN" == true ]]; then
        print_center "${BG_MAGENTA}${WHITE}${BOLD}                                            ${RESET}"
        print_center "${BG_MAGENTA}${WHITE}${BOLD}       DRY RUN COMPLETE!          ${RESET}"
        print_center "${BG_MAGENTA}${WHITE}${BOLD}                                            ${RESET}"
    else
        print_center "${BG_GREEN}${WHITE}${BOLD}                                            ${RESET}"
        print_center "${BG_GREEN}${WHITE}${BOLD}         SETUP COMPLETE!          ${RESET}"
        print_center "${BG_GREEN}${WHITE}${BOLD}                                            ${RESET}"
    fi
    echo ""
    echo ""

    write_env_file
    echo ""

    run_deployment

    echo ""
    echo ""
    print_hr "─"
    echo ""

    local url="http://localhost:${CFG_PORT}"
    print_center "${BOLD}Access your webmail at:${RESET}"
    echo ""
    print_center "${UNDERLINE}${CYAN}${url}${RESET}"
    echo ""
    echo ""

    print_center "${DIM}Configuration: .env.local${RESET}"
    print_center "${DIM}Documentation: README.md${RESET}"
    echo ""
    print_hr "─"
    echo ""
    print_center "${DIM}Thank you for using JMAP Webmail!${RESET}"
    echo ""
}

# ── Signal Handling ─────────────────────────────────────────────────────────

cleanup() {
    show_cursor
    clear_screen
    echo -e "\n  ${YELLOW}Setup interrupted. No changes were made.${RESET}\n"
    exit 1
}

trap cleanup INT TERM

# ── Main ────────────────────────────────────────────────────────────────────

main() {
    # Check for minimum terminal size
    get_term_size
    if [[ $TERM_COLS -lt 60 || $TERM_ROWS -lt 20 ]]; then
        echo "Terminal too small. Minimum: 60x20 (current: ${TERM_COLS}x${TERM_ROWS})"
        exit 1
    fi

    # Load existing .env.local values if present
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
        val="${val#\"}" ; val="${val%\"}"    # strip quotes
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
    get_env_val "LOG_FORMAT";               [[ -n "$val" ]] && CFG_LOG_FORMAT="$val"
    get_env_val "LOG_LEVEL";                [[ -n "$val" ]] && CFG_LOG_LEVEL="$val"
    get_env_val "LOGIN_COMPANY_NAME";       [[ -n "$val" ]] && CFG_LOGIN_COMPANY_NAME="$val"
    get_env_val "LOGIN_IMPRINT_URL";        [[ -n "$val" ]] && CFG_LOGIN_IMPRINT_URL="$val"
    get_env_val "LOGIN_PRIVACY_POLICY_URL"; [[ -n "$val" ]] && CFG_LOGIN_PRIVACY_POLICY_URL="$val"
    get_env_val "LOGIN_WEBSITE_URL";        [[ -n "$val" ]] && CFG_LOGIN_WEBSITE_URL="$val"
}

main "$@"
