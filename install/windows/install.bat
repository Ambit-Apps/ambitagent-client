@echo off
setlocal enableextensions
REM ============================================================================
REM  Ambit Agent - Windows one-click installer wrapper
REM
REM  Why this exists: install.ps1 otherwise requires the customer to do two
REM  manual PowerShell things by hand -
REM     1. run an ELEVATED (Administrator) PowerShell, and
REM     2. get past the execution policy / "script from the internet" block
REM        (Unblock-File / -ExecutionPolicy Bypass).
REM
REM  .bat/.cmd files are NOT subject to PowerShell's execution policy, so this
REM  wrapper can self-elevate, strip the Mark-of-the-Web from the shipped .ps1
REM  + .zip, and launch install.ps1 with the policy bypassed. The customer's
REM  whole job becomes: double-click this file, click "Yes" on the UAC prompt,
REM  answer the same 3 prompts.
REM
REM  Ship this alongside install.ps1, run-daemon.ps1, and the
REM  ambitagent-client-*.zip - all four saved into the SAME folder.
REM ============================================================================

REM --- Already elevated? "net session" only succeeds with admin rights. -------
net session >nul 2>&1
if %errorlevel% EQU 0 goto :elevated

REM --- Not elevated: unblock self first (avoids a duplicate "from the internet"
REM     warning on the relaunch), then re-launch this same .bat through a UAC
REM     prompt. Unblock-File needs no admin rights. -----------------------------
echo Requesting administrator access (a Windows prompt will appear)...
powershell -NoProfile -Command "Unblock-File -LiteralPath '%~f0'" >nul 2>&1
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b

:elevated
REM --- An elevated relaunch starts in C:\Windows\System32; move to THIS file's
REM     folder so the sibling install.ps1 + .zip resolve correctly. -----------
cd /d "%~dp0"

if not exist "%~dp0install.ps1" (
    echo.
    echo ERROR: install.ps1 was not found next to this file.
    echo Make sure install.bat, install.ps1, run-daemon.ps1, and the
    echo ambitagent-client-*.zip are all saved into the SAME folder, then
    echo double-click install.bat again.
    echo.
    pause
    exit /b 1
)

echo Preparing installer ^(clearing "downloaded from the internet" blocks^)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path '%~dp0*' -Include *.ps1,*.zip -ErrorAction SilentlyContinue | Unblock-File"

echo Launching the Ambit Agent installer...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "PS_EXIT=%errorlevel%"

echo.
if "%PS_EXIT%"=="0" (
    echo Installer finished. You can close this window.
) else (
    echo Installer exited with code %PS_EXIT%. Review the messages above,
    echo then re-run install.bat once the issue is resolved.
)
echo.
pause
exit /b %PS_EXIT%
