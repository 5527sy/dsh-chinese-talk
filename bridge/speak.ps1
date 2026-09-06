param(
    [Parameter(Mandatory = $true)]
    [string]$Text
)
# 本机离线朗读（SAPI / System.Speech）。优先中文 Huihui（离线下发声最稳），
# 可用环境变量 DSH_SPEAK_VOICE 强制指定安装语音的子串。
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $want = $env:DSH_SPEAK_VOICE
    if (-not [string]::IsNullOrEmpty($want)) {
        $priority = @($want)
    } else {
        $priority = @('Huihui', 'Zira')
    }
    $picked = $false
    foreach ($name in $priority) {
        foreach ($v in $synth.GetInstalledVoices()) {
            if ($v.VoiceInfo.Name -like "*$name*") {
                $synth.SelectVoice($v.VoiceInfo.Name)
                $picked = $true
                break
            }
        }
        if ($picked) { break }
    }
    $synth.Speak($Text)
} finally {
    $synth.Dispose()
}