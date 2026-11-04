#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$DataDir,
  [string]$Account,
  [string]$PythonCommand
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $PSScriptRoot 'wechat-key.py'

try {
  Write-Host 'CHAOS 微信数据库密钥初始化' -ForegroundColor Cyan
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw '缺少 scripts\wechat-key.py，请使用完整项目或发布包。'
  }

  if (-not $DataDir) {
    $candidates = @(@(
      (Join-Path $env:USERPROFILE 'Documents\xwechat_files'),
      (Join-Path $env:USERPROFILE 'xwechat_files'),
      (Join-Path $env:APPDATA 'Tencent\WeChat\xwechat_files'),
      'D:\xwechat_files'
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -Unique)
    if ($candidates.Count -eq 1) {
      $DataDir = $candidates[0]
      Write-Host "已找到微信数据目录：$DataDir"
    } else {
      if ($candidates.Count -gt 1) {
        Write-Host '发现多个可能的微信数据目录：'
        for ($i = 0; $i -lt $candidates.Count; $i++) {
          Write-Host "  $($i + 1). $($candidates[$i])"
        }
      }
      $answer = (Read-Host '请输入微信 xwechat_files 或账号目录（也可输入上面的序号）').Trim().Trim('"')
      if ($answer -match '^\d+$' -and [int]$answer -ge 1 -and [int]$answer -le $candidates.Count) {
        $DataDir = $candidates[[int]$answer - 1]
      } else {
        $DataDir = $answer
      }
    }
  }
  if (-not $DataDir -or -not (Test-Path -LiteralPath $DataDir -PathType Container)) {
    throw '微信数据目录不存在。可用 -DataDir 指定 xwechat_files、账号目录或 db_storage。'
  }
  $DataDir = (Resolve-Path -LiteralPath $DataDir).Path

  if (-not $Account -and -not (Test-Path -LiteralPath (Join-Path $DataDir 'db_storage') -PathType Container) -and
      (Split-Path -Leaf $DataDir) -ne 'db_storage') {
    $accounts = @(Get-ChildItem -LiteralPath $DataDir -Directory -Filter 'wxid_*' -ErrorAction SilentlyContinue |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'db_storage') -PathType Container })
    if ($accounts.Count -gt 1) {
      Write-Host '发现多个微信账号：'
      for ($i = 0; $i -lt $accounts.Count; $i++) {
        Write-Host "  $($i + 1). $($accounts[$i].Name)"
      }
      $answer = (Read-Host '请输入当前登录账号的序号').Trim()
      if ($answer -notmatch '^\d+$' -or [int]$answer -lt 1 -or [int]$answer -gt $accounts.Count) {
        throw '未选择有效的微信账号。'
      }
      $Account = $accounts[[int]$answer - 1].Name
    }
  }

  $python = $null
  $prefix = @()
  if ($PythonCommand) {
    $command = Get-Command $PythonCommand -ErrorAction SilentlyContinue
    if (-not $command) { throw "找不到指定的 Python：$PythonCommand" }
    $python = $command.Source
  } else {
    foreach ($candidate in @(
      (Join-Path $root 'runtime\python\python.exe'),
      (Join-Path $root '.desktop\runtime\python\python.exe')
    )) {
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $python = $candidate; break }
    }
    if (-not $python) {
      $command = Get-Command python -ErrorAction SilentlyContinue
      if ($command) { $python = $command.Source }
    }
    if (-not $python) {
      $command = Get-Command py -ErrorAction SilentlyContinue
      if ($command) { $python = $command.Source; $prefix = @('-3') }
    }
  }
  if (-not $python) { throw '未找到 Python 3.10 或更新版本。' }

  Write-Host "微信数据目录：$DataDir"
  if ($Account) { Write-Host "微信账号目录：$Account" }
  Write-Host '正在从已登录微信验证数据库密钥，成功后保存到当前 Windows 用户的 CHAOS 配置目录。'
  $arguments = @($prefix) + @('-X', 'utf8', $helper, '--data-dir', $DataDir, '--save')
  if ($Account) { $arguments += @('--account', $Account) }
  & $python @arguments
  if ($LASTEXITCODE -ne 0) { throw "微信密钥验证失败（退出码 $LASTEXITCODE）。" }
  Write-Host '微信数据库密钥初始化完成。' -ForegroundColor Green
  exit 0
} catch {
  Write-Host "初始化失败：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
