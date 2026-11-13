# WINDOWS-ARM64-PORT — SSH_ASKPASS helper used by server/collectors/ssh.js.
# Print the password on stdout without exposing it in argv or in a file.
# OpenSSH (SSH_ASKPASS_REQUIRE=force) reads exactly one line from this stream.
$ErrorActionPreference = 'Stop'
$password = [Environment]::GetEnvironmentVariable('SPARKDASH_SSH_PASSWORD')
if ($null -eq $password) { $password = '' }
[Console]::Out.WriteLine($password)
