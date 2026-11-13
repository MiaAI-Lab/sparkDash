# banner.ps1 - truecolour sparkDash wordmark for the native Windows 11 ARM64 path (no Docker, no WSL).
# SPDX-License-Identifier: Apache-2.0
#
# The wordmark is drawn as block characters and coloured with a teal→green→amber gradient
# (a "spark" palette). It is generated at runtime from a compact pixel font, so there are no
# external art files to keep in sync and no encoding pitfalls: the art is UTF-16 in-process and
# is emitted straight through WriteConsoleW.
#
# Truecolour is ON by default, but it is only emitted when the console really supports it.
# Windows PowerShell 5.1 in a classic conhost does NOT enable virtual-terminal processing by
# default: raw ESC sequences would be printed as literal text ("[38;2;...m" garbage) instead of
# colour. So this banner (a) asks the console to enable VT, (b) writes the art through
# WriteConsoleW (UTF-16, immune to the OEM code page), and (c) if VT is unavailable or stdout is
# not a real console, strips every SGR sequence and prints the plain block art instead. The
# wordmark is character art first, colour second - never a wall of escape codes.
#
# Usage (dot-source, then call):
#   . (Join-Path $MyDir "scripts/banner.ps1")
#   Show-SparkDashBanner
#   Show-SparkDashBannerCaption
#
# Environment:
#   (default)                  truecolour, auto-downgraded to plain art when VT is missing
#   NO_COLOR=1                 force plain block art (standard convention)
#   SPARKDASH_BANNER_PLAIN=1   force plain block art
#   SPARKDASH_BANNER_COLOR=0   force plain block art
#   SPARKDASH_NO_BANNER=1      print nothing

$BannerNativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class SdBannerConsole
{
    private const int STD_OUTPUT_HANDLE = -11;
    private const uint ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetConsoleMode(IntPtr h, out uint mode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleMode(IntPtr h, uint mode);

    [DllImport("kernel32.dll", EntryPoint = "WriteConsoleW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool WriteConsole(IntPtr h, string buffer, uint chars, out uint written, IntPtr reserved);

    public static bool EnableVirtualTerminal()
    {
        IntPtr h = GetStdHandle(STD_OUTPUT_HANDLE);
        uint mode;
        if (!GetConsoleMode(h, out mode)) return false;
        if ((mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0) return true;
        if (!SetConsoleMode(h, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING)) return false;
        if (!GetConsoleMode(h, out mode)) return false;
        return (mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0;
    }

    // WriteConsoleW takes UTF-16, so the block-drawing glyphs are never re-encoded through
    // the console's OEM code page (which would turn them into '?' on a non-UTF-8 host).
    public static bool Write(string text)
    {
        IntPtr h = GetStdHandle(STD_OUTPUT_HANDLE);
        uint written;
        return WriteConsole(h, text, (uint)text.Length, out written, IntPtr.Zero);
    }
}
'@

$script:BannerNativeReady = $false
$script:BannerColourOk = $null

function Initialize-BannerConsole {
    if ($script:BannerNativeReady) { return $true }
    try {
        if (-not ('SdBannerConsole' -as [type])) {
            Add-Type -TypeDefinition $BannerNativeSource -ErrorAction Stop
        }
        $script:BannerNativeReady = $true
    } catch {
        $script:BannerNativeReady = $false
    }
    return $script:BannerNativeReady
}

function Test-BannerColour {
    if ($null -ne $script:BannerColourOk) { return $script:BannerColourOk }
    # Truecolour is the default; only an explicit opt-out turns it off.
    if ($env:NO_COLOR -or $env:SPARKDASH_BANNER_PLAIN -or $env:SPARKDASH_BANNER_COLOR -eq '0') {
        $script:BannerColourOk = $false
        return $false
    }
    if (-not (Initialize-BannerConsole)) {
        $script:BannerColourOk = $false
        return $false
    }
    # If VT cannot be enabled, the console would print the ESC codes as text: downgrade.
    try { $script:BannerColourOk = [SdBannerConsole]::EnableVirtualTerminal() }
    catch { $script:BannerColourOk = $false }
    return $script:BannerColourOk
}

function Write-BannerText {
    param([string]$Text)
    if ((Initialize-BannerConsole) -and [SdBannerConsole]::Write($Text)) { return }
    # Not a real console handle (the ISE, a pipe, a redirected host). Never let raw SGR
    # sequences reach a log or a pipe as literal text: print the plain block art.
    [Console]::Out.Write([regex]::Replace($Text, '\x1b\[[0-9;]*m', ''))
}

# ---- the wordmark: a compact 5-row pixel font ------------------------------------------
# Only the letters in "sparkDash" are defined (plus a space). Each glyph is 5 rows tall and
# 5 columns wide, so the composed title is a clean 5x45 block.
$script:SdGlyphs = @{
    's' = @(" ███ ", "█    ", " ███ ", "    █", " ███ ")
    'p' = @(" ███ ", "█   █", "█   █", "█    ", "█    ")
    'a' = @("    █", "  ███", "█   █", "█   █", "████ ")
    'r' = @("██  ██", "██ ██ ", "██    ", "██    ", "██    ")
    'k' = @("█   █", "█  ██", "███  ", "█  ██", "█   █")
    'D' = @("████ ", "█   █", "█   █", "█   █", "████ ")
    'h' = @("█   █", "██  █", "█   █", "█   █", "█   █")
    ' ' = @("     ", "     ", "     ", "     ", "     ")
}

# Truecolour "spark" palette: teal -> green -> amber, as a function of horizontal position.
function Get-GradientRGB([double]$f) {
    if ($f -lt 0) { $f = 0 } elseif ($f -gt 1) { $f = 1 }
    $s0 = @(18, 200, 192)   # teal
    $s1 = @(86, 222, 122)   # green
    $s2 = @(255, 188, 74)   # amber
    if ($f -lt 0.5) { $a = $s0; $b = $s1; $t = $f / 0.5 }
    else             { $a = $s1; $b = $s2; $t = ($f - 0.5) / 0.5 }
    $r = [int]($a[0] + ($b[0] - $a[0]) * $t)
    $g = [int]($a[1] + ($b[1] - $a[1]) * $t)
    $bl = [int]($a[2] + ($b[2] - $a[2]) * $t)
    return "${r};${g};${bl}"
}

# Compose the "sparkDash" wordmark into a single CRLF-terminated string. With -Colour the block
# runs get a horizontal truecolour gradient; without it, plain block characters are emitted.
function Build-SparkDashArt([bool]$Colour) {
    $title = "sparkDash"
    $width = $title.Length * 5
    $esc = [char]27
    $block = "█"
    $sb = New-Object System.Text.StringBuilder
    foreach ($row in 0..4) {
        # Build the raw row (5 chars per glyph) first, then colour it.
        $raw = ""
        # Index with a [string]: hashtable keys are strings, and PowerShell hashes [char] and
        # string differently, so $glyphs[[char]'s'] would not find the 's' entry.
        foreach ($ch in $title.ToCharArray()) { $raw += $script:SdGlyphs[[string]$ch][$row] }
        $wasColored = $false
        for ($col = 0; $col -lt $raw.Length; $col++) {
            $c = $raw[$col]
            if ($c -eq $block) {
                if ($Colour) {
                    if (-not $wasColored) { [void]$sb.Append("$($esc)[38;2;$(Get-GradientRGB ($col / $width))m"); $wasColored = $true }
                }
                [void]$sb.Append($c)
            } else {
                if ($wasColored) { [void]$sb.Append("$($esc)[0m"); $wasColored = $false }
                [void]$sb.Append(" ")
            }
        }
        if ($wasColored) { [void]$sb.Append("$($esc)[0m") }
        [void]$sb.Append("`r`n")
    }
    return $sb.ToString()
}

function Show-SparkDashBanner {
    if ([Console]::IsOutputRedirected) { return }   # a log or a pipe: no art
    if ($env:SPARKDASH_NO_BANNER) { return }
    $colour = Test-BannerColour
    $art = Build-SparkDashArt $colour
    if (-not $colour) { $art = [regex]::Replace($art, '\x1b\[[0-9;]*m', '') }
    Write-BannerText $art
}

function Show-SparkDashBannerCaption {
    param([string]$Text = 'sparkDash  ·  multi-Spark monitoring  ·  Windows 11 ARM64 (native, no container, no WSL)')
    if ([Console]::IsOutputRedirected) { return }
    if ($env:SPARKDASH_NO_BANNER) { return }
    if (-not (Test-BannerColour)) { Write-Host "  $Text"; return }
    $esc = [char]27
    Write-Host "  $esc[2m$Text$esc[0m"
}
