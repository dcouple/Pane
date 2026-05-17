#!/bin/bash
# Pane Cloud Setup — Interactive CLI
# Guides you through provisioning a secure GCP VM with IAP-only access.
#
# Prerequisites: gcloud CLI, terraform CLI, bash
# Usage: bash cloud/scripts/setup-cloud.sh
#        bash cloud/scripts/setup-cloud.sh --destroy  # Destroy infrastructure

# Bail immediately if not running under bash
if [ -z "$BASH_VERSION" ]; then
  echo ""
  echo "ERROR: This script requires bash."
  echo ""
  echo "  On macOS/Linux:  bash cloud/scripts/setup-cloud.sh"
  echo "  On Windows:      Open Git Bash, then run the command above"
  echo ""
  echo "If you're using Pane's built-in terminal, set your shell to"
  echo "Git Bash in Settings > Preferred Shell."
  echo ""
  exit 1
fi

set -eo pipefail

# ============================================================
# Colors & helpers
# ============================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
header()  { echo -e "\n${BOLD}${CYAN}=== $* ===${NC}\n"; }

prompt_input() {
  local varname="$1" prompt="$2" default="$3"
  local value
  if [ -n "$default" ]; then
    read -rp "$(echo -e "${BOLD}$prompt${NC} [${default}]: ")" value
    printf -v "$varname" '%s' "${value:-$default}"
  else
    read -rp "$(echo -e "${BOLD}$prompt${NC}: ")" value
    printf -v "$varname" '%s' "$value"
  fi
}

prompt_yes_no() {
  local prompt="$1" default="${2:-y}"
  local yn
  if [ "$default" = "y" ]; then
    read -rp "$(echo -e "${BOLD}$prompt${NC} [Y/n]: ")" yn
    yn="${yn:-y}"
  else
    read -rp "$(echo -e "${BOLD}$prompt${NC} [y/N]: ")" yn
    yn="${yn:-n}"
  fi
  [[ "$yn" =~ ^[Yy] ]]
}

normalize_bool() {
  local value
  value="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|on)
      echo "true"
      ;;
    *)
      echo "false"
      ;;
  esac
}

# ============================================================
# Resolve script directory (works from any cwd)
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="${SCRIPT_DIR}/../terraform/gcp"

# ============================================================
# Parse command line arguments
# ============================================================
DESTROY_MODE=false
for arg in "$@"; do
  case $arg in
    --destroy)
      DESTROY_MODE=true
      shift
      ;;
  esac
done

# ============================================================
# Detect WSL and get correct Pane config path
# ============================================================
get_pane_config_path() {
  # Check if running in WSL
  if grep -qi microsoft /proc/version 2>/dev/null; then
    # Running in WSL - get Windows username and use Windows home dir
    local win_user
    win_user=$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d '\r\n')
    if [ -n "$win_user" ]; then
      local win_home="/mnt/c/Users/${win_user}"
      if [ -d "$win_home" ]; then
        echo "${win_home}/.pane/config.json"
        return
      fi
    fi
  fi
  # Default: use $HOME (native Linux/macOS or Git Bash on Windows)
  echo "$HOME/.pane/config.json"
}

get_pane_config_dir() {
  local config_path
  config_path=$(get_pane_config_path)
  dirname "$config_path"
}

# Set config path early so it's available throughout the script
PANE_CONFIG=$(get_pane_config_path)
PANE_CONFIG_DIR=$(get_pane_config_dir)
HOSTED_TUNNEL_PORT=8080
HOSTED_DAEMON_BASE_URL="http://127.0.0.1:${HOSTED_TUNNEL_PORT}/daemon/"
HOSTED_DAEMON_PORT=42137
HOSTED_REMOTE_PROFILE_ID=""
HOSTED_REMOTE_PROFILE_LABEL="Pane Cloud Workspace"
HOSTED_REMOTE_PROFILE_TOKEN=""
HOSTED_DAEMON_STATUS="unknown"
HOSTED_ALLOW_NOVNC_FALLBACK="false"
CURRENT_GCP_TOKEN=""

read_existing_remote_profile_token() {
  local profile_id="$1"

  if [ ! -f "$PANE_CONFIG" ] || ! command -v jq &>/dev/null || [ -z "$profile_id" ]; then
    return
  fi

  jq -r --arg profileId "$profile_id" '
    .remoteDaemon.client.profiles[]? | select(.id == $profileId) | .token
  ' "$PANE_CONFIG" 2>/dev/null | head -1
}

