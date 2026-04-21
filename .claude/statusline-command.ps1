#Requires -Version 5.1
# Claude Code statusLine — powerline pill, PowerShell version.
# Works in Windows PowerShell 5.1 and PowerShell 7+. No jq required (built-in JSON).
# Terminal must use a Nerd Font or Powerline font to render the  separator/caps.

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$raw  = [Console]::In.ReadToEnd()
$data = $raw | ConvertFrom-Json

$modelDisplay = if ($data.model.display_name) { $data.model.display_name }
                elseif ($data.model.id)       { $data.model.id }
                else                          { 'unknown' }
$modelId      = "$($data.model.id)"
$cwd          = if ($data.workspace.current_dir) { $data.workspace.current_dir }
                elseif ($data.cwd)                 { $data.cwd }
                else                               { '' }
$transcript   = "$($data.transcript_path)"
$ctxWindow    = if ($data.context_window.context_window_size) { [int]$data.context_window.context_window_size } else { 200000 }
$usedPctRaw   = $data.context_window.used_percentage

# 1M context detection
$contextSuffix = ''
if ($modelId.Contains('[1m]')) {
    $ctxWindow     = 1000000
    $contextSuffix = ' (1M context)'
}

$modelShort = $modelDisplay -replace '^Claude ', ''

# Token usage from transcript tail
$usedTokens = 0
if ($transcript -and (Test-Path -LiteralPath $transcript)) {
    $lines     = Get-Content -LiteralPath $transcript -Tail 200
    $lastUsage = $null
    foreach ($line in $lines) {
        if ($line -match '"usage":\{([^}]*)\}') { $lastUsage = $matches[1] }
    }
    if ($lastUsage) {
        $sum = 0
        foreach ($k in 'input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens') {
            if ($lastUsage -match ('"' + [regex]::Escape($k) + '":(\d+)')) { $sum += [int]$matches[1] }
        }
        $usedTokens = $sum
    }
}
if ($usedTokens -eq 0 -and $usedPctRaw) {
    $usedTokens = [int]([double]$usedPctRaw / 100 * $ctxWindow)
}

function Format-K([int]$n) {
    if (-not $n -or $n -eq 0) { return '0' }
    if ($n -ge 1000) { return ('{0:N1}k' -f ($n / 1000.0)) }
    return "$n"
}
$usedFmt = Format-K $usedTokens

$pct = 0
if ($usedTokens -gt 0 -and $ctxWindow -gt 0) {
    $pct = [int]($usedTokens * 100 / $ctxWindow)
}

# Git info — branch, clean/dirty mark, main repo name (follows worktrees)
$branch  = ''
$gitMark = ''
$project = ''
if ($cwd -and (Test-Path -LiteralPath $cwd)) {
    $branch = (& git -C $cwd symbolic-ref --short HEAD 2>$null)
    if ($branch) {
        $status = (& git -C $cwd status --porcelain 2>$null)
        if ([string]::IsNullOrWhiteSpace($status)) { $gitMark = [char]0x2713 } else { $gitMark = [char]0x25CF }

        $commonDir = (& git -C $cwd rev-parse --git-common-dir 2>$null)
        if ($commonDir) {
            if (-not [System.IO.Path]::IsPathRooted($commonDir)) {
                $commonDir = Join-Path $cwd $commonDir
            }
            $project = Split-Path -Leaf (Split-Path -Parent $commonDir)
        }
    }
}
if (-not $project) {
    if ($cwd) { $project = Split-Path -Leaf $cwd }
    if (-not $project) { $project = '.' }
}

# 256-color palette
$modelBg = 203
if     ($pct -lt 50) { $ctxBg = 220 }
elseif ($pct -lt 75) { $ctxBg = 214 }
elseif ($pct -lt 90) { $ctxBg = 208 }
else                 { $ctxBg = 196 }
$projectBg = 238
$branchBg  = 34
$fgDark    = 16
$fgLight   = 252

$ESC   = [char]27
$SEP   = [char]0xE0B0  # powerline arrow
$CAP_L = [char]0xE0B6  # pill left cap
$CAP_R = [char]0xE0B4  # pill right cap

function Seg($bg,$fg,$text)    { "$ESC[48;5;${bg}m$ESC[38;5;${fg}m $text $ESC[0m" }
function SepMid($from,$to)     { "$ESC[48;5;${to}m$ESC[38;5;${from}m$SEP$ESC[0m" }
function CapLeft($bg)          { "$ESC[38;5;${bg}m$CAP_L$ESC[0m" }
function CapRight($bg)         { "$ESC[38;5;${bg}m$CAP_R$ESC[0m" }

$out  = CapLeft  $modelBg
$out += Seg      $modelBg   $fgDark  "Model: $modelShort$contextSuffix"
$out += SepMid   $modelBg   $ctxBg
$out += Seg      $ctxBg     $fgDark  "Ctx: $usedFmt ($pct%)"
$out += SepMid   $ctxBg     $projectBg
$out += Seg      $projectBg $fgLight "$project"
if ($branch) {
    $out += SepMid   $projectBg $branchBg
    $out += Seg      $branchBg  $fgDark  "$gitMark $branch"
    $out += CapRight $branchBg
} else {
    $out += CapRight $projectBg
}
Write-Output $out
