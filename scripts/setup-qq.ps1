#requires -Version 5.1
<#
SYNOPSIS
  One-time CHAOS QQ setup: install Python sqlcipher3, extract the QQ database key,
  verify the local database, and write the local CHAOS config.

DESCRIPTION
  The script can install Python/Node.js via winget when they are missing.
  The QQ key extraction step launches QQ under a debugger and requires you to log in.
  The key is written to the local CHAOS settings file and is never printed by this script.
#>
[CmdletBinding()]
param(
  [string]$PythonCommand,
  [string]$DataDir,
  [string]$SelfQQ,
  [string]$QqKeyExtractorPath,
  [switch]$SkipDependencies,
  [switch]$SkipKey,
  [switch]$NoConfigWrite,
  [switch]$ForceKey,
  [switch]$Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Helper = Join-Path $RepoRoot 'scripts\qq_sync.py'
$ExtractorUrl = 'https://raw.githubusercontent.com/QQBackup/qq-win-db-key/b402e50133550efdff704e5a9921efbea5152bc1/scripts/windows/ntqq/windows_ntqq_get_key.ps1'
$ExtractorSha256 = '99306030F51A2264C0EFFDA6D395A969EC1B00CFE1BF262286769FEC0A78474A'
$WorkDir = Join-Path $env:TEMP ('chaos-qq-setup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

function Write-Step([string]$Message) {
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
  Write-Host "[!] $Message" -ForegroundColor Yellow
}

function Ask-Yes([string]$Message) {
  if ($Force) { return $true }
  $answer = Read-Host "$Message [Y/n]"
  return ($answer -eq '' -or $answer -match '^(?i)y')
}

function Find-CommandPath([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Split-PythonCommand([string]$Command) {
  $text = $Command.Trim()
  if (-not $text) { return $null }
  if (Test-Path -LiteralPath $text) {
    return @{ Exe = (Resolve-Path -LiteralPath $text).Path; Prefix = @() }
  }
  $quoted = [regex]::Match($text, '^"([^"]+)"\s*(.*)$')
  if ($quoted.Success) {
    $rest = @($quoted.Groups[2].Value -split '\s+' | Where-Object { $_ })
    return @{ Exe = $quoted.Groups[1].Value; Prefix = $rest }
  }
  $parts = @($text -split '\s+' | Where-Object { $_ })
  if ($parts.Count -eq 0) { return $null }
  return @{ Exe = $parts[0]; Prefix = @($parts | Select-Object -Skip 1) }
}

function Invoke-Python([hashtable]$Python, [string[]]$Arguments) {
  $all = @()
  $all += @($Python.Prefix)
  $all += @($Arguments)
  & $Python.Exe @all
}

function Test-Python([hashtable]$Python) {
  try {
    $version = Invoke-Python $Python @(
      '-c',
      'import sys; print(sys.version_info.major); print(sys.version_info.minor)'
    ) 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    $lines = @($version | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
    if ($lines.Count -lt 2) { return $null }
    $parsed = [version]("$($lines[0]).$($lines[1])")
    if ($parsed -lt [version]'3.10') { return $null }
    return $parsed
  } catch {
    return $null
  }
}

function Find-Python {
  $candidates = @()
  if ($PythonCommand) { $candidates += $PythonCommand }
  $candidates += @(
    'py -3.12',
    'py -3.11',
    'py -3.10',
    'py -3.13',
    'python',
    'python3',
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python310\python.exe')
  )
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    $python = Split-PythonCommand $candidate
    if (-not $python) { continue }
    if (-not (Test-Path -LiteralPath $python.Exe) -and -not (Find-CommandPath $python.Exe)) {
      continue
    }
    $version = Test-Python $python
    if ($version) {
      return @{ Python = $python; Version = $version; Display = $candidate.Trim() }
    }
  }
  return $null
}

function Install-Python {
  if ($SkipDependencies) { return $null }
  $winget = Find-CommandPath 'winget'
  if (-not $winget) {
    Write-Warn '未找到 Python 3.10+，也未找到 winget。请从 https://www.python.org/downloads/ 安装 Python 3.12 后重试。'
    return $null
  }
  if (-not (Ask-Yes '未找到 Python 3.10+，是否用 winget 安装 Python 3.12？')) {
    return $null
  }
  & $winget install --id Python.Python.3.12 -e --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    Write-Warn 'Python 安装失败，请手动安装后重试。'
    return $null
  }
  return Find-Python
}

function Ensure-Sqlcipher([hashtable]$Python) {
  $null = Invoke-Python $Python @('-c', 'import sqlcipher3') 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Ok 'sqlcipher3 已安装'
    return $true
  }
  if ($SkipDependencies) {
    Write-Warn 'sqlcipher3 未安装；已跳过依赖安装。'
    return $false
  }
  Write-Step '安装 sqlcipher3'
  Invoke-Python $Python @('-m', 'pip', 'install', 'sqlcipher3')
  if ($LASTEXITCODE -ne 0) {
    Write-Warn '默认 pip 安装失败，尝试 --user 安装...'
    Invoke-Python $Python @('-m', 'pip', 'install', '--user', 'sqlcipher3')
  }
  $null = Invoke-Python $Python @('-c', 'import sqlcipher3') 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Ok 'sqlcipher3 安装成功'
    return $true
  }
  Write-Warn 'sqlcipher3 安装失败。请确认使用 64 位 Python 3.10+，并检查网络。'
  return $false
}

function Find-QqDataDir([string]$Path) {
  if (-not $Path) { return $null }
  $roots = @(
    $Path,
    (Join-Path $Path 'nt_qq'),
    (Join-Path $Path 'nt_db'),
    (Join-Path $Path 'nt_qq\nt_db')
  )
  foreach ($root in $roots) {
    if (Test-Path -LiteralPath (Join-Path $root 'nt_msg.db')) {
      return (Resolve-Path -LiteralPath $root).Path
    }
  }
  return $null
}

function Find-QqDataCandidates {
  $roots = @(
    (Join-Path $env:USERPROFILE 'Documents\Tencent Files'),
    (Join-Path $env:USERPROFILE 'Documents\Tencent Files\Tencent Files'),
    'D:\qq_files\Tencent_Files\Tencent Files',
    'D:\qq_files\Tencent Files'
  )
  $found = @()
  foreach ($root in ($roots | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $accounts = @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)
    foreach ($account in $accounts) {
      $data = Find-QqDataDir $account.FullName
      if ($data) {
        $db = Join-Path $data 'nt_msg.db'
        $found += [pscustomobject]@{
          DataDir = $data
          AccountDir = $account.FullName
          LastWrite = (Get-Item -LiteralPath $db).LastWriteTime
        }
      }
    }
  }
  return @($found | Sort-Object LastWrite -Descending)
}

function Get-SelfQQFromPath([string]$Path) {
  if (-not $Path) { return '' }
  $segments = @($Path -split '[\\/]')
  foreach ($segment in $segments) {
    if ($segment -match '^\d{5,12}$') { return $segment }
  }
  return ''
}

function Get-ExistingQqConfig {
  $configDir = if ($env:CHAOS_CONFIG_DIR) { $env:CHAOS_CONFIG_DIR } else { Join-Path $env:APPDATA 'CHAOS' }
  $configPath = Join-Path $configDir 'settings.json'
  if (-not (Test-Path -LiteralPath $configPath)) { return $null }
  try {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.PSObject.Properties.Name -contains 'qq') { return $config.qq }
  } catch {
    return $null
  }
  return $null
}

