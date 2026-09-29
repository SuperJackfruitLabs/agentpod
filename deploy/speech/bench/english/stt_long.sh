#!/bin/bash
# One 5-minute transcription against the live transcriber; prints http code and wall time only.
set -a; . /etc/agentpod-transcriber.env; set +a
curl -s -o /dev/null -w "%{http_code} %{time_total}\n" -H "Authorization: Bearer $TRANSCRIBER_TOKEN" \
  -F file=@/root/stt-bench/long5.wav -F model=large-v3-turbo \
  http://$TRANSCRIBER_HOST:$TRANSCRIBER_PORT/v1/audio/transcriptions
