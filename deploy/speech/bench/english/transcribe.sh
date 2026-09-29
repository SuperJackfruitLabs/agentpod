#!/bin/bash
# Transcribe WAVs with the live transcriber (token read from env file, never printed).
set -a; . /etc/agentpod-transcriber.env; set +a
for f in "$@"; do
  txt=$(curl -s -H "Authorization: Bearer $TRANSCRIBER_TOKEN" -F file=@"$f" -F model=large-v3-turbo -F language=en \
        http://$TRANSCRIBER_HOST:$TRANSCRIBER_PORT/v1/audio/transcriptions | python3 -c 'import json,sys; print(json.load(sys.stdin).get("text","").strip())')
  echo "$(basename "$f")	$txt"
done