function Close-QQ {
  $processes = @(Get-Process -Name 'QQ' -ErrorAction SilentlyContinue)
  if (-not $processes.Count) { return }
  Write-Warn 'QQ 正在运行，密钥提取需要先关闭 QQ。'
  if (-not (Ask-Yes '现在关闭 QQ 并继续？')) {
    throw '已取消：请先关闭 QQ 后重新运行。'
  }
  $processes | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  if (Get-Process -Name 'QQ' -ErrorAction SilentlyContinue) {
    throw 'QQ 未能关闭，请手动退出 QQ 后重试。'
  }
}

function Get-KeyExtractor {
  if ($QqKeyExtractorPath) {
    if (-not (Test-Path -LiteralPath $QqKeyExtractorPath)) {
      throw "找不到密钥提取脚本：$QqKeyExtractorPath"
    }
    return (Resolve-Path -LiteralPath $QqKeyExtractorPath).Path
  }
  $target = Join-Path $WorkDir 'windows_ntqq_get_key.ps1'
  Write-Step '下载 QQ 密钥提取脚本'
  Write-Host '来源：https://github.com/QQBackup/qq-win-db-key'
  Write-Host '该步骤会启动 QQ 调试器，可能会触发安全软件提示。'
  Invoke-WebRequest -Uri $ExtractorUrl -OutFile $target -UseBasicParsing
  $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
  if ($hash -ne $ExtractorSha256) {
    throw '密钥提取脚本校验失败（上游可能已更新）。请从官方仓库手动下载后使用 -QqKeyExtractorPath 指定。'
  }
  return $target
}