# ============================================================
# Incremental config save function
# ============================================================
# Saves current cloud config to Pane config file as we go
# This ensures partial progress is preserved if setup fails
save_cloud_config() {
  local project_id="${1:-}"
  local zone="${2:-}"
  local server_id="${3:-}"
  local vnc_password="${4:-}"
  local tunnel_port="${5:-8080}"

  # Skip if jq not available
  if ! command -v jq &>/dev/null; then
    return
  fi

  # Ensure config directory exists
  mkdir -p "$PANE_CONFIG_DIR"

  # Create config file if it doesn't exist
  if [ ! -f "$PANE_CONFIG" ]; then
    echo '{}' > "$PANE_CONFIG"
  fi

  # Extract region from zone
  local region=""
  if [ -n "$zone" ]; then
    region=$(echo "$zone" | sed 's/-[a-z]$//')
  fi

  local allow_novnc_json="false"
  if [ "$HOSTED_ALLOW_NOVNC_FALLBACK" = "true" ]; then
    allow_novnc_json="true"
  fi

  local remote_profile_json='null'
  if [ -n "$HOSTED_REMOTE_PROFILE_ID" ] && [ -n "$HOSTED_REMOTE_PROFILE_TOKEN" ] && [ -n "$HOSTED_DAEMON_BASE_URL" ]; then
    remote_profile_json="$(jq -cn \
      --arg id "$HOSTED_REMOTE_PROFILE_ID" \
      --arg label "$HOSTED_REMOTE_PROFILE_LABEL" \
      --arg baseUrl "$HOSTED_DAEMON_BASE_URL" \
      --arg token "$HOSTED_REMOTE_PROFILE_TOKEN" \
      '{
        id: $id,
        label: $label,
        baseUrl: $baseUrl,
        token: $token,
        transport: "http+sse"
      }'
    )"
  fi

  # Update config with current values (only non-empty ones)
  # Use canonical key names (projectId, zone) to match what the app reads
  local tmp_config="${PANE_CONFIG}.tmp"
  jq --arg provider "gcp" \
     --arg projectId "$project_id" \
     --arg zone "$zone" \
     --arg region "$region" \
     --arg serverId "$server_id" \
     --arg vncPassword "$vnc_password" \
     --arg daemonBaseUrl "$HOSTED_DAEMON_BASE_URL" \
     --arg linkedRemoteProfileId "$HOSTED_REMOTE_PROFILE_ID" \
     --arg daemonStatus "$HOSTED_DAEMON_STATUS" \
     --arg apiToken "$CURRENT_GCP_TOKEN" \
     --argjson tunnelPort "${tunnel_port:-8080}" \
     --argjson allowNoVncFallback "$allow_novnc_json" \
     --argjson remoteProfile "$remote_profile_json" \
     '
      .cloud = (.cloud // {}) | .cloud.provider = $provider
      | if $projectId != "" then .cloud.projectId = $projectId else . end
      | if $zone != "" then .cloud.zone = $zone else . end
      | if $region != "" then .cloud.region = $region else . end
      | if $serverId != "" then .cloud.serverId = $serverId else . end
      | if $vncPassword != "" then .cloud.vncPassword = $vncPassword else . end
      | if $apiToken != "" then .cloud.apiToken = $apiToken else . end
      | if $daemonBaseUrl != "" then .cloud.daemonBaseUrl = $daemonBaseUrl else . end
      | if $linkedRemoteProfileId != "" then .cloud.linkedRemoteProfileId = $linkedRemoteProfileId else . end
      | if $daemonStatus != "" then .cloud.daemonStatus = $daemonStatus else . end
      | .cloud.preferredAccess = "daemon"
      | .cloud.allowNoVncFallback = $allowNoVncFallback
      | .cloud.tunnelPort = $tunnelPort
      | .cloud.serverIp = ""
      | .remoteDaemon = (.remoteDaemon // {})
      | .remoteDaemon.client = (.remoteDaemon.client // {
          profiles: [],
          activeProfileId: null,
          mode: "local"
        })
      | if $remoteProfile != null
          then .remoteDaemon.client.profiles = (
            [((.remoteDaemon.client.profiles // [])[] | select(.id != $remoteProfile.id))]
            + [$remoteProfile]
          )
          else .
        end
      | .remoteDaemon.client.activeProfileId = (.remoteDaemon.client.activeProfileId // null)
      | .remoteDaemon.client.mode = (.remoteDaemon.client.mode // "local")
      ' \
     "$PANE_CONFIG" > "$tmp_config" && mv "$tmp_config" "$PANE_CONFIG"
}

# ============================================================
# Platform detection
# ============================================================
detect_platform() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "macos"
  elif grep -qi microsoft /proc/version 2>/dev/null; then
    echo "wsl"
  elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "mingw"* ]] || [[ "$OSTYPE" == "cygwin"* ]]; then
    echo "windows"  # Git Bash / MSYS2 / Cygwin
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo "linux"
  else
    echo "unknown"
  fi
}

PLATFORM=$(detect_platform)

# ============================================================
# Auto-install functions
# ============================================================
install_terraform() {
  info "Installing Terraform..."

  case "$PLATFORM" in
    macos)
      if command -v brew &>/dev/null; then
        brew tap hashicorp/tap && brew install hashicorp/tap/terraform
      else
        error "Homebrew not found. Install Homebrew first: https://brew.sh"
        return 1
      fi
      ;;
    linux|wsl)
      # Use HashiCorp's official APT repo for Debian/Ubuntu
      if command -v apt-get &>/dev/null; then
        sudo apt-get update && sudo apt-get install -y gnupg software-properties-common
        wget -O- https://apt.releases.hashicorp.com/gpg | \
          gpg --dearmor | \
          sudo tee /usr/share/keyrings/hashicorp-archive-keyring.gpg > /dev/null
        echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] \
          https://apt.releases.hashicorp.com $(lsb_release -cs) main" | \
          sudo tee /etc/apt/sources.list.d/hashicorp.list
        sudo apt-get update && sudo apt-get install -y terraform
      else
        error "apt-get not found. Please install Terraform manually."
        return 1
      fi
      ;;
    windows)
      # Git Bash on Windows - use winget or choco
      if command -v winget.exe &>/dev/null; then
        winget.exe install --id Hashicorp.Terraform -e --source winget
      elif command -v choco &>/dev/null; then
        choco install terraform -y
      else
        error "Neither winget nor chocolatey found. Please install Terraform manually."
        error "Download from: https://developer.hashicorp.com/terraform/install"
        return 1
      fi
      ;;
    *)
      error "Unknown platform. Please install Terraform manually."
      return 1
      ;;
  esac

  # Verify installation
  if command -v terraform &>/dev/null; then
    success "Terraform installed successfully!"
    return 0
  else
    error "Terraform installation failed."
    return 1
  fi
}

