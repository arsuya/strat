module.exports = {
  apps: [{
    name: 'dlmm-scanner',
    script: '/home/ubuntu/evilpanda-strat-detect/.venv/bin/python',
    args: 'scanner.py',
    cwd: '/home/ubuntu/evilpanda-strat-detect',
    interpreter: 'none',
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,
    restart_delay: 30000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GMGN_API_KEY: 'gmgn_28156921d7fc65f4eeb2824f4f525e8e',
      SCAN_INTERVAL_SEC: '60',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/home/ubuntu/evilpanda-strat-detect/logs/err.log',
    out_file: '/home/ubuntu/evilpanda-strat-detect/logs/out.log',
    merge_logs: true,
  }]
};
