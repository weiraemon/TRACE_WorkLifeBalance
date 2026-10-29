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
  [string]$QqKey,
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
$Probe = Join-Path $RepoRoot 'scripts\qq_probe.py'
$ProfilePath = if ($env:CHAOS_CACHE_DIR) {
  Join-Path $env:CHAOS_CACHE_DIR 'qq-profile.json'
} else {
  Join-Path $env:LOCALAPPDATA 'CHAOS\qq-cache\qq-profile.json'
}
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

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  try {
    # Windows PowerShell 5 turns native stderr into a terminating error when
    # ErrorActionPreference is Stop. Expected non-zero exits are checked below.
    $ErrorActionPreference = 'Continue'
    & $FilePath @Arguments
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Invoke-Python([hashtable]$Python, [string[]]$Arguments) {
  $all = @()
  $all += @($Python.Prefix)
  $all += @($Arguments)
  Invoke-Native $Python.Exe $all
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
  Invoke-Native $winget @(
    'install', '--id', 'Python.Python.3.12', '-e', '--source', 'winget',
    '--accept-package-agreements', '--accept-source-agreements'
  )
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

function Find-QqDataCandidates([string]$Seed) {
  $roots = @(
    (Join-Path $env:USERPROFILE 'Documents\Tencent Files'),
    (Join-Path $env:USERPROFILE 'Documents\Tencent Files\Tencent Files'),
    'D:\qq_files\Tencent_Files\Tencent Files',
    'D:\qq_files\Tencent Files'
  )
  if ($Seed) {
    $current = $Seed
    for ($i = 0; $i -lt 3; $i++) {
      $current = Split-Path -Parent $current
      if (-not $current) { break }
      if ((Split-Path -Leaf $current) -eq 'Tencent Files') {
        $roots += $current
        break
      }
    }
  }
  foreach ($drive in @(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
    $candidate = Join-Path $drive.Root 'SoftwareData\QQ\Tencent Files'
    if (Test-Path -LiteralPath $candidate) { $roots += $candidate }
  }
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
  $cacheDir = Join-Path $env:LOCALAPPDATA 'CHAOS\setup'
  $cached = Join-Path $cacheDir 'windows_ntqq_get_key.ps1'
  if (Test-Path -LiteralPath $cached) {
    if ((Get-FileHash -LiteralPath $cached -Algorithm SHA256).Hash -eq $ExtractorSha256) {
      Write-Ok '使用已缓存的密钥提取脚本'
      return $cached
    }
    Remove-Item -LiteralPath $cached -Force -ErrorAction SilentlyContinue
  }
  Write-Step '下载 QQ 密钥提取脚本'
  Write-Host '来源：https://github.com/QQBackup/qq-win-db-key'
  Write-Host '该步骤会启动 QQ 调试器，可能会触发安全软件提示。'
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  } catch {
  }
  $relative = 'scripts/windows/ntqq/windows_ntqq_get_key.ps1'
  $commit = 'b402e50133550efdff704e5a9921efbea5152bc1'
  $sources = @(
    "https://raw.githubusercontent.com/QQBackup/qq-win-db-key/$commit/$relative",
    "https://cdn.jsdelivr.net/gh/QQBackup/qq-win-db-key@$commit/$relative",
    "https://fastly.jsdelivr.net/gh/QQBackup/qq-win-db-key@$commit/$relative",
    "https://ghproxy.net/https://raw.githubusercontent.com/QQBackup/qq-win-db-key/$commit/$relative",
    "https://raw.gitmirror.com/QQBackup/qq-win-db-key/$commit/$relative"
  )
  foreach ($source in $sources) {
    try {
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
      Invoke-WebRequest -Uri $source -OutFile $target -UseBasicParsing -TimeoutSec 30 `
        -Headers @{ 'User-Agent' = 'CHAOS-QQ-Setup' }
      $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
      if ($hash -eq $ExtractorSha256) {
        Write-Ok '密钥提取脚本下载成功并通过校验'
        try {
          New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
          Copy-Item -LiteralPath $target -Destination $cached -Force
          return $cached
        } catch {
          return $target
        }
      }
      Write-Warn "下载内容校验失败，尝试下一个镜像：$source"
    } catch {
      Write-Warn "下载失败，尝试下一个镜像：$($_.Exception.Message)"
    }
  }
  throw '无法下载密钥提取脚本（网络或镜像不可用）。请从 https://github.com/QQBackup/qq-win-db-key 手动下载 windows_ntqq_get_key.ps1，然后运行：.\scripts\setup-qq.ps1 -QqKeyExtractorPath "路径\windows_ntqq_get_key.ps1"'
}

function New-KeyCollector([string]$Extractor, [string]$KeyFile) {
  $text = [IO.File]::ReadAllText($Extractor, [Text.Encoding]::UTF8)
  $pattern = '(?s)if \(isValidKey\)\s*\{\s*_log\(""\);\s*_log\("=+"\);\s*_log\("找到密钥: " \+ keyString\);\s*_log\("=+"\);\s*return keyString;\s*\}'
  if (([regex]::Matches($text, $pattern)).Count -ne 1) { return $null }
  $lengthPattern = 'bool isValidKey = keyString.Length == 16;'
  if (([regex]::Matches($text, $lengthPattern)).Count -ne 1) { return $null }
  $escapedKeyFile = $KeyFile.Replace('"', '""')
  $replacement = @"
if (isValidKey)
                {
                    _log("CHAOS_KEY_FOUND");
                    try { System.IO.File.AppendAllText(@"$escapedKeyFile", keyString + "\n"); } catch { }
                    SetSingleStep(hThread, ref ctx, threadId);
                    return null;
                }
"@
  $patched = [regex]::Replace($text, $pattern, $replacement)
  $patched = [regex]::Replace(
    $patched,
    $lengthPattern,
    'bool isValidKey = keyString.Length >= 8 && keyString.Length <= 64;'
  )
  $path = Join-Path $WorkDir 'windows_ntqq_get_key_all.ps1'
  [IO.File]::WriteAllText($path, $patched, (New-Object Text.UTF8Encoding($true)))
  return $path
}

function Extract-QQKeys([string]$Extractor) {
  $keyFile = Join-Path $WorkDir 'keys.txt'
  $collector = New-KeyCollector $Extractor $keyFile
  if (-not $collector) {
    Write-Warn '提取脚本结构不符合预期，回退为单密钥模式。'
    return @(Extract-QQKey $Extractor)
  }
  Write-Step '提取 QQ 数据库密钥'
  Write-Host 'QQ 将以调试模式启动，请在弹出的 QQ 登录窗口登录目标账号。' -ForegroundColor Yellow
  if ($SelfQQ) { Write-Host "请确认登录的 QQ 号是 $SelfQQ，而不是其他账号。" -ForegroundColor Yellow }
  Write-Host '脚本会收集登录过程中出现的所有候选密钥，再逐个验证。'
  Close-QQ

  $stdout = Join-Path $WorkDir 'key-extractor.out'
  $stderr = Join-Path $WorkDir 'key-extractor.err'
  $escaped = $collector.Replace("'", "''")
  $command = "& '$escaped'"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $process = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -NoNewWindow -PassThru

  $deadline = (Get-Date).AddSeconds(180)
  $firstKeyAt = $null
  $lastCount = 0
  try {
    while ((Get-Date) -lt $deadline) {
      if (Test-Path -LiteralPath $keyFile) {
        $keys = @(Get-Content -LiteralPath $keyFile -ErrorAction SilentlyContinue |
          ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[\x20-\x7E]{8,64}$' } |
          Select-Object -Unique)
        if ($keys.Count -gt 0) {
          if (-not $firstKeyAt) { $firstKeyAt = Get-Date }
          if ($keys.Count -ne $lastCount) {
            $lastCount = $keys.Count
            Write-Host "已收集 $lastCount 个候选密钥，继续等待其他数据库打开..."
          }
          if (((Get-Date) - $firstKeyAt).TotalSeconds -ge 30) { break }
        }
      }
      if ($process.HasExited) { break }
      Start-Sleep -Milliseconds 500
    }
  } finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    Get-Process -Name 'QQ' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }

  if (-not (Test-Path -LiteralPath $keyFile)) {
    throw '未捕获到任何候选密钥。请确认 QQ 已登录，且调试器没有被安全软件拦截。'
  }
  $keys = @(Get-Content -LiteralPath $keyFile -ErrorAction SilentlyContinue |
    ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[\x20-\x7E]{8,64}$' } |
    Select-Object -Unique)
  if ($keys.Count -eq 0) { throw '未捕获到有效的候选密钥。' }
  Write-Ok "已捕获 $($keys.Count) 个候选密钥，开始逐个验证"
  return $keys
}

function Extract-QQKey([string]$Extractor) {
  Write-Step '提取 QQ 数据库密钥'
  Write-Host 'QQ 将以调试模式启动，请在弹出的 QQ 登录窗口登录目标账号。' -ForegroundColor Yellow
  if ($SelfQQ) { Write-Host "请确认登录的 QQ 号是 $SelfQQ，而不是其他账号。" -ForegroundColor Yellow }
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

function Test-QQDatabase([hashtable]$Python, [string]$Key, [string]$DbDir, [switch]$Quiet, [string]$ProfilePath) {
  if (-not $Quiet) { Write-Step '验证 QQ 数据库' }
  if (-not (Test-Path -LiteralPath $DbDir)) { throw "QQ 数据目录不存在：$DbDir" }
  $oldKey = $env:QQ_DB_KEY
  $oldProfile = $env:QQ_DB_PROFILE
  try {
    $env:QQ_DB_KEY = $Key
    if ($ProfilePath) { $env:QQ_DB_PROFILE = $ProfilePath }
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
    if ($null -eq $oldProfile) { Remove-Item Env:QQ_DB_PROFILE -ErrorAction SilentlyContinue }
    else { $env:QQ_DB_PROFILE = $oldProfile }
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
        Invoke-Native $winget @(
          'install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--source', 'winget',
          '--accept-package-agreements', '--accept-source-agreements'
        )
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
    try { Invoke-Native $npm @('ci') } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败。' }
  }

  Write-Step '定位 QQ 数据目录'
  $candidateDirs = @()
  if ($DataDir) {
    $resolved = Find-QqDataDir $DataDir
    if ($resolved) { $candidateDirs += $resolved }
  }
  $discovered = @(Find-QqDataCandidates $DataDir)
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
  if ($QqKey) {
    Write-Step '验证手动提供的 QQ 密钥'
    if ($QqKey -notmatch '^[\x20-\x7E]{8,64}$') {
      throw '手动提供的密钥必须是 8–64 位可打印 ASCII 字符。'
    }
    $key = $QqKey.Trim()
    $usable = Find-UsableDataDir $pythonInfo.Python $key $candidateDirs
    if (-not $usable) {
      throw "手动提供的密钥无法读取已尝试的账号目录。请确认账号和 -DataDir 是否正确。"
    }
    $data = $usable
    Write-Ok '手动提供的密钥验证通过'
    Test-QQDatabase $pythonInfo.Python $key $data | Out-Null
  } elseif (-not $SkipKey -and -not $ForceKey -and $existingConfig -and $existingConfig.key) {
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
    $candidateKeys = @(Extract-QQKeys $extractor)
    $didExtract = $true
    foreach ($candidateKey in $candidateKeys) {
      $usable = Find-UsableDataDir $pythonInfo.Python $candidateKey $candidateDirs
      if ($usable) {
        $key = $candidateKey
        $data = $usable
        Write-Ok '已找到能解密 nt_msg.db 的密钥'
        break
      }
    }
    if (-not $key -and $existingConfig -and $existingConfig.key) {
      Write-Warn '候选密钥都验证失败，尝试已保存的密钥。'
      $usable = Find-UsableDataDir $pythonInfo.Python ([string]$existingConfig.key) $candidateDirs
      if ($usable) {
        $key = [string]$existingConfig.key
        $data = $usable
      }
    }
    if (-not $key) {
      Write-Step '探测数据库加密参数'
      if (-not (Test-Path -LiteralPath $Probe -PathType Leaf)) {
        throw '缺少 scripts\qq_probe.py。请同步完整项目脚本后重试；尚未进行加密参数探测。'
      }
      $keysPath = Join-Path $WorkDir 'candidate-keys.txt'
      [IO.File]::WriteAllLines($keysPath, [string[]]$candidateKeys, (New-Object Text.UTF8Encoding($false)))
      New-Item -ItemType Directory -Path (Split-Path -Parent $ProfilePath) -Force | Out-Null
      $probeOutput = Invoke-Python $pythonInfo.Python @(
        $Probe, '--db-dir', $data, '--keys-file', $keysPath, '--profile-out', $ProfilePath
      ) 2>&1
      $probeExitCode = $LASTEXITCODE
      $probeText = ($probeOutput -join "`n").Trim()
      $probeResult = $null
      if ($probeText -match '(?s)(\{.*\})') {
        try { $probeResult = $Matches[1] | ConvertFrom-Json } catch { $probeResult = $null }
      }
      if (-not $probeResult -or -not ($probeResult.PSObject.Properties.Name -contains 'ok')) {
        throw "加密参数探测程序未返回有效结果（退出码 $probeExitCode）。请检查 qq_probe.py 是否完整，以及它与 setup-qq.ps1 是否来自同一版本；这不是密钥验证失败的证据。"
      }
      if ($probeResult.ok -and $probeExitCode -ne 0) {
        throw "加密参数探测程序异常退出（退出码 $probeExitCode），未采用结果。"
      }
      if ($probeResult.ok) {
        $index = [int]$probeResult.keyIndex
        if ($index -ge 0 -and $index -lt $candidateKeys.Count) {
          $candidateKey = $candidateKeys[$index]
          try {
            Test-QQDatabase $pythonInfo.Python $candidateKey $data -ProfilePath $ProfilePath | Out-Null
            $key = $candidateKey
            Write-Ok ("已识别数据库参数：头 {0} 字节，页 {1}，KDF {2}，{3}" -f `
              $probeResult.headerSize, $probeResult.pageSize, $probeResult.kdfIter, $probeResult.hmac)
          } catch {
            Remove-Item -LiteralPath $ProfilePath -Force -ErrorAction SilentlyContinue
            Write-Warn "参数探测结果验证失败：$($_.Exception.Message)"
          }
        }
      } else {
        if (-not ($probeResult.PSObject.Properties.Name -contains 'keys')) {
          throw "加密参数探测未完成（退出码 $probeExitCode），请检查数据库路径、文件访问权限及候选密钥文件；尚不能判定密钥错误。"
        }
        Write-Warn '常见 SQLCipher 参数组合也无法解密，可能是密钥归属或数据库结构问题。'
      }
    }
    if (-not $key) {
      $tried = ($candidateDirs | ForEach-Object {
        $db = Join-Path $_ 'nt_msg.db'
        if (Test-Path -LiteralPath $db) {
          $item = Get-Item -LiteralPath $db
          "  - $_（$($item.Length) 字节，修改于 $($item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))）"
        } else {
          "  - $_（没有 nt_msg.db）"
        }
      }) -join "`n"
      throw "数据库验证失败：已尝试 $($candidateKeys.Count) 个候选密钥和以下账号目录，都无法解密。`n已尝试：`n$tried`n请确认 QQ 当前登录的是 $SelfQQ，并用 -DataDir 指向该账号的 nt_qq 或 nt_db。"
    }
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