function Extract-QQKey([string]$Extractor) {
  Write-Step '提取 QQ 数据库密钥'
  Write-Host 'QQ 将以调试模式启动，请在弹出的 QQ 登录窗口登录目标账号。' -ForegroundColor Yellow
  Write-Host '本脚本不会显示密钥；登录后会自动继续。'
  Close-QQ

  $stdout = Join-Path $WorkDir 'key-extractor.out'
  $stderr = Join-Path $WorkDir 'key-extractor.err'
  $escaped = $Extractor.Replace("'", "''")
  $command = "& '$escaped' | ConvertTo-Json -Depth 4"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $process = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -NoNewWindow -PassThru -Wait

  $text = ''
  if (Test-Path -LiteralPath $stdout) { $text = Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue }
  $errText = ''
  if (Test-Path -LiteralPath $stderr) { $errText = Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue }

  $key = $null
  if ($text -match '(?s)(\{.*\})') {
    try {
      $object = $Matches[1] | ConvertFrom-Json
      if ($object.PSObject.Properties.Name -contains 'Key' -and $object.Key) {
        $key = [string]$object.Key
      }
    } catch {
      $key = $null
    }
  }
  if (-not $key -and $text -match '"Key"\s*:\s*"([^"]+)"') {
    $key = $Matches[1]
  }
  if (-not $key -and $text -match '(?:加密密钥|密钥|Key)[^\r\n]{0,16}?([\x20-\x7E]{16})') {
    $key = $Matches[1]
  }
  if (-not $key -and $errText -match '(?:加密密钥|密钥|Key)[^\r\n]{0,16}?([\x20-\x7E]{16})') {
    $key = $Matches[1]
  }
  if (-not $key) {
    Write-Warn "密钥提取失败，QQ 进程退出码：$($process.ExitCode)"
    Write-Host '常见原因：QQ 未登录、QQ 版本不兼容、调试器被拦截、脚本被安全软件终止。'
    throw '未获取到 16 位 QQ 数据库密钥。'
  }
  $key = $key.Trim()
  if ($key -notmatch '^[\x20-\x7E]{16}$') { throw '提取到的密钥格式无效。' }
  Write-Ok '已获取 QQ 数据库密钥（未显示）'
  return $key
}

function Test-QQDatabase([hashtable]$Python, [string]$Key, [string]$DbDir, [switch]$Quiet) {
  if (-not $Quiet) { Write-Step '验证 QQ 数据库' }
  if (-not (Test-Path -LiteralPath $DbDir)) { throw "QQ 数据目录不存在：$DbDir" }
  $oldKey = $env:QQ_DB_KEY
  try {
    $env:QQ_DB_KEY = $Key
    $output = Invoke-Python $Python @($Helper, 'test', '--db-dir', $DbDir) 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output -join "`n") }
    $text = ($output -join "`n").Trim()
    if ($text -notmatch '"ok"\s*:\s*true') { throw $text }
    $json = $text | ConvertFrom-Json
    if (-not $Quiet) {
      Write-Ok ("数据库可读：群消息 {0} 条，私聊 {1} 条" -f $json.groupMessages, $json.privateMessages)
    }
    return $true
  } finally {
    if ($null -eq $oldKey) { Remove-Item Env:QQ_DB_KEY -ErrorAction SilentlyContinue }
    else { $env:QQ_DB_KEY = $oldKey }
  }
}

