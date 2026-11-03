# Posts one approved clip on its own, for Windows Task Scheduler (no Claude needed):
#   Facebook + Instagram (data/posts/<id>.json), Threads (data/posts/<id>-still.json), then one TikTok draft.
# Networks already in data/publish-journal.json are skipped, and the TikTok draft is sent once (marker in logs\),
# so running it twice never double-posts. Media is read from MEDIA_DIR, default site\public\media.
#   powershell -ExecutionPolicy Bypass -File scripts\post-clip.ps1 pilot-satank-8 [-DryRun]
param(
  [Parameter(Mandatory = $true)][string]$Id,
  [switch]$DryRun
)
$ErrorActionPreference = "Continue"
$repo = (Resolve-Path "$PSScriptRoot\..").Path
$media = if ($env:MEDIA_DIR) { $env:MEDIA_DIR } else { Join-Path $repo "site\public\media" }
$logDir = Join-Path $repo "logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir "post-$Id.log"
function Say($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; Write-Output $line; Add-Content -Path $log -Value $line -Encoding utf8 }

$journalFile = Join-Path $repo "data\publish-journal.json"
$journal = if (Test-Path $journalFile) { Get-Content $journalFile -Raw -Encoding utf8 | ConvertFrom-Json } else { $null }
function Posted($key) { $journal -and ($journal.PSObject.Properties.Name -contains $key) -and ($journal.$key.state -eq "published") }

$post = Join-Path $repo "data\posts\$Id.json"
$still = Join-Path $repo "data\posts\$Id-still.json"
if (-not (Test-Path $post)) { Say "no post file $post"; exit 1 }

Set-Location $repo
$todo = @("facebook", "instagram") | Where-Object { -not (Posted "${Id}:${_}:reels-9x16") }
if ($todo) {
  Say "publish $Id to $($todo -join ', ')"
  if (-not $DryRun) { & npm run channel -- publish "data/posts/$Id.json" @todo 2>&1 | ForEach-Object { Say "$_" } }
} else { Say "$Id already on Facebook and Instagram" }

if (Test-Path $still) {
  if (-not (Posted "${Id}-still:threads:image-4x5")) {
    Say "publish $Id-still to threads"
    if (-not $DryRun) { & npm run channel -- publish "data/posts/$Id-still.json" threads 2>&1 | ForEach-Object { Say "$_" } }
  } else { Say "$Id-still already on Threads" }
}

$marker = Join-Path $logDir "tiktok-$Id.done"
if (-not (Test-Path $marker)) {
  $url = (Get-Content $post -Raw -Encoding utf8 | ConvertFrom-Json).mediaUrls[0]
  $video = Join-Path $media ($url -replace '^.*?/media/', '')
  Say "tiktok draft $video"
  if (-not $DryRun) {
    $out = & npm run channel -- tiktok-draft $video 2>&1
    $out | ForEach-Object { Say "$_" }
    if ($out -match "TikTok inbox") { Set-Content -Path $marker -Value (Get-Date) }
  }
} else { Say "$Id TikTok draft already sent" }
Say "done$(if ($DryRun) { ' (dry run, nothing sent)' })"
