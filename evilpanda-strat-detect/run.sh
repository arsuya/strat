#!/bin/bash
export HOME=/home/ubuntu
export PATH=/home/ubuntu/.hermes/node/bin:/usr/local/bin:/usr/bin:/bin
export GMGN_API_KEY="gmgn_28156921d7fc65f4eeb2824f4f525e8e"
cd /home/ubuntu/evilpanda-strat-detect
exec /home/ubuntu/evilpanda-strat-detect/.venv/bin/python scanner.py
