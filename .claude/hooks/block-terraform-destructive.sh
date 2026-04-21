#!/bin/bash
# block-terraform-destructive.sh
# PreToolUse hook that blocks destructive Terraform commands.
# Allowed: plan, init, fmt, validate, output, show, state list, state show, providers, graph, console, version
# Blocked: destroy, apply, taint, untaint, state rm, state mv, force-unlock, workspace delete, import

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Exit early if no command or not a terraform command
if [ -z "$COMMAND" ]; then
  exit 0
fi

# Strip quoted strings so we don't match terraform keywords inside commit messages,
# echo statements, comments, etc. Replace single- and double-quoted content with empty.
STRIPPED=$(echo "$COMMAND" | tr '\n' ' ' | sed "s/'[^']*'//g" | sed 's/"[^"]*"//g')

# Normalize: collapse whitespace and strip leading/trailing spaces
NORMALIZED=$(echo "$STRIPPED" | sed 's/  */ /g' | sed 's/^ //;s/ $//')

# Check if this involves terraform at all (handles terraform, tofu, terragrunt, etc.)
if ! echo "$NORMALIZED" | grep -qiE '(terraform|tofu|terragrunt)'; then
  exit 0
fi

# --- Destructive command patterns ---

# terraform destroy (with or without flags)
if echo "$NORMALIZED" | grep -qiE '(terraform|tofu|terragrunt)\s+destroy'; then
  echo "BLOCKED: 'terraform destroy' is a destructive action and is not allowed. Use 'terraform plan -destroy' to preview what would be destroyed, then ask the user to run the destroy manually." >&2
  exit 2
fi

# terraform apply (blocks all apply — Claude should not apply infra changes)
if echo "$NORMALIZED" | grep -qiE '(terraform|tofu|terragrunt)\s+apply'; then
  echo "BLOCKED: 'terraform apply' is not allowed via Claude. Use 'terraform plan' to preview changes, then ask the user to run 'terraform apply' manually." >&2
  exit 2
fi

# terraform taint / untaint (marks resources for forced recreation)
if echo "$NORMALIZED" | grep -qiE '(terraform|tofu|terragrunt)\s+(taint|untaint)'; then
  echo "BLOCKED: 'terraform taint/untaint' can force resource destruction and recreation. Ask the user to run this manually." >&2
  exit 2
fi

# terraform state rm (removes resources from state, orphaning real infra)
if echo "$NORMALIZED" | grep -qiE '(terraform|tofu|terragrunt)\s+state\s+rm'; then
  echo "BLOCKED: 'terraform state rm' removes resources from state without destroying them, which can orphan infrastructure. Ask the user to run this manually." >&2
  exit 2
fi

# terraform state mv (moves resources in state — risky if wrong)
if echo "$NORMALIZED" | grep -qiE '(terraform|tofu|terragrunt)\s+state\s+mv'; then
  echo "BLOCKED: 'terraform state mv' modifies the state file directly. Ask the user to run this manually." >&2
  exit 2
fi

# terraform force-unlock (force unlocks remote state)
if echo "$NORMALIZED" | grep -qiE '(terraform|tofu|terragrunt)\s+force-unlock'; then
  echo "BLOCKED: 'terraform force-unlock' can corrupt shared state locks. Ask the user to run this manually." >&2
  exit 2
fi

# terraform workspace delete
if echo "$NORMALIZED" | grep -qiE '(terraform|tofu|terragrunt)\s+workspace\s+delete'; then
  echo "BLOCKED: 'terraform workspace delete' destroys a workspace and its state. Ask the user to run this manually." >&2
  exit 2
fi

# terraform import (binds real resources to state — risky if misconfigured)
if echo "$NORMALIZED" | grep -qiE '(terraform|tofu|terragrunt)\s+import\s'; then
  echo "BLOCKED: 'terraform import' modifies the state file by importing existing resources. Ask the user to run this manually." >&2
  exit 2
fi

# If we got here, the terraform command is safe (plan, init, fmt, validate, output, show, etc.)
exit 0
