# Fix: Voice Transcription — FFmpeg Conversion for Opus-in-OGG

## Goal

Fix voice message transcription which currently fails because whisper-cli cannot decode Opus-in-OGG (.oga), the format Telegram uses for voice messages.

## Context

Bot is at `~/.openclaw/bot/`. Voice transcription was added in round 4 but fails in production. Three issues found during manual testing:

1. **Wrong model path** (already fixed in master): was `/opt/homebrew/share/ggml-small.bin`, correct path is `/opt/homebrew/share/whisper-cpp/ggml-small.bin`
2. **Missing --no-prints flag** (already fixed in master): whisper-cli dumps model loading info to stdout, drowning out transcript text
3. **Opus-in-OGG not supported** (this plan): whisper-cli `--help` claims OGG support but fails on Opus codec in OGG container with `error: failed to read audio data as wav (Unknown error)`. Telegram voice messages are always Opus-in-OGG (.oga).

Verified fix: convert .oga to 16kHz mono WAV with ffmpeg before passing to whisper-cli.

```bash
# This fails:
whisper-cli -m /opt/homebrew/share/whisper-cpp/ggml-small.bin -f voice.oga --no-timestamps --no-prints
# error: failed to read audio data as wav (Unknown error)

# This works:
ffmpeg -i voice.oga -ar 16000 -ac 1 -f wav voice.wav -y
whisper-cli -m /opt/homebrew/share/whisper-cpp/ggml-small.bin -f voice.wav --no-timestamps --no-prints
# And so my fellow Americans, ask not what your country can do for you...
```

ffmpeg is available at `/opt/homebrew/bin/ffmpeg`.

## Validation Commands

```bash
npx tsc --noEmit
npm test
```

## Tasks

### Task 1: Add ffmpeg conversion step to voice transcription (bot-0de, P0)

In `src/voice.ts`, add a `convertToWav()` function that runs ffmpeg to convert the downloaded .oga to 16kHz mono WAV. Call it in `transcribeAudio()` before whisper-cli, and clean up the intermediate WAV file after transcription.

Beads tickets: bot-0de, bot-xzt

- [ ] Add convertToWav function using ffmpeg
- [ ] Update transcribeAudio to convert before transcribing
- [ ] Clean up intermediate WAV file
- [ ] Update tests
