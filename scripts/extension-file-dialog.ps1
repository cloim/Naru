[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$options = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($options.properties -contains 'openDirectory') {
  $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
  $dialog.Description = if ($options.title) { [string]$options.title } else { '폴더 선택' }
  if ($options.defaultPath -and (Test-Path -LiteralPath $options.defaultPath -PathType Container)) { $dialog.SelectedPath = $options.defaultPath }
  $result = $dialog.ShowDialog()
  $paths = if ($result -eq [System.Windows.Forms.DialogResult]::OK) { @($dialog.SelectedPath) } else { @() }
} else {
  $dialog = [System.Windows.Forms.OpenFileDialog]::new()
  $dialog.Title = if ($options.title) { [string]$options.title } else { '파일 선택' }
  $dialog.Multiselect = $options.properties -contains 'multiSelections'
  if ($options.defaultPath -and (Test-Path -LiteralPath $options.defaultPath -PathType Container)) { $dialog.InitialDirectory = $options.defaultPath }
  if ($options.filters) {
    $parts = foreach ($filter in $options.filters) {
      $extensions = @($filter.extensions | Where-Object { $_ -match '^[a-zA-Z0-9*]+$' } | ForEach-Object { '*.' + $_ })
      if ($extensions.Count -gt 0) { ([string]$filter.name).Replace('|',' ') + '|' + ($extensions -join ';') }
    }
    if ($parts) { $dialog.Filter = $parts -join '|' }
  }
  $result = $dialog.ShowDialog()
  $paths = if ($result -eq [System.Windows.Forms.DialogResult]::OK) { @($dialog.FileNames) } else { @() }
}
@{canceled=($result -ne [System.Windows.Forms.DialogResult]::OK);filePaths=@($paths)} | ConvertTo-Json -Compress
$dialog.Dispose()
