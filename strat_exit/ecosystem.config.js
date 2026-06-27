/**
 * PM2 process config for VPS deployment.
 *
 * Usage:
 *   npm install -g pm2          # once per VPS
 *   npm run build               # compile TypeScript
 *   pm2 start ecosystem.config.js
 *   pm2 save                    # persist process list
 *   pm2 startup                 # follow printed instructions to auto-start on boot
 *   pm2 logs meteora-exit-bot   # tail logs
 *   pm2 restart meteora-exit-bot
 *   pm2 stop meteora-exit-bot
 */
module.exports = {
  apps: [
    {
      name: "meteora-exit-bot",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1, // single instance — never run two copies of the same bot
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      merge_logs: true,
      time: true,
    },
  ],
};
