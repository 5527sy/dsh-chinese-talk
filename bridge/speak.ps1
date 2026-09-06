param(
    [Parameter(Mandatory = $true)]
    [string]$Text
)
# dsh 风格系统语音朗读。自动优先自然语音：晓晓(Xiaoxiao)/晓伊/云希/云健/云扬，
# 都没有则回退默认(Huihui)。可用环境变量 DSH_SPEAK_VOICE 强制指定子串。
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $want = $env:DSH_SPEAK_VOICE
    $priority = @('Xiaoxiao','Xiaoyi','Yunxi','Yunjian','Yunyang','Huihui')
    if (-not [string]::IsNullOrEmpty($want)) {
        $priority = @($want)
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
