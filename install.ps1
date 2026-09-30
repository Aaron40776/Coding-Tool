# Installs smart on Windows 10/11, or updates it when it is already installed. In PowerShell:
#
#   irm https://raw.githubusercontent.com/Aaron40776/Smart/main/install.ps1 | iex
#
# It goes to %USERPROFILE%\Smart (set $env:SMART_DIR to choose another folder). Needs Git and Node.js 22+.
# Everything runs in a script block that returns on failure: `exit` would close your PowerShell window under `iex`.
& {
    # Native commands report failure through $LASTEXITCODE; 'Stop' would also turn git's progress output into errors.
    $ErrorActionPreference = 'Continue'
    $dir = if ($env:SMART_DIR) { $env:SMART_DIR } else { Join-Path $env:USERPROFILE 'Smart' }

    function Say([string]$text, [string]$color = 'Gray') { Write-Host "smart: $text" -ForegroundColor $color }

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Say 'Git is needed: install it from https://git-scm.com/download/win, then open a new terminal and run this again.' Red
        return
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Say 'Node.js 22 or newer is needed: install it from https://nodejs.org, then open a new terminal and run this again.' Red
        return
    }
    $major = [int](((node --version) -replace '^v', '').Split('.')[0])
    if ($major -lt 22) {
        Say "Node.js 22 or newer is needed (you have $(node --version)): update it from https://nodejs.org." Red
        return
    }
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        Say 'Note: the Claude Code CLI (claude) was not found. Install it and run `claude` once to log in before using smart.' Yellow
    }

    if (Test-Path (Join-Path $dir '.git')) {
        Say "Updating $dir"
        # Older versions ran `npm install`, which can rewrite package-lock.json and block the pull: put it back first.
        git -C $dir checkout -- package-lock.json
        git -C $dir pull --ff-only
    } else {
        Say "Downloading into $dir"
        git clone https://github.com/Aaron40776/Smart.git $dir
    }
    if ($LASTEXITCODE -ne 0) {
        Say 'Getting the code failed (see above). If you changed files in that folder, commit or undo them first.' Red
        return
    }

    Push-Location $dir
    try {
        # npm.cmd, not npm: the npm.ps1 shim is blocked where scripts are disabled. `ci` installs exactly what
        # package-lock.json says and never rewrites it, so the next update's `git pull` is not blocked.
        foreach ($step in @(@('ci'), @('run', 'build'), @('link'))) {
            Say "npm $($step -join ' ')"
            & npm.cmd @step
            if ($LASTEXITCODE -ne 0) {
                Say "npm $($step -join ' ') failed (see above)." Red
                return
            }
        }
    } finally {
        Pop-Location
    }
    Say 'Done. Open a new terminal and run: smart   (later updates: smart update)' Green
}
