param([Parameter(Mandatory=$true)][string]$InputDocx, [Parameter(Mandatory=$true)][string]$OutputPdf)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $InputDocx).Path
$workspace = [IO.Path]::GetFullPath((Get-Location).Path).TrimEnd('\') + '\'
$target = [IO.Path]::GetFullPath($OutputPdf)
if (-not $source.StartsWith($workspace, [StringComparison]::OrdinalIgnoreCase) -or -not $target.StartsWith($workspace, [StringComparison]::OrdinalIgnoreCase)) { throw 'Word QA files must remain within this workspace.' }
$parent = [IO.Path]::GetDirectoryName($target)
[IO.Directory]::CreateDirectory($parent) | Out-Null
$word = $null
$doc = $null
try {
  # Use a new owned Word automation instance; never attach to the user's open documents.
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3
  $doc = $word.Documents.Open($source, $false, $true)
  $doc.Repaginate()
  $pages = $doc.ComputeStatistics(2)
  $doc.ExportAsFixedFormat($target, 17)
  if (-not (Test-Path -LiteralPath $target)) { throw 'Word did not produce the requested PDF.' }
  @{ renderer = 'Microsoft Word native fixed-format export'; readOnlySource = $true; pages = $pages; bytes = (Get-Item -LiteralPath $target).Length; output = $target } | ConvertTo-Json
} finally {
  if ($null -ne $doc) { $doc.Close(0); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) }
  if ($null -ne $word) { $word.Quit(0); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