install_gcloud() {
  info "Installing Google Cloud SDK..."

  case "$PLATFORM" in
    macos)
      if command -v brew &>/dev/null; then
        brew install --cask google-cloud-sdk
      else
        error "Homebrew not found. Install Homebrew first: https://brew.sh"
        return 1
      fi
      ;;
    linux|wsl)
      # Use Google's official install script
      if command -v apt-get &>/dev/null; then
        sudo apt-get update && sudo apt-get install -y apt-transport-https ca-certificates gnupg curl
        curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
        echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | \
          sudo tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
        sudo apt-get update && sudo apt-get install -y google-cloud-cli
      else
        # Fallback to interactive install script
        curl https://sdk.cloud.google.com | bash
        exec -l $SHELL  # Restart shell to pick up PATH changes
      fi
      ;;
    windows)
      # Git Bash on Windows - use winget or direct installer
      if command -v winget.exe &>/dev/null; then
        winget.exe install --id Google.CloudSDK -e --source winget
      else
        error "winget not found. Please install Google Cloud SDK manually."
        error "Download from: https://cloud.google.com/sdk/docs/install"
        return 1
      fi
      ;;
    *)
      error "Unknown platform. Please install Google Cloud SDK manually."
      return 1
      ;;
  esac

  # Verify installation
  if command -v gcloud &>/dev/null; then
    success "Google Cloud SDK installed successfully!"
    return 0
  else
    warn "gcloud may require a new terminal session to be available in PATH."
    return 1
  fi
}

install_jq() {
  info "Installing jq..."

  case "$PLATFORM" in
    macos)
      brew install jq
      ;;
    linux|wsl)
      if command -v apt-get &>/dev/null; then
        sudo apt-get update && sudo apt-get install -y jq
      elif command -v yum &>/dev/null; then
        sudo yum install -y jq
      else
        error "Package manager not found. Please install jq manually."
        return 1
      fi
      ;;
    windows)
      if command -v winget.exe &>/dev/null; then
        winget.exe install --id jqlang.jq -e --source winget
      elif command -v choco &>/dev/null; then
        choco install jq -y
      else
        error "Neither winget nor chocolatey found. Please install jq manually."
        return 1
      fi
      ;;
    *)
      error "Unknown platform. Please install jq manually."
      return 1
      ;;
  esac

  success "jq installed successfully!"
  return 0
}

# ============================================================
# Destroy mode handler
# ============================================================
if [ "$DESTROY_MODE" = true ]; then
  header "Pane Cloud Destroy"
  echo -e "This will destroy your Pane Cloud VM and clean up GCP resources.\n"

  warn "This action is irreversible!"
  echo ""

  # Check if terraform state exists
  if [ ! -f "$TERRAFORM_DIR/terraform.tfstate" ]; then
    info "No terraform state found. Nothing to destroy."
    info "Clearing local config..."

    # Clear cloud config from Pane config
    if [ -f "$PANE_CONFIG" ] && command -v jq &>/dev/null; then
      jq 'del(.cloud)' "$PANE_CONFIG" > "${PANE_CONFIG}.tmp" && mv "${PANE_CONFIG}.tmp" "$PANE_CONFIG"
      success "Local cloud config cleared."
    fi
    exit 0
  fi

  # Get project ID from state for cleanup
  PROJECT_ID=$(terraform -chdir="$TERRAFORM_DIR" output -raw project_id 2>/dev/null || echo "")
  INSTANCE_NAME=$(terraform -chdir="$TERRAFORM_DIR" output -raw instance_name 2>/dev/null || echo "")
  STATE_USER_ID="${INSTANCE_NAME#pane-}"
  if [ -z "$STATE_USER_ID" ] || [ "$STATE_USER_ID" = "$INSTANCE_NAME" ]; then
    STATE_USER_ID="${PROJECT_ID#pane-cloud-}"
  fi
  VNC_PASSWORD=$(terraform -chdir="$TERRAFORM_DIR" output -raw vnc_password 2>/dev/null || echo "destroy-placeholder")
  HOSTED_REMOTE_PROFILE_ID=$(terraform -chdir="$TERRAFORM_DIR" output -raw remote_client_id 2>/dev/null || echo "cloud-${STATE_USER_ID}")
  HOSTED_REMOTE_PROFILE_LABEL=$(terraform -chdir="$TERRAFORM_DIR" output -raw remote_client_label 2>/dev/null || echo "Pane Cloud Workspace")
  HOSTED_REMOTE_PROFILE_TOKEN=$(terraform -chdir="$TERRAFORM_DIR" output -raw remote_client_token 2>/dev/null || echo "destroy-placeholder")
  HOSTED_DAEMON_PORT=$(terraform -chdir="$TERRAFORM_DIR" output -raw remote_daemon_port 2>/dev/null || echo "42137")
  HOSTED_ALLOW_NOVNC_FALLBACK=$(normalize_bool "$(terraform -chdir="$TERRAFORM_DIR" output -raw novnc_fallback_enabled 2>/dev/null || echo "false")")

  if ! prompt_yes_no "Are you sure you want to destroy the cloud infrastructure?" "n"; then
    info "Aborted."
    exit 0
  fi

  info "Running terraform destroy..."
  cd "$TERRAFORM_DIR"
  terraform init -input=false >/dev/null 2>&1
  terraform destroy \
    -var="project_id=${PROJECT_ID}" \
    -var="user_id=${STATE_USER_ID}" \
    -var="vnc_password=${VNC_PASSWORD}" \
    -var="remote_client_id=${HOSTED_REMOTE_PROFILE_ID}" \
    -var="remote_client_label=${HOSTED_REMOTE_PROFILE_LABEL}" \
    -var="remote_client_token=${HOSTED_REMOTE_PROFILE_TOKEN}" \
    -var="remote_daemon_port=${HOSTED_DAEMON_PORT}" \
    -var="enable_novnc_fallback=${HOSTED_ALLOW_NOVNC_FALLBACK}" \
    -auto-approve

  success "Infrastructure destroyed."

  # Optionally delete the GCP project
  if [ -n "$PROJECT_ID" ]; then
    echo ""
    if prompt_yes_no "Also delete the GCP project '$PROJECT_ID'?" "n"; then
      info "Deleting GCP project..."
      gcloud projects delete "$PROJECT_ID" --quiet 2>&1 || warn "Failed to delete project (may already be deleted)"
      success "Project deletion initiated."
    fi
  fi

  # Clear local config
  info "Clearing local cloud config..."
  if [ -f "$PANE_CONFIG" ] && command -v jq &>/dev/null; then
    jq 'del(.cloud)' "$PANE_CONFIG" > "${PANE_CONFIG}.tmp" && mv "${PANE_CONFIG}.tmp" "$PANE_CONFIG"
    success "Local cloud config cleared."
  fi

  # Remove terraform state
  rm -f "$TERRAFORM_DIR/terraform.tfstate" "$TERRAFORM_DIR/terraform.tfstate.backup"
  success "Terraform state cleaned up."

  echo ""
  success "Cloud cleanup complete!"
  exit 0
