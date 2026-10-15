#!/usr/bin/env bash
# kLattsch Avatar — start the server (detached) and open the browser.
cd "$(dirname "$0")"

if curl -s --max-time 2 http://localhost:3000/api/info >/dev/null 2>&1; then
  echo "Already running at http://localhost:3000"
else
  setsid nohup node server.js > /tmp/klatts-server.log 2>&1 < /dev/null &
  sleep 2
  echo "Started. Log: /tmp/klatts-server.log"
fi

URL="http://localhost:3000"
echo "Open: $URL"
command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL" >/dev/null 2>&1 &
command -v brave-browser >/dev/null 2>&1 && brave-browser "$URL" >/dev/null 2>&1 &
