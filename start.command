#!/bin/zsh

cd "$(dirname "$0")" || exit 1

echo "Starting Posture Care Monitor..."

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies first..."
  npm install || exit 1
fi

(sleep 2 && open "http://localhost:5173/") &

npm run dev
