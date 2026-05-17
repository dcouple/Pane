# Pane Cloud - GCP Terraform Configuration
# Fully self-contained: provisions a complete Pane cloud VM from scratch.
# No external dependencies — everything is inlined.
#
# Usage:
#   terraform init
#   terraform plan \
#     -var="project_id=YOUR_PROJECT" \
#     -var="user_id=user123" \
#     -var="vnc_password=RECOVERY_PASSWORD" \
#     -var="remote_client_id=cloud-user123" \
#     -var="remote_client_label=Pane Cloud Workspace" \
#     -var="remote_client_token=GENERATED_TOKEN"

terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

# ============================================================
# Variables
# ============================================================

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "user_id" {
  description = "Unique user identifier"
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.user_id)) && length(var.user_id) >= 2 && length(var.user_id) <= 30
    error_message = "user_id must be 2-30 characters, lowercase alphanumeric and hyphens only."
  }
}

variable "machine_type" {
  description = "GCP machine type (e2-highmem-2 = 2 vCPU, 16GB RAM)"
  type        = string
  default     = "e2-highmem-2"
}

variable "zone" {
  description = "GCP zone"
  type        = string
  default     = "us-central1-a"
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "disk_size_gb" {
  description = "Boot disk size in GB"
  type        = number
  default     = 64
  validation {
    condition     = var.disk_size_gb >= 32 && var.disk_size_gb <= 2048
    error_message = "disk_size_gb must be between 32 and 2048."
  }
}

variable "vnc_password" {
  description = "Pre-generated VNC password (passed to VM startup script)"
  type        = string
  sensitive   = true
}

variable "remote_client_id" {
  description = "Stable remote profile/client ID for the hosted workspace daemon"
  type        = string
}

variable "remote_client_label" {
  description = "Human-readable label for the hosted workspace daemon client"
  type        = string
}

variable "remote_client_token" {
  description = "Bearer token the hosted workspace daemon will accept from the linked client profile"
  type        = string
  sensitive   = true
}

variable "remote_daemon_port" {
  description = "Loopback port the hosted Pane daemon listens on inside the VM"
  type        = number
  default     = 42137
}

variable "enable_novnc_fallback" {
  description = "Whether to keep the legacy noVNC desktop stack available for fallback/debug access"
  type        = bool
  default     = false
}

variable "snapshot_start_time" {
  description = "Daily snapshot start time (HH:MM format, UTC)"
  type        = string
  default     = "04:00"
}

# ============================================================
# Provider
# ============================================================

provider "google" {
  project = var.project_id
  region  = var.region
}

# ============================================================
# Enable Required GCP APIs
# ============================================================

resource "google_project_service" "compute" {
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "iap" {
  service            = "iap.googleapis.com"
  disable_on_destroy = false
}

# ============================================================
# Firewall Rules — IAP-only, NO public access
# ============================================================

# Allow SSH and noVNC ONLY from GCP IAP tunnel IP range (35.235.240.0/20)
# This means: no one can reach the VM unless authenticated via gcloud IAP
resource "google_compute_firewall" "pane_iap" {
  name     = "pane-iap-${var.user_id}"
  network  = "default"
  priority = 900

  allow {
    protocol = "tcp"
    ports    = ["22", "80"]
  }

  # GCP Identity-Aware Proxy source range — NOT the public internet
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["pane-cloud"]

  depends_on = [google_project_service.compute]
}

# Explicitly deny all other inbound traffic to Pane VMs
resource "google_compute_firewall" "pane_deny_all" {
  name     = "pane-deny-all-${var.user_id}"
  network  = "default"
  priority = 1000

  deny {
    protocol = "tcp"
  }

  deny {
    protocol = "udp"
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["pane-cloud"]

  depends_on = [google_project_service.compute]
}

# ============================================================
# Cloud NAT — outbound internet for VM without a public IP
# Required for apt-get, npm install, downloading Pane, etc.
# ============================================================

resource "google_compute_router" "pane" {
  name    = "pane-router-${var.user_id}"
  network = "default"
  region  = var.region

  depends_on = [google_project_service.compute]
}

resource "google_compute_router_nat" "pane" {
  name                               = "pane-nat-${var.user_id}"
  router                             = google_compute_router.pane.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = false
    filter = "ALL"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# ============================================================
# Compute Instance — NO public IP
# ============================================================

resource "google_compute_instance" "pane" {
  name         = "pane-${var.user_id}"
  machine_type = var.machine_type
  zone         = var.zone

  tags = ["pane-cloud"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = var.disk_size_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    network = "default"
    # NO access_config = NO public IP
    # VM is only reachable via IAP tunnel
  }

  # Pass hosted workspace bootstrap settings via instance metadata.
  metadata = {
    vnc-password          = var.vnc_password
    remote-client-id      = var.remote_client_id
    remote-client-label   = var.remote_client_label
    remote-client-token   = var.remote_client_token
    remote-daemon-port    = tostring(var.remote_daemon_port)
    enable-novnc-fallback = tostring(var.enable_novnc_fallback)
  }

  metadata_startup_script = file("${path.module}/../../scripts/setup-vm.sh")

  labels = {
    purpose = "pane-cloud"
    user_id = var.user_id
  }

  # Allow stopping for cost savings
  desired_status = "RUNNING"

  lifecycle {
    ignore_changes = [desired_status]
  }

  depends_on = [google_project_service.compute, google_project_service.iap, google_compute_router_nat.pane]
}

# ============================================================
# Snapshot Schedule (Daily Backups)
# ============================================================

resource "google_compute_resource_policy" "daily_backup" {
  name   = "pane-backup-${var.user_id}"
  region = var.region

  snapshot_schedule_policy {
    schedule {
      daily_schedule {
        days_in_cycle = 1
        start_time    = var.snapshot_start_time
      }
    }
    retention_policy {
      max_retention_days    = 7
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }
  }

  depends_on = [google_project_service.compute]
}

resource "google_compute_disk_resource_policy_attachment" "backup" {
  name = google_compute_resource_policy.daily_backup.name
  disk = google_compute_instance.pane.name
  zone = var.zone
}

# ============================================================
# Outputs
# ============================================================

output "instance_id" {
  value = google_compute_instance.pane.instance_id
}

output "instance_name" {
  value = google_compute_instance.pane.name
}

output "project_id" {
  value = var.project_id
}

output "zone" {
  value = var.zone
}

output "vnc_password" {
  value     = var.vnc_password
  sensitive = true
}

output "ssh_command" {
  description = "SSH into the VM via IAP tunnel (requires gcloud auth)"
  value       = "gcloud compute ssh pane-${var.user_id} --zone=${var.zone} --project=${var.project_id} --tunnel-through-iap"
}

output "novnc_tunnel_command" {
  description = "Legacy/fallback tunnel command; the same tunnel carries daemon and optional noVNC traffic"
  value       = "gcloud compute start-iap-tunnel pane-${var.user_id} 80 --local-host-port=localhost:8080 --zone=${var.zone} --project=${var.project_id}"
}

output "daemon_tunnel_command" {
  description = "Start the IAP tunnel used by the hosted workspace daemon and optional noVNC fallback"
  value       = "gcloud compute start-iap-tunnel pane-${var.user_id} 80 --local-host-port=localhost:8080 --zone=${var.zone} --project=${var.project_id}"
}

output "daemon_base_url" {
  description = "Base URL the local Pane client should use while the IAP tunnel is running"
  value       = "http://127.0.0.1:8080/daemon/"
}

output "remote_client_id" {
  description = "Stable hosted workspace remote profile/client ID"
  value       = var.remote_client_id
}

output "remote_client_label" {
  description = "Human-readable hosted workspace remote profile/client label"
  value       = var.remote_client_label
}

output "remote_client_token" {
  description = "Bearer token the hosted workspace daemon accepts from the linked client"
  value       = var.remote_client_token
  sensitive   = true
}

output "remote_daemon_port" {
  description = "Loopback port the hosted Pane daemon listens on inside the VM"
  value       = var.remote_daemon_port
}

output "novnc_url" {
  description = "Open this in browser AFTER starting the IAP tunnel when noVNC fallback is enabled"
  value       = var.enable_novnc_fallback ? "http://localhost:8080/novnc/vnc.html?autoconnect=true&resize=scale" : ""
}

output "novnc_fallback_enabled" {
  description = "Whether the hosted VM keeps the legacy noVNC desktop stack enabled"
  value       = var.enable_novnc_fallback
}

output "setup_log_command" {
  value = "gcloud compute ssh pane-${var.user_id} --zone=${var.zone} --project=${var.project_id} --tunnel-through-iap --command='tail -f /var/log/pane-setup.log'"
}