function Find-UsableDataDir([hashtable]$Python, [string]$Key, [string[]]$Dirs) {
  foreach ($dir in ($Dirs | Select-Object -Unique)) {
    if (-not $dir) { continue }
    try {
      Test-QQDatabase $Python $Key $dir -Quiet | Out-Null
      return $dir
    } catch {
      continue
    }
  }
  return $null
}

function Write-ChaosConfig([string]$Key, [string]$DbDir, [string]$PythonDisplay, [string]$QqNumber) {
  Write-Step '写入 CHAOS 本机配置'
  $configDir = if ($env:CHAOS_CONFIG_DIR) { $env:CHAOS_CONFIG_DIR } else { Join-Path $env:APPDATA 'CHAOS' }
  $configPath = Join-Path $configDir 'settings.json'
  New-Item -ItemType Directory -Path $configDir -Force | Out-Null

  $config = $null
  if (Test-Path -LiteralPath $configPath) {
    try { $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json } catch { $config = $null }
  }
  if (-not $config) { $config = [pscustomobject]@{} }
  $config | Add-Member -NotePropertyName version -NotePropertyValue 2 -Force
  $qq = [pscustomobject]@{
    enabled = $false
    dataDir = $DbDir
    python = $PythonDisplay
    intervalSeconds = 30
    backfillDays = 7
    selfQQ = $QqNumber
    key = $Key
  }
  $config | Add-Member -NotePropertyName qq -NotePropertyValue $qq -Force

  $json = $config | ConvertTo-Json -Depth 10
  $temp = Join-Path $configDir ('settings.json.' + $PID + '.tmp')
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($temp, $json, $utf8)
  Move-Item -LiteralPath $temp -Destination $configPath -Force
  Write-Ok "配置已写入：$configPath"
  return $configPath
}