fi

# ============================================================
# Step 0: Check prerequisites
# ============================================================
header "Pane Cloud Setup"
echo -e "This script will guide you through setting up a secure Pane Cloud VM"
echo -e "on Google Cloud Platform with IAP-only access (no public IP).\n"

info "Detected platform: ${BOLD}${PLATFORM}${NC}"
info "Config will be saved to: ${PANE_CONFIG}"
echo ""

info "Checking prerequisites..."

# Check and auto-install gcloud
if ! command -v gcloud &>/dev/null; then
  install_gcloud || exit 1
else
  success "gcloud found: $(command -v gcloud)"
fi

# Check and auto-install terraform
if ! command -v terraform &>/dev/null; then
  install_terraform || exit 1
else
  success "terraform found: $(command -v terraform)"
fi

# Check and auto-install jq (needed for config updates)
if ! command -v jq &>/dev/null; then
  install_jq || warn "jq installation failed. Config updates may not work."
else
  success "jq found: $(command -v jq)"
fi

# Install NumPy for gcloud IAP tunnel performance optimization
# See: https://cloud.google.com/iap/docs/using-tcp-forwarding#increasing_the_tcp_upload_bandwidth
GCLOUD_PYTHON=$(gcloud info --format="value(basic.python_location)" 2>/dev/null || echo "")
if [ -n "$GCLOUD_PYTHON" ]; then
  if "$GCLOUD_PYTHON" -c "import numpy" &>/dev/null; then
    success "numpy installed (IAP tunnel optimization)"
  else
    info "Installing numpy for IAP tunnel performance..."
    "$GCLOUD_PYTHON" -m pip install numpy --quiet 2>/dev/null && \
      success "numpy installed (IAP tunnel optimization)" || \
      warn "numpy install failed (optional, tunnel will still work)"
  fi
fi

echo ""

