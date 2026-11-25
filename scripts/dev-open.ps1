#Requires -Version 5.1
<#
.SYNOPSIS
  启动前后端服务，等 Web 端口就绪后用默认浏览器打开控制台。
.DESCRIPTION
  端口遵循 PRINT_WEB_PORT / PRINT_PORT，与 npm 脚本保持一致。
  按 Ctrl+C 停止服务，脚本退出时会清理自己启动的进程树。
.PARAMETER Prod
  先执行构建，再以生产模式在同一端口启动并打开页面。
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\dev-open.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\dev-open.ps1 -Prod
#>
[CmdletBinding()]
param(
  [switch]$Prod
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw '找不到 node，请先安装 Node.js 24.13 或更高版本。'
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npm) {
  $npm = Get-Command npm -ErrorAction SilentlyContinue
}
if ($null -eq $npm) {
  throw '找不到 npm。'
}

if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
  throw '依赖尚未安装，请先在仓库根目录运行 npm ci。'
}

if ($Prod) {
  $mode = '生产模式'
  $port = if ($env:PRINT_PORT) { $env:PRINT_PORT } else { '8758' }
} else {
  $mode = '开发模式'
  $port = if ($env:PRINT_WEB_PORT) { $env:PRINT_WEB_PORT } else { '5173' }
}

$portNumber = 0
if (-not [int]::TryParse([string]$port, [ref]$portNumber)) {
  throw "Web 端口无效：$port"
}
if ($portNumber -lt 1 -or $portNumber -gt 65535) {
  throw "Web 端口无效：$port"
}

$url = "http://127.0.0.1:$portNumber"
if ($Prod) {
  $probe = "$url/"
} else {
  # 用 Vite 自带入口判断，避免把占用同一端口的其他开发服务器当成我们的页面。
  $probe = "$url/@vite/client"
}

function Test-Url {
  param([string]$Address)
  try {
    $response = Invoke-WebRequest -Uri $Address -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

$npmPath = $npm.Source

if ($Prod) {
  Write-Host '[dev-open] 生产模式：构建中 ...'
  & $npmPath run build
  if ($LASTEXITCODE -ne 0) {
    throw '构建失败，已停止。'
  }
}

# npm 在 Windows 上是 npm.cmd。Start-Process -NoNewWindow 会把 .cmd 当可执行文件直接
# CreateProcess，因而失败；交给 cmd.exe 解释，同时保留同一控制台里的日志和 Ctrl+C。
$command = if ($Prod) { 'npm start' } else { 'npm run dev' }
$server = Start-Process -FilePath 'cmd.exe' -ArgumentList "/d /c $command" -NoNewWindow -PassThru -WorkingDirectory $root

$ready = $false

try {
  Write-Host "[dev-open] $mode，等待 $url 就绪 ..."
  for ($i = 0; $i -lt 240; $i++) {
    if ($server.HasExited) { break }
    if (Test-Url -Address $probe) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }

  if ($ready) {
    Write-Host "[dev-open] 已就绪，用默认浏览器打开 $url"
    Start-Process -FilePath $url
    Write-Host '[dev-open] 按 Ctrl+C 停止服务。'
    $server.WaitForExit()
  } elseif ($server.HasExited) {
    Write-Warning "服务已退出（退出码 $($server.ExitCode)），未打开页面。请检查上面的日志。"
  } else {
    Write-Warning "等待超时（120 秒）：$url 仍未响应，已停止服务。"
  }
} finally {
  if (-not $server.HasExited) {
    & taskkill.exe /PID $server.Id /T /F *> $null
  }
}

$exitCode = 0
if ($server.HasExited) {
  $exitCode = $server.ExitCode
}
if (-not $ready -and $exitCode -eq 0) {
  $exitCode = 1
}
exit $exitCode
