# 本地语音服务端部署清单（ASR + TTS，GTX 950 2GB）

> 目标：在家里那台 GTX 950 2GB（Maxwell, sm_5.2）上起一个 OpenAI 兼容的 ASR+TTS 服务，
> 给 Airi 的 Hearing / Speech 模块用。Airi 侧代码已完成（见
> `packages/stage-ui/src/stores/providers/openai-compatible-audio-models.ts`），本文件只覆盖服务端。

## 选型

- **speaches**：一个服务同时提供 ASR + TTS，两者都会列进 `/v1/models`，
  正好命中 Airi 的 `listAudioModels`（按 kind 关键词过滤，匹配不到回退完整列表，无鉴权不发 Authorization 头）。
- 显存预算（2GB）：
  - ASR：whisper small int8（faster-whisper / CTranslate2，~0.5GB）
  - TTS：Kokoro-82M（~0.5GB，CPU 也能跑）
- 兼容性：faster-whisper/CTranslate2 ✓、whisper.cpp CUDA ✓、
  onnxruntime-gpu 需要 CC≥5.2（950 刚好够，sm_5.2）。
- 国内拉模型：`HF_ENDPOINT=https://hf-mirror.com`

## 部署步骤（在那台机器上执行）

```bash
# 1. NVIDIA 驱动 + CUDA（如果还没有）
sudo apt install nvidia-driver-550          # 或该机器适用的版本
nvidia-smi                                  # 确认显卡可见

# 2. uv + Python 3.11
curl -LsSf https://astral.sh/uv/install.sh | sh
uv python install 3.11

# 3. 克隆并安装 speaches（仓库：https://github.com/speaches-ai/speaches）
git clone https://github.com/speaches-ai/speaches
cd speaches
export HF_ENDPOINT=https://hf-mirror.com
uv sync --extra ctranslate2                  # 或 --extra cuda / --extra onnxruntime-gpu
```

## 配置（.env 或启动参数）

```bash
# ASR: faster-whisper 走 CTranslate2，int8 量化省显存
SPEACHES_WHISPER_IMPLEMENTATION=faster-whisper
SPEACHES_WHISPER__MODEL=SYSTRAN/faster-whisper-small     # int8 由实现自动量化
SPEACHES_WHISPER__COMPUTE_TYPE=int8

# TTS: Kokoro 82M
SPEACHES_KOKORO__MODEL=hexgrad/Kokoro-82M
SPEACHES_KOKORO__VOICE=zf_xiaoxiao                        # 中文女声，按需换
SPEACHES_KOKORO__LANGUAGE=zh

SPEACHES_HOST=0.0.0.0
SPEACHES_PORT=8000

# 无鉴权（局域网内用，Airi 侧没有 key 时不会发 Authorization 头）
```

启动并验证：

```bash
uv run python -m speaches   # 或按照仓库当前入口启动
curl http://localhost:8000/v1/models
```

`/v1/models` 应同时列出 whisper（transcription）和 kokoro（speech）条目。

## systemd 常驻

```ini
# /etc/systemd/system/speaches.service
[Unit]
Description=speaches ASR+TTS
After=network.target

[Service]
WorkingDirectory=/home/<user>/speaches
Environment=HF_ENDPOINT=https://hf-mirror.com
EnvironmentFile=/home/<user>/speaches/.env
ExecStart=/home/<user>/.local/bin/uv run python -m speaches
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Airi 侧接线

1. **ASR**：`Providers → OpenAI Compatible (transcription)` 填
   `http://<950-ip>:8000/v1/` + 假 key（如 `sk-local`，validator 要求非空）。
2. `Modules → Hearing` 选该 provider → 模型列表自动填充 → 选 whisper 模型 → 用内置 "Speech-to-Text Test" 验证。
3. **TTS**：`Providers → OpenAI Compatible (speech)` 同地址 → `Modules → Speech` 选 Kokoro 模型、
   声音名（如 `zf_xiaoxiao`），Speech 页 playground 直接可验。

注意写回：chat 播放读 `providerConfig.model/voice`（Stage.vue speech pipeline），
不是 `activeSpeechModel`；ASR 运行时读 `activeTranscriptionModel`（hearing store, localStorage）。

## 兜底（不搭服务器）

- TTS：in-app `kokoro-local`（WASM/CPU，Firefox 可用，不需要 WebGPU）。
- ASR：浏览器内 Whisper 走不通（Firefox/Linux 没有 WebGPU），必须靠本服务或服务端 ASR。

## 已知坑

- 游戏占着显卡时避免同时跑大模型（用户明确否掉过 ollama 9B 抢显存）。
- openai-compatible 的 validator 要求非空 apiKey → 填假 key 或点 "Continue Anyway"。
