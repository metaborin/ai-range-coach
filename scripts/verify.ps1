$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Path evidence -Force | Out-Null
$results = @()
$commands = @(
  @{ Name = 'typecheck'; Args = @('run', 'typecheck') },
  @{ Name = 'lint'; Args = @('run', 'lint') },
  @{ Name = 'unit'; Args = @('run', 'test') },
  @{ Name = 'build'; Args = @('run', 'build') },
  @{ Name = 'dist'; Args = @('run', 'verify:dist') },
  @{ Name = 'e2e'; Args = @('run', 'test:e2e') }
)
foreach ($check in $commands) {
  $started = Get-Date -Format o
  $log = Join-Path 'evidence' ($check.Name + '.log')
  $arguments = $check.Args
  & npm.cmd @arguments 2>&1 | Tee-Object -FilePath $log
  $code = $LASTEXITCODE
  $results += [pscustomobject]@{ name = $check.Name; command = ('npm ' + ($arguments -join ' ')); cwd = (Get-Location).Path; started = $started; ended = (Get-Date -Format o); exitCode = $code; log = $log }
  $results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath evidence/commands.json
  if ($code -ne 0) { Write-Output "Failed: $($check.Name) (exit $code). See $log"; exit $code }
}
Write-Output 'All verification commands completed.'
