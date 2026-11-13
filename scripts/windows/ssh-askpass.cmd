@echo off
rem WINDOWS-ARM64-PORT — OpenSSH SSH_ASKPASS helper (password auth without sshpass).
rem OpenSSH calls this program with a prompt argument; the password is supplied
rem by sparkDash through the child process environment, never on a command line.
setlocal
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0ssh-askpass.ps1"
exit /b 0