# ============================================================
# Check if already provisioned — enter connect mode
# ============================================================
if [ -f "${TERRAFORM_DIR}/terraform.tfstate" ]; then
  # Try to read terraform outputs (may fail if state is corrupted)
  INSTANCE_NAME=$(terraform -chdir="$TERRAFORM_DIR" output -raw instance_name 2>/dev/null || echo "")

  if [ -n "$INSTANCE_NAME" ]; then
    header "Pane Cloud — Connect Mode"
    info "Existing deployment detected. Entering connect mode."
    echo ""

    # Read remaining terraform outputs
    PROJECT_ID=$(terraform -chdir="$TERRAFORM_DIR" output -raw project_id 2>/dev/null || echo "")
    GCP_ZONE=$(terraform -chdir="$TERRAFORM_DIR" output -raw zone 2>/dev/null || echo "")
    HOSTED_DAEMON_PORT=$(terraform -chdir="$TERRAFORM_DIR" output -raw remote_daemon_port 2>/dev/null || echo "42137")
    HOSTED_REMOTE_PROFILE_ID=$(terraform -chdir="$TERRAFORM_DIR" output -raw remote_client_id 2>/dev/null || echo "")
    HOSTED_REMOTE_PROFILE_LABEL=$(terraform -chdir="$TERRAFORM_DIR" output -raw remote_client_label 2>/dev/null || echo "Pane Cloud Workspace")
    HOSTED_REMOTE_PROFILE_TOKEN=$(terraform -chdir="$TERRAFORM_DIR" output -raw remote_client_token 2>/dev/null || echo "")
    HOSTED_ALLOW_NOVNC_FALLBACK=$(normalize_bool "$(terraform -chdir="$TERRAFORM_DIR" output -raw novnc_fallback_enabled 2>/dev/null || echo "false")")
    TUNNEL_PORT=$HOSTED_TUNNEL_PORT
    HOSTED_DAEMON_BASE_URL="$(terraform -chdir="$TERRAFORM_DIR" output -raw daemon_base_url 2>/dev/null || echo "http://127.0.0.1:${TUNNEL_PORT}/daemon/")"

    if [ -z "$HOSTED_REMOTE_PROFILE_ID" ]; then
      HOSTED_REMOTE_PROFILE_ID="cloud-${INSTANCE_NAME#pane-}"
    fi

    if [ -z "$HOSTED_REMOTE_PROFILE_TOKEN" ]; then
      HOSTED_REMOTE_PROFILE_TOKEN="$(read_existing_remote_profile_token "$HOSTED_REMOTE_PROFILE_ID")"
    fi

    # If project_id output doesn't exist (older state), extract from tunnel command
    if [ -z "$PROJECT_ID" ]; then
      TUNNEL_CMD=$(terraform -chdir="$TERRAFORM_DIR" output -raw novnc_tunnel_command 2>/dev/null || echo "")
      # Extract project ID using sed (works on all platforms)
      PROJECT_ID=$(echo "$TUNNEL_CMD" | sed -n 's/.*--project=\([^ ]*\).*/\1/p')
    fi

    # Validate we have required values
    if [ -z "$PROJECT_ID" ] || [ -z "$GCP_ZONE" ]; then
      error "Could not read terraform outputs. State may be corrupted."
      error "Try running: cd ${TERRAFORM_DIR} && terraform refresh"
      exit 1
    fi

    success "Instance: ${INSTANCE_NAME}"
    success "Project:  ${PROJECT_ID}"
    success "Zone:     ${GCP_ZONE}"
    echo ""

    # Step 1: Refresh GCP token (handles auth if needed)
    info "Checking GCP authentication..."
    GCP_TOKEN=$(gcloud auth print-access-token 2>/dev/null || echo "")
    if [ -z "$GCP_TOKEN" ]; then
      warn "Not authenticated with GCP. Launching login..."
      echo ""
      gcloud auth login --update-adc
      GCP_TOKEN=$(gcloud auth print-access-token 2>/dev/null || echo "")
      if [ -z "$GCP_TOKEN" ]; then
        error "Failed to get GCP access token after login."
        exit 1
      fi
    fi
    success "GCP token acquired."
    echo ""

    # Step 2: Check if VM exists and its status
    info "Checking VM status..."
    VM_STATUS=$(gcloud compute instances describe "$INSTANCE_NAME" \
      --zone="$GCP_ZONE" \
      --project="$PROJECT_ID" \
      --format="value(status)" 2>/dev/null || echo "NOT_FOUND")

    if [ "$VM_STATUS" = "NOT_FOUND" ]; then
      error "VM '${INSTANCE_NAME}' not found in project '${PROJECT_ID}'."
      error "The infrastructure may have been destroyed. Run this script again to re-provision."
      exit 1
    fi

    success "VM status: ${VM_STATUS}"

    # Step 3: Start VM if not running
    if [ "$VM_STATUS" != "RUNNING" ]; then
      echo ""
      info "Starting VM..."
      gcloud compute instances start "$INSTANCE_NAME" \
        --zone="$GCP_ZONE" \
        --project="$PROJECT_ID" \
        --quiet

      # Wait for running state
      info "Waiting for VM to start..."
      for i in $(seq 1 30); do
        sleep 2
        VM_STATUS=$(gcloud compute instances describe "$INSTANCE_NAME" \
          --zone="$GCP_ZONE" \
          --project="$PROJECT_ID" \
          --format="value(status)" 2>/dev/null || echo "UNKNOWN")
        echo -ne "\r  Status: ${VM_STATUS} (${i}/30)"
        if [ "$VM_STATUS" = "RUNNING" ]; then
          break
        fi
      done
      echo ""

      if [ "$VM_STATUS" != "RUNNING" ]; then
        error "VM did not reach RUNNING state. Current status: ${VM_STATUS}"
        exit 1
      fi
      success "VM is now running."
    fi
    echo ""

    # Step 4: Check hosted daemon readiness from inside the VM before opening the tunnel
    info "Checking hosted daemon health..."
    HOSTED_DAEMON_STATUS=$(gcloud compute ssh "$INSTANCE_NAME" \
      --zone="$GCP_ZONE" \
      --project="$PROJECT_ID" \
      --tunnel-through-iap \
      --command="curl -fsS http://127.0.0.1/health >/dev/null 2>&1 && echo 'ready' || echo 'bootstrapping'" \
      2>/dev/null || echo "unknown")
    success "Hosted daemon status: ${HOSTED_DAEMON_STATUS}"
    echo ""

    # Step 5: Get VNC password (from terraform state first, then VM as fallback)
    info "Retrieving VNC password..."

    # Try terraform state first (we now store it there)
    VNC_PASSWORD=$(terraform -chdir="$TERRAFORM_DIR" output -raw vnc_password 2>/dev/null || echo "")

    if [ -z "$VNC_PASSWORD" ]; then
      # Fallback: try to get from VM (for older deployments)
      info "Not in terraform state, checking VM..."
      sleep 2

      for attempt in $(seq 1 3); do
        VNC_PASSWORD=$(gcloud compute ssh "$INSTANCE_NAME" \
          --zone="$GCP_ZONE" \
          --project="$PROJECT_ID" \
          --tunnel-through-iap \
          --command="cat /home/Pane/.vnc_password 2>/dev/null || cat /home/foozol/.vnc_password 2>/dev/null" \
          2>/dev/null || echo "")

        if [ -n "$VNC_PASSWORD" ]; then
          break
        fi

        echo -ne "\r  Attempt ${attempt}/3 - waiting for VM services..."
        sleep 3
      done
      echo ""
    fi

    if [ -n "$VNC_PASSWORD" ]; then
      success "VNC password: ${BOLD}${VNC_PASSWORD}${NC}"
    else
      warn "Could not retrieve VNC password."
      warn "You can get it later with:"
      echo "  gcloud compute ssh ${INSTANCE_NAME} --zone=${GCP_ZONE} --project=${PROJECT_ID} --tunnel-through-iap --command='cat /home/Pane/.vnc_password 2>/dev/null || cat /home/foozol/.vnc_password 2>/dev/null'"
    fi
    echo ""

    # Step 6: Update Pane config
    info "Updating Pane config..."
    mkdir -p "$PANE_CONFIG_DIR"
    CURRENT_GCP_TOKEN="$GCP_TOKEN"

    if command -v jq &>/dev/null; then
      save_cloud_config "$PROJECT_ID" "$GCP_ZONE" "$INSTANCE_NAME" "$VNC_PASSWORD" "$TUNNEL_PORT"
      success "Config updated: ${PANE_CONFIG}"
    else
      warn "jq not found — skipping config update."
    fi
    echo ""

    # Step 7: Start IAP tunnel
    header "Starting IAP Tunnel"

    echo -e "The tunnel will connect your local port ${BOLD}${TUNNEL_PORT}${NC} to the VM."
    echo -e "Once connected, open Pane and click ${BOLD}Connect Cloud Runtime${NC}."
    echo ""
    echo -e "${YELLOW}Press Ctrl+C to disconnect the tunnel.${NC}"
    echo ""

    # Update config to indicate tunnel is starting
    if [ -f "$PANE_CONFIG" ] && command -v jq &>/dev/null; then
      jq '.cloud.tunnelStatus = "starting"' "$PANE_CONFIG" > "${PANE_CONFIG}.tmp" \
        && mv "${PANE_CONFIG}.tmp" "$PANE_CONFIG"
    fi

    # Set trap to update config when tunnel exits
    cleanup_tunnel() {
      if [ -f "$PANE_CONFIG" ] && command -v jq &>/dev/null; then
        jq '.cloud.tunnelStatus = "off"' "$PANE_CONFIG" > "${PANE_CONFIG}.tmp" \
          && mv "${PANE_CONFIG}.tmp" "$PANE_CONFIG"
      fi
      exit 0
    }
    trap cleanup_tunnel EXIT INT TERM

    # Run tunnel in foreground
    gcloud compute start-iap-tunnel "$INSTANCE_NAME" 80 \
      --local-host-port="localhost:${TUNNEL_PORT}" \
      --zone="$GCP_ZONE" \
      --project="$PROJECT_ID"

    exit 0
  fi
