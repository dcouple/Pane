#!/usr/bin/env bash
# Claude Code statusLine — powerline-style segments
# Cross-OS: Linux, macOS (bash 3.2), Windows Git Bash / WSL.
# Requires: jq, git, awk, grep, sed, tail, basename, dirname.
# Requires a Powerline or Nerd Font in the terminal for the  separator glyph.

input=$(cat)

model_display=$(printf '%s' "$input" | jq -r '.model.display_name // .model.id // "unknown"')
model_id=$(printf '%s' "$input" | jq -r '.model.id // ""')
cwd=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // ""')
transcript=$(printf '%s' "$input" | jq -r '.transcript_path // ""')
ctx_window=$(printf '%s' "$input" | jq -r '.context_window.context_window_size // 200000')
used_pct_raw=$(printf '%s' "$input" | jq -r '.context_window.used_percentage // empty')

# 1M context detection via model id suffix
context_suffix=""
case "$model_id" in
  *"[1m]"*) ctx_window=1000000; context_suffix=" (1M context)" ;;
esac

# Shorten "Claude Opus 4.7" -> "Opus 4.7"
model_short=$(printf '%s' "$model_display" | sed 's/^Claude //')

# Token usage from transcript tail
used_tokens=0
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  usage_json=$(tail -200 "$transcript" 2>/dev/null | grep -o '"usage":{[^}]*}' | tail -1)
  if [ -n "$usage_json" ]; then
    input_tok=$(printf '%s' "$usage_json"    | grep -o '"input_tokens":[0-9]*'                | grep -o '[0-9]*$')
    cache_read=$(printf '%s' "$usage_json"   | grep -o '"cache_read_input_tokens":[0-9]*'     | grep -o '[0-9]*$')
    cache_create=$(printf '%s' "$usage_json" | grep -o '"cache_creation_input_tokens":[0-9]*' | grep -o '[0-9]*$')
    output_tok=$(printf '%s' "$usage_json"   | grep -o '"output_tokens":[0-9]*'               | grep -o '[0-9]*$')
    used_tokens=$(( ${input_tok:-0} + ${cache_read:-0} + ${cache_create:-0} + ${output_tok:-0} ))
  fi
fi

# Fallback to pre-calculated percentage
if [ "$used_tokens" -eq 0 ] && [ -n "$used_pct_raw" ] && [ "$used_pct_raw" != "null" ]; then
  used_tokens=$(awk -v p="$used_pct_raw" -v w="$ctx_window" 'BEGIN{printf "%d", p/100*w}')
fi

fmt_k() {
  n=$1
  if [ -z "$n" ] || [ "$n" -eq 0 ] 2>/dev/null; then echo "0"; return; fi
  if [ "$n" -ge 1000 ]; then
    awk -v n="$n" 'BEGIN{printf "%.1fk", n/1000}'
  else
    echo "$n"
  fi
}

used_fmt=$(fmt_k "$used_tokens")

if [ "$used_tokens" -gt 0 ] && [ "$ctx_window" -gt 0 ] 2>/dev/null; then
  pct=$(awk -v u="$used_tokens" -v w="$ctx_window" 'BEGIN{printf "%d", u/w*100}')
else
  pct=0
fi

# Git branch + clean/dirty + project name (follows worktrees to the main repo root)
branch=""
git_mark=""
project=""
if [ -n "$cwd" ] && [ -d "$cwd" ]; then
  branch=$(git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null)
  if [ -n "$branch" ]; then
    if [ -z "$(git -C "$cwd" status --porcelain 2>/dev/null)" ]; then
      git_mark="✓"
    else
      git_mark="●"
    fi
    # --git-common-dir points at the main repo's .git even inside a worktree.
    # It may be relative; resolve against cwd if so. Avoids needing git 2.31+ (--path-format=absolute).
    common_dir=$(git -C "$cwd" rev-parse --git-common-dir 2>/dev/null)
    if [ -n "$common_dir" ]; then
      case "$common_dir" in
        /*|[A-Za-z]:[\\/]*) ;;          # already absolute (unix or windows drive)
        *) common_dir="$cwd/$common_dir" ;;
      esac
      project=$(basename "$(dirname "$common_dir")")
    fi
  fi
fi

# Fallback: if not in a git repo, use cwd basename for the project slot
if [ -z "$project" ]; then
  project=$(basename "$cwd")
  [ -z "$project" ] && project="."
fi

# 256-color palette
model_bg=203   # coral/red
if [ "$pct" -lt 50 ]; then
  ctx_bg=220   # yellow
elif [ "$pct" -lt 75 ]; then
  ctx_bg=214   # orange-yellow
elif [ "$pct" -lt 90 ]; then
  ctx_bg=208   # orange
else
  ctx_bg=196   # red
fi
project_bg=238 # dark gray
branch_bg=34   # green
fg_dark=16     # black
fg_light=252   # light gray

# Powerline glyphs as literal UTF-8 bytes — works in bash 3.2 (macOS) where $'\uNNNN' isn't supported.
SEP=""       # U+E0B0 right-pointing arrow (between segments)
CAP_L=""     # U+E0B6 left rounded cap (pill start)
CAP_R=""     # U+E0B4 right rounded cap (pill end)

seg() {
  # bg, fg, text
  printf '\033[48;5;%sm\033[38;5;%sm %s \033[0m' "$1" "$2" "$3"
}
sep_mid() {
  # from_bg (becomes fg of arrow), to_bg (becomes bg of arrow)
  printf '\033[48;5;%sm\033[38;5;%sm%s\033[0m' "$2" "$1" "$SEP"
}
cap_left() {
  # bg of first segment, drawn as fg on default bg so the curve blends in
  printf '\033[38;5;%sm%s\033[0m' "$1" "$CAP_L"
}
cap_right() {
  # bg of last segment, drawn as fg on default bg
  printf '\033[38;5;%sm%s\033[0m' "$1" "$CAP_R"
}

out=""
out=${out}$(cap_left "$model_bg")
out=${out}$(seg "$model_bg" "$fg_dark" "Model: ${model_short}${context_suffix}")
out=${out}$(sep_mid "$model_bg" "$ctx_bg")
out=${out}$(seg "$ctx_bg" "$fg_dark" "Ctx: ${used_fmt} (${pct}%)")
out=${out}$(sep_mid "$ctx_bg" "$project_bg")
out=${out}$(seg "$project_bg" "$fg_light" "${project}")

if [ -n "$branch" ]; then
  out=${out}$(sep_mid "$project_bg" "$branch_bg")
  out=${out}$(seg "$branch_bg" "$fg_dark" "${git_mark} ${branch}")
  out=${out}$(cap_right "$branch_bg")
else
  out=${out}$(cap_right "$project_bg")
fi

printf '%s\n' "$out"
