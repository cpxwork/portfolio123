param(
  [ValidateSet('glm-4.7-flash', 'glm-4-flash-250414')]
  [string]$ModelName = 'glm-4-flash-250414'
)
$ErrorActionPreference = 'Stop'
$secret = Read-Host '请输入智谱 API Key（输入不显示，不保存到文件）' -AsSecureString
try {
  $credential = [System.Management.Automation.PSCredential]::new('local', $secret)
  $configuration = @{ MODEL_API_KEY = $credential.GetNetworkCredential().Password; MODEL_NAME = $ModelName }
  $configuration | ConvertTo-Json -Compress | & node (Join-Path $PSScriptRoot 'run-local.cjs')
} finally {
  if ($configuration) { $configuration.MODEL_API_KEY = '' }
  $credential = $null
  $secret.Dispose()
}
