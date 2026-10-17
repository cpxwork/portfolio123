param(
  [ValidateSet('aiping', 'zhipu')]
  [string]$Provider = 'aiping',
  [string]$ModelName = '',
  [double]$BudgetCny = 0,
  [ValidateRange(1, 60)]
  [int]$MaxTurns = 60
)
$ErrorActionPreference = 'Stop'
$models = @{
  aiping = @('GLM-4.7-Flash', 'GLM-5.3-Flash', 'Qwen3.5-Flash', 'DeepSeek-V4-Flash', 'DeepSeek-V4.1-Flash', 'Step-3.5-Flash')
  zhipu  = @('glm-4.7-flash', 'glm-4-flash-250414')
}
$defaults = @{ aiping = 'GLM-4.7-Flash'; zhipu = 'glm-4-flash-250414' }
if (-not $ModelName) { $ModelName = $defaults[$Provider] }
if ($models[$Provider] -notcontains $ModelName) {
  throw "型号 $ModelName 不在 $Provider 的允许列表。可选：$($models[$Provider] -join ', ')。脚本不会自动换成付费或其他型号。"
}
$label = if ($Provider -eq 'aiping') { 'AI Ping' } else { '智谱' }
$secret = Read-Host "请输入 $label API Key（输入不显示，不保存到文件）" -AsSecureString
try {
  $credential = [System.Management.Automation.PSCredential]::new('local', $secret)
  $configuration = @{
    MODEL_PROVIDER = $Provider
    MODEL_API_KEY  = $credential.GetNetworkCredential().Password
    MODEL_NAME     = $ModelName
    MODEL_MAX_TURNS = $MaxTurns
  }
  if ($BudgetCny -gt 0) { $configuration.MODEL_BUDGET_CNY = $BudgetCny }
  $configuration | ConvertTo-Json -Compress | & node (Join-Path $PSScriptRoot 'run-local.cjs')
} finally {
  if ($configuration) { $configuration.MODEL_API_KEY = '' }
  $credential = $null
  $secret.Dispose()
}