fi

# ============================================================
# Step 1: Google Cloud authentication
# ============================================================
header "Step 1: Google Cloud Authentication"

CURRENT_ACCOUNT=$(gcloud config get-value account 2>/dev/null || true)

if [ -n "$CURRENT_ACCOUNT" ] && [ "$CURRENT_ACCOUNT" != "(unset)" ]; then
  info "Currently authenticated as: ${BOLD}${CURRENT_ACCOUNT}${NC}"
  if ! prompt_yes_no "Use this account?"; then
    info "Launching Google Cloud login..."
    gcloud auth login --update-adc
    CURRENT_ACCOUNT=$(gcloud config get-value account 2>/dev/null)
  fi
else
  info "Not authenticated. Launching Google Cloud login..."
  gcloud auth login --update-adc
  CURRENT_ACCOUNT=$(gcloud config get-value account 2>/dev/null)
fi

success "Authenticated as: ${CURRENT_ACCOUNT}"

# Also ensure application-default credentials exist (needed for Terraform)
if ! gcloud auth application-default print-access-token &>/dev/null 2>&1; then
  info "Setting up application-default credentials for Terraform..."
  gcloud auth application-default login
fi

CURRENT_GCP_TOKEN=$(gcloud auth print-access-token 2>/dev/null || echo "")

# ============================================================
# Step 2: Choose or create a GCP project
# ============================================================
header "Step 2: GCP Project"

echo -e "Pane Cloud will create an isolated GCP project for your VM.\n"

prompt_input USER_ID "Enter a unique user ID (used in resource names, e.g. your-name)" ""

while [ -z "$USER_ID" ]; do
  warn "User ID cannot be empty."
  prompt_input USER_ID "Enter a unique user ID" ""
done