try {
  Write-Host 'CHAOS QQ 初始化' -ForegroundColor Cyan
  Write-Host '此脚本会关闭 QQ 并以调试模式重新启动，用于一次性提取数据库密钥。'
  Write-Host '建议先关闭正在运行的 CHAOS，避免配置写入冲突。'
  if (-not (Ask-Yes '继续？')) { throw '已取消。' }

  Write-Step '检查运行环境'
  $node = Find-CommandPath 'node'
  $npm = Find-CommandPath 'npm.cmd'
  if (-not $node -or -not $npm) {
    if ($SkipDependencies) {
      Write-Warn '未找到 Node.js/npm；已跳过安装，但 CHAOS 需要 Node.js 22.12+。'
    } else {
      $winget = Find-CommandPath 'winget'
      if ($winget -and (Ask-Yes '未找到 Node.js，是否用 winget 安装 LTS 版本？')) {
        & $winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
      }
      $node = Find-CommandPath 'node'
      $npm = Find-CommandPath 'npm.cmd'
    }
  }
  if ($node -and $npm) {
    $nodeVersion = (& $node --version).TrimStart('v')
    if ([version]$nodeVersion -lt [version]'22.12') {
      Write-Warn "Node.js $nodeVersion 低于 22.12，CHAOS 可能无法启动。"
    } else {
      Write-Ok "Node.js $nodeVersion"
    }
  }

  $pythonInfo = Find-Python
  if (-not $pythonInfo) { $pythonInfo = Install-Python }
  if (-not $pythonInfo) { throw '未找到可用的 Python 3.10+。' }
  Write-Ok ("Python {0}（{1}）" -f $pythonInfo.Version, $pythonInfo.Display)
  if (-not (Ensure-Sqlcipher $pythonInfo.Python)) { throw 'sqlcipher3 未就绪，无法读取 QQ 数据库。' }

  if (-not $SkipDependencies -and -not (Test-Path -LiteralPath (Join-Path $RepoRoot 'node_modules\.bin\tsx.cmd'))) {
    Write-Step '安装 CHAOS 项目依赖'
    Push-Location $RepoRoot
    try { & $npm ci } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败。' }
  }

  Write-Step '定位 QQ 数据目录'
  $candidateDirs = @()
  if ($DataDir) {
    $resolved = Find-QqDataDir $DataDir
    if ($resolved) { $candidateDirs += $resolved }
  }
  $discovered = @(Find-QqDataCandidates)
  $candidateDirs += @($discovered | ForEach-Object { $_.DataDir })
  $candidateDirs = @($candidateDirs | Select-Object -Unique)

  if (-not $SelfQQ) { $SelfQQ = Get-SelfQQFromPath ($candidateDirs | Select-Object -First 1) }
  if (-not $SelfQQ -and -not $Force) { $SelfQQ = (Read-Host '请输入本人 QQ 号（可留空）').Trim() }
  if (-not $SelfQQ) { throw '未设置本人 QQ 号；请用 -SelfQQ 指定。' }

  $preferred = @($candidateDirs | Where-Object { $_ -match "\\$([regex]::Escape($SelfQQ))\\" })
  if ($preferred.Count -gt 0) { $candidateDirs = @(@($preferred + $candidateDirs) | Select-Object -Unique) }
  $data = $candidateDirs | Select-Object -First 1
  if (-not $data) { throw '找不到 nt_msg.db，请用 -DataDir 指定 QQ 账号目录。' }
  Write-Ok "QQ 数据目录：$data"
  Write-Ok "本人 QQ：$SelfQQ"

  $existingConfig = Get-ExistingQqConfig
  $key = $null
  $didExtract = $false
  if (-not $SkipKey -and -not $ForceKey -and $existingConfig -and $existingConfig.key) {
    Write-Step '检查已保存的 QQ 密钥'
    $existingDirs = @($existingConfig.dataDir) + $candidateDirs
    $usable = Find-UsableDataDir $pythonInfo.Python ([string]$existingConfig.key) $existingDirs
    if ($usable) {
      $key = [string]$existingConfig.key
      $data = $usable
      Write-Ok '已保存的密钥仍然有效，跳过密钥提取'
    } else {
      Write-Warn '已保存的密钥无法读取当前数据库，将重新提取。'
    }
  }

  if (-not $key -and -not $SkipKey) {
    $extractor = Get-KeyExtractor
    $key = Extract-QQKey $extractor
    $didExtract = $true
    $usable = Find-UsableDataDir $pythonInfo.Python $key $candidateDirs
    if (-not $usable -and $existingConfig -and $existingConfig.key) {
      Write-Warn '新提取的密钥验证失败，尝试已保存的密钥。'
      $usable = Find-UsableDataDir $pythonInfo.Python ([string]$existingConfig.key) $candidateDirs
      if ($usable) { $key = [string]$existingConfig.key }
    }
    if (-not $usable) {
      throw '数据库验证失败：密钥与所选账号目录不匹配。请确认登录的是目标 QQ 账号，并用 -DataDir 指定该账号的 nt_qq/nt_db。'
    }
    $data = $usable
    Test-QQDatabase $pythonInfo.Python $key $data | Out-Null
  } elseif (-not $key) {
    Write-Warn '已跳过密钥提取和数据库验证。'
  }

  if (-not $NoConfigWrite) {
    if (-not $key) { Write-Warn '没有密钥，未写入配置。' }
    else { Write-ChaosConfig $key $data $pythonInfo.Display $SelfQQ | Out-Null }
  } else {
    Write-Warn '按 -NoConfigWrite 要求，未写入配置。'
  }

  Write-Host ''
  Write-Host '初始化完成。' -ForegroundColor Green
  if ($key) {
    Write-Host '下一步：双击 start-chaos.cmd，打开“QQ同步设置”，测试读取并启用自动同步。'
    if ($didExtract) { Write-Host 'QQ 已被提取流程关闭，请重新打开 QQ 并保持登录。' }
  } else {
    Write-Host '下一步：重新运行本脚本并完成 QQ 登录，或在“QQ同步设置”中手动填写密钥。'
  }
} catch {
  Write-Host ''
  Write-Host ("初始化失败：" + $_.Exception.Message) -ForegroundColor Red
  exit 1
} finally {
  Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
}
