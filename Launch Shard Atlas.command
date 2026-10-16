#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:$PATH"
cd -- "$(dirname -- "$0")"
python3 launch.py