# Sanitize: lowercase, alphanumeric + hyphens only, strip carriage returns (WSL fix)
USER_ID=$(echo "$USER_ID" | tr -d '\r' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')
PROJECT_ID="pane-cloud-${USER_ID}"
HOSTED_REMOTE_PROFILE_ID="cloud-${USER_ID}"
HOSTED_REMOTE_PROFILE_TOKEN="$(read_existing_remote_profile_token "$HOSTED_REMOTE_PROFILE_ID")"
if [ -z "$HOSTED_REMOTE_PROFILE_TOKEN" ]; then
  HOSTED_REMOTE_PROFILE_TOKEN="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
fi

info "Project ID will be: ${BOLD}${PROJECT_ID}${NC}"

# Check if project already exists
if gcloud projects describe "$PROJECT_ID" &>/dev/null 2>&1; then
  success "Project ${PROJECT_ID} already exists."
  EXISTING_PROJECT=true
else
  EXISTING_PROJECT=false
  info "Creating project ${PROJECT_ID}..."
  if ! gcloud projects create "$PROJECT_ID" --name="Cloud VM ${USER_ID}" 2>&1; then
    error "Failed to create project. You may need to check your organization policies."
    exit 1
  fi
  success "Project created: ${PROJECT_ID}"
fi

# Set as active project
gcloud config set project "$PROJECT_ID" 2>/dev/null

# Save progress: project ID is now known
save_cloud_config "$PROJECT_ID" "" "" ""
info "Progress saved to config."

# ============================================================
# Step 3: Billing — requires manual step
# ============================================================
header "Step 3: Link Billing Account"

# Check if billing is already linked
BILLING_ENABLED=$(gcloud billing projects describe "$PROJECT_ID" --format="value(billingEnabled)" 2>/dev/null || echo "false")

if [ "$BILLING_ENABLED" = "True" ] || [ "$BILLING_ENABLED" = "true" ]; then
  success "Billing is already linked to ${PROJECT_ID}."
else
  echo -e "${YELLOW}${BOLD}ACTION REQUIRED:${NC} You need to link a billing account to your project.\n"
  echo -e "This cannot be done automatically via CLI in most configurations.\n"
  echo -e "Please open the following URL in your browser:\n"
  echo -e "  ${CYAN}${BOLD}https://console.cloud.google.com/billing/linkedaccount?project=${PROJECT_ID}${NC}\n"
  echo -e "Steps:"
  echo -e "  1. Click ${BOLD}'Link a billing account'${NC}"
  echo -e "  2. Select your billing account from the dropdown"
  echo -e "  3. Click ${BOLD}'Set account'${NC}"
  echo ""

  # Wait for user to link billing
  BILLING_ATTEMPTS=0
  MAX_BILLING_ATTEMPTS=10
  while [ $BILLING_ATTEMPTS -lt $MAX_BILLING_ATTEMPTS ]; do
    read -rp "$(echo -e "${BOLD}Press Enter once billing is linked (attempt $((BILLING_ATTEMPTS+1))/${MAX_BILLING_ATTEMPTS})...${NC}")" _
    BILLING_ENABLED=$(gcloud billing projects describe "$PROJECT_ID" --format="value(billingEnabled)" 2>/dev/null || echo "false")
    if [ "$BILLING_ENABLED" = "True" ] || [ "$BILLING_ENABLED" = "true" ]; then
      success "Billing verified — linked to ${PROJECT_ID}."
      break
    fi
    warn "Billing not detected yet."
    BILLING_ATTEMPTS=$((BILLING_ATTEMPTS + 1))
  done

  if [ "$BILLING_ENABLED" != "True" ] && [ "$BILLING_ENABLED" != "true" ]; then
    error "Billing must be linked to proceed. Re-run this script after linking billing."
    exit 1
  fi
fi

# ============================================================
# Step 4: Choose region and machine type
# ============================================================
header "Step 4: Configuration"

echo -e "${CYAN}Tip: Press Enter to accept the default value shown in brackets.${NC}\n"

prompt_input GCP_ZONE "GCP zone" "us-central1-a"
GCP_REGION=$(echo "$GCP_ZONE" | sed 's/-[a-z]$//')

prompt_input MACHINE_TYPE "Machine type" "e2-highmem-2"
prompt_input DISK_SIZE "Boot disk size (GB)" "128"
if prompt_yes_no "Enable noVNC fallback/debug desktop access?" "n"; then
  HOSTED_ALLOW_NOVNC_FALLBACK="true"
else
  HOSTED_ALLOW_NOVNC_FALLBACK="false"
fi

echo ""
info "Configuration summary:"
echo "  Project:      ${PROJECT_ID}"
echo "  User ID:      ${USER_ID}"
echo "  Zone:         ${GCP_ZONE}"
echo "  Region:       ${GCP_REGION}"
echo "  Machine:      ${MACHINE_TYPE}"
echo "  Disk:         ${DISK_SIZE} GB"
echo "  Security:     IAP-only (no public IP)"
echo "  Runtime:      Headless Pane daemon"
echo "  noVNC debug:  ${HOSTED_ALLOW_NOVNC_FALLBACK}"
echo ""

if ! prompt_yes_no "Proceed with Terraform apply?"; then
  info "Aborted by user."
  exit 0
fi

# ============================================================
# Step 5: Generate VNC password
# ============================================================
header "Step 5: VNC Password"

# Check for existing password in config
EXISTING_VNC_PW=""
if [ -f "$PANE_CONFIG" ] && command -v jq &>/dev/null; then
  EXISTING_VNC_PW=$(jq -r '.cloud.vncPassword // ""' "$PANE_CONFIG" 2>/dev/null || echo "")
fi

if [ -n "$EXISTING_VNC_PW" ]; then
  VNC_PASSWORD="$EXISTING_VNC_PW"
  success "Reusing existing VNC password from config."
else
  VNC_PASSWORD=$(openssl rand -base64 12)
  success "VNC password generated."
fi
echo -e "\n  ${BOLD}VNC Password: ${YELLOW}${VNC_PASSWORD}${NC}\n"
if [ "$HOSTED_ALLOW_NOVNC_FALLBACK" = "true" ]; then
  echo -e "  ${CYAN}Save this password — you'll need it for optional noVNC fallback access.${NC}\n"
else
  echo -e "  ${CYAN}noVNC fallback is disabled by default; this password is retained only for future recovery use.${NC}\n"
fi

# Save progress: zone and VNC password now known
save_cloud_config "$PROJECT_ID" "$GCP_ZONE" "" "$VNC_PASSWORD"
info "Progress saved to config."

# ============================================================
# Step 6: Terraform init & apply
# ============================================================
header "Step 6: Provisioning Infrastructure"

if [ ! -d "$TERRAFORM_DIR" ]; then
  error "Terraform directory not found at: ${TERRAFORM_DIR}"
  error "Make sure you're running this from the Pane repo root."
  exit 1
fi

cd "$TERRAFORM_DIR"

info "Running terraform init..."
terraform init -input=false

info "Running terraform apply..."
terraform apply \
  -var="project_id=${PROJECT_ID}" \
  -var="user_id=${USER_ID}" \
  -var="zone=${GCP_ZONE}" \
  -var="region=${GCP_REGION}" \
  -var="machine_type=${MACHINE_TYPE}" \
  -var="disk_size_gb=${DISK_SIZE}" \
  -var="vnc_password=${VNC_PASSWORD}" \
  -var="remote_client_id=${HOSTED_REMOTE_PROFILE_ID}" \
  -var="remote_client_label=${HOSTED_REMOTE_PROFILE_LABEL}" \
  -var="remote_client_token=${HOSTED_REMOTE_PROFILE_TOKEN}" \
  -var="remote_daemon_port=${HOSTED_DAEMON_PORT}" \
  -var="enable_novnc_fallback=${HOSTED_ALLOW_NOVNC_FALLBACK}" \
  -auto-approve

success "Infrastructure provisioned!"

# Capture outputs
INSTANCE_NAME=$(terraform output -raw instance_name 2>/dev/null)
SSH_CMD=$(terraform output -raw ssh_command 2>/dev/null)
TUNNEL_CMD=$(terraform output -raw daemon_tunnel_command 2>/dev/null)
NOVNC_URL=$(terraform output -raw novnc_url 2>/dev/null)
HOSTED_DAEMON_PORT=$(terraform output -raw remote_daemon_port 2>/dev/null || echo "$HOSTED_DAEMON_PORT")
HOSTED_REMOTE_PROFILE_ID=$(terraform output -raw remote_client_id 2>/dev/null || echo "$HOSTED_REMOTE_PROFILE_ID")
HOSTED_REMOTE_PROFILE_LABEL=$(terraform output -raw remote_client_label 2>/dev/null || echo "$HOSTED_REMOTE_PROFILE_LABEL")
HOSTED_REMOTE_PROFILE_TOKEN=$(terraform output -raw remote_client_token 2>/dev/null || echo "$HOSTED_REMOTE_PROFILE_TOKEN")
HOSTED_ALLOW_NOVNC_FALLBACK=$(normalize_bool "$(terraform output -raw novnc_fallback_enabled 2>/dev/null || echo "$HOSTED_ALLOW_NOVNC_FALLBACK")")
HOSTED_DAEMON_BASE_URL=$(terraform output -raw daemon_base_url 2>/dev/null || echo "$HOSTED_DAEMON_BASE_URL")
HOSTED_DAEMON_STATUS="bootstrapping"

# Save progress: instance name now known - this is the critical save!
save_cloud_config "$PROJECT_ID" "$GCP_ZONE" "$INSTANCE_NAME" "$VNC_PASSWORD"
success "Config saved with all VM details."

# ============================================================
# Step 7: Wait for VM setup to complete
# ============================================================
header "Step 7: Waiting for VM Setup"

info "The VM is running the setup script (installs packages, Node.js, Pane, etc.)"
info "This typically takes 3-5 minutes on a fresh VM.\n"

# Poll for setup completion by checking the daemon health endpoint through SSH
MAX_WAIT=600  # 10 minutes max
ELAPSED=0
INTERVAL=15

while [ $ELAPSED -lt $MAX_WAIT ]; do
  echo -ne "\r  Waiting... (${ELAPSED}s / ${MAX_WAIT}s)"

  # Try to SSH in and check if setup is done (daemon health endpoint ready)
  SETUP_DONE=$(gcloud compute ssh "$INSTANCE_NAME" \
    --zone="$GCP_ZONE" \
    --project="$PROJECT_ID" \
    --tunnel-through-iap \
    --command="curl -fsS http://127.0.0.1/health >/dev/null 2>&1 && echo 'ready' || echo 'not-ready'" \
    2>/dev/null || echo "ssh-failed")

  if [ "$SETUP_DONE" = "ready" ]; then
    echo ""
    HOSTED_DAEMON_STATUS="ready"
    save_cloud_config "$PROJECT_ID" "$GCP_ZONE" "$INSTANCE_NAME" "$VNC_PASSWORD"
    success "VM setup complete! Hosted daemon health check passed."
    break
  fi

  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  echo ""
  warn "Setup is taking longer than expected. You can check the logs manually:"
  echo "  ${SSH_CMD} --command='tail -50 /var/log/syslog | grep startup-script'"
fi

# ============================================================
# Step 8: Configure Pane
# ============================================================
header "Step 8: Configuring Pane"

# PANE_CONFIG is set at script start (handles WSL → Windows path)
mkdir -p "$PANE_CONFIG_DIR"

# Get GCP access token for API calls
GCP_TOKEN=$(gcloud auth print-access-token 2>/dev/null || echo "")
CURRENT_GCP_TOKEN="$GCP_TOKEN"
TUNNEL_PORT="$HOSTED_TUNNEL_PORT"

if command -v jq &>/dev/null; then
  save_cloud_config "$PROJECT_ID" "$GCP_ZONE" "$INSTANCE_NAME" "$VNC_PASSWORD" "$TUNNEL_PORT"
  success "Pane configured with cloud settings."
  info "Settings written to ${PANE_CONFIG}"
  info "Note: The GCP access token expires in ~1 hour. Pane auto-refreshes it via gcloud."
else
  warn "jq not installed — skipping automatic Pane config."
  warn "You can install jq and re-run this script, or configure cloud settings manually in Pane Settings."
fi

# ============================================================
# Done!
# ============================================================
header "Setup Complete!"

echo -e "${GREEN}${BOLD}Your Pane Cloud VM is ready!${NC}\n"

echo -e "${BOLD}Connect to your hosted workspace:${NC}"
echo ""
echo -e "  ${CYAN}1. Start the daemon IAP tunnel (run in a separate terminal):${NC}"
echo -e "     ${BOLD}${TUNNEL_CMD}${NC}"
echo ""
echo -e "  ${CYAN}2. Open Pane locally and click ${BOLD}Connect Cloud Runtime${NC}${CYAN}.${NC}"
echo ""
echo -e "  ${CYAN}3. Pane will connect to:${NC} ${BOLD}${HOSTED_DAEMON_BASE_URL}${NC}"
echo ""

if [ "$HOSTED_ALLOW_NOVNC_FALLBACK" = "true" ] && [ -n "$NOVNC_URL" ]; then
  echo -e "${BOLD}Optional noVNC fallback/debug access:${NC}"
  echo -e "  ${BOLD}${NOVNC_URL}${NC}"
  echo -e "  Password: ${BOLD}${VNC_PASSWORD}${NC}"
  echo -e "  Desktop fallback is manual so it does not compete with the hosted daemon:"
  echo -e "    ${BOLD}sudo supervisorctl stop pane-cloud:pane-daemon${NC}"
  echo -e "    ${BOLD}sudo supervisorctl start pane-cloud:PaneDesktop${NC}"
  echo ""
fi

echo -e "${BOLD}SSH access:${NC}"
echo -e "  ${BOLD}${SSH_CMD}${NC}"
echo ""

echo -e "${BOLD}First-time setup inside the VM:${NC}"
echo -e "  1. ${BOLD}gh auth login${NC}    — Authenticate GitHub"
echo -e "  2. ${BOLD}claude login${NC}     — Authenticate Claude Code"
echo -e "  3. Set API keys in Pane Settings"
echo ""

echo -e "${BOLD}Cost management:${NC}"
echo -e "  Stop VM:   gcloud compute instances stop ${INSTANCE_NAME} --zone=${GCP_ZONE} --project=${PROJECT_ID}"
echo -e "  Start VM:  gcloud compute instances start ${INSTANCE_NAME} --zone=${GCP_ZONE} --project=${PROJECT_ID}"
echo -e "  Delete VM: bash cloud/scripts/setup-cloud.sh --destroy"
echo ""

echo -e "${BOLD}Security:${NC}"
echo -e "  - No public IP — VM is only accessible via GCP IAP tunnel"
echo -e "  - All traffic authenticated through your Google account"
echo -e "  - Pane daemon requests require the generated bearer token in your linked local profile"
echo -e "  - Daily snapshots with 7-day retention for backups"
echo ""
