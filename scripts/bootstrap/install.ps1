# 西浦课程助手 · 一行安装（Windows PowerShell）
#   irm https://shanyuzhang.github.io/xjtlu-core-mcp/install.ps1 | iex
# 没有 Node.js 20+ 时，下载官方 Node.js 到 %USERPROFILE%\.xjtlu-session-mcp\node（不需要管理员权限），
# 然后下载工具包、安装依赖、打开学校登录窗口并连接 AI 应用。
# 通过 iex 运行在用户自己的窗口里，所以出错时只抛出提示，不调用 exit（否则会关掉窗口）。
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

  $NodeVersion = 'v24.21.0'
  $Site = if ($env:XJTLU_INSTALL_BASE) { $env:XJTLU_INSTALL_BASE } else { 'https://shanyuzhang.github.io/xjtlu-core-mcp' }
  $RepoZip = 'https://github.com/shanyuzhang/xjtlu-core-mcp/archive/refs/heads/main.zip'
  $NodeMirrors = @('https://nodejs.org/dist', 'https://cdn.npmmirror.com/binaries/node')
  $AppHome = if ($env:XJTLU_MCP_HOME) { $env:XJTLU_MCP_HOME } else { Join-Path $HOME '.xjtlu-session-mcp' }

  function Get-File($Url, $OutFile) {
    try { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile -TimeoutSec 300; return $true } catch { return $false }
  }
  function Test-Node($Exe) {
    if (-not $Exe -or -not (Test-Path $Exe)) { return $false }
    try { return [int](& $Exe -p 'process.versions.node.split(".")[0]') -ge 20 } catch { return $false }
  }

  Write-Host '西浦课程助手 · 正在安装'
  Write-Host ''
  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ('xjtlu-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $Tmp | Out-Null
  try {
    $Node = $null
    $OnPath = (Get-Command node -ErrorAction SilentlyContinue).Source
    $Private = Join-Path $AppHome 'node'
    if (Test-Node $OnPath) { $Node = $OnPath }
    elseif (Test-Node (Join-Path $Private 'node.exe')) { $Node = Join-Path $Private 'node.exe' }
    else {
      $Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
      $Name = "node-$NodeVersion-win-$Arch"
      Write-Host "① 没有找到 Node.js，正在下载 Node.js $($NodeVersion.TrimStart('v'))（约 30 MB，只装在你的用户目录）…"
      $Zip = Join-Path $Tmp "$Name.zip"; $Got = $false
      foreach ($Mirror in $NodeMirrors) {
        $Sums = Join-Path $Tmp 'SHASUMS256.txt'
        if ((Get-File "$Mirror/$NodeVersion/$Name.zip" $Zip) -and (Get-File "$Mirror/$NodeVersion/SHASUMS256.txt" $Sums)) {
          $Want = (Get-Content $Sums | Where-Object { $_ -match "\s$([regex]::Escape("$Name.zip"))$" } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
          $Have = (Get-FileHash -Algorithm SHA256 $Zip).Hash.ToLower()
          if ($Want -and $Want -eq $Have) { $Got = $true; break }
          Write-Host '  校验没通过，换一个下载源…'
        } else { Write-Host '  这个下载源连不上，换一个…' }
      }
      if (-not $Got) { throw 'Node.js 下载失败。请检查网络后重新运行同一行命令。' }
      Expand-Archive -Force $Zip $Tmp
      if (Test-Path $Private) { Remove-Item -Recurse -Force $Private }
      New-Item -ItemType Directory -Force -Path $AppHome | Out-Null
      Move-Item (Join-Path $Tmp $Name) $Private
      $Node = Join-Path $Private 'node.exe'
      Write-Host '  ✓ Node.js 已就绪'
    }
    # 安装向导会调用 npm，让它用上面这份 Node.js。
    $env:Path = (Split-Path $Node) + ';' + $env:Path

    $Browsers = @(
      "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe", "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
      "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe", "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe")
    if (-not ($Browsers | Where-Object { $_ -and (Test-Path $_) })) {
      throw '登录学校账号需要 Chrome 或 Edge 浏览器。请先安装 Chrome（https://www.google.com/chrome/），再重新运行同一行命令。'
    }

    Write-Host '② 正在下载课程助手…'
    $AppZip = Join-Path $Tmp 'app.zip'
    if (-not ((Get-File "$Site/xjtlu-core-mcp.zip" $AppZip) -or (Get-File $RepoZip $AppZip))) {
      throw '课程助手下载失败。请检查网络（或连接校园网 / VPN）后重新运行同一行命令。'
    }
    Expand-Archive -Force $AppZip (Join-Path $Tmp 'app')
    $Installer = Get-ChildItem -Path (Join-Path $Tmp 'app') -Recurse -Filter 'install-xjtlu.mjs' | Select-Object -First 1
    if (-not $Installer) { throw '下载的文件不完整，请重新运行同一行命令。' }

    # npm 官方源连不上时改用国内镜像（依赖版本由锁文件固定，只换下载地址）。
    if (-not $env:npm_config_registry) {
      try { Invoke-WebRequest -UseBasicParsing -Uri 'https://registry.npmjs.org/zod' -TimeoutSec 10 -Method Head | Out-Null }
      catch { $env:npm_config_registry = 'https://registry.npmmirror.com' }
    }

    Write-Host '③ 正在安装依赖，然后会打开学校登录窗口…'
    Write-Host ''
    & $Node $Installer.FullName --quick
  } catch {
    Write-Host ''
    Write-Host ('✗ ' + $_.Exception.Message) -ForegroundColor Red
  } finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
  }
}
