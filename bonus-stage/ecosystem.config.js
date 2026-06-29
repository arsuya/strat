/**
 * PM2 process config for VPS deployment.
 *
 * Usage:
 *   npm install -g pm2          # once per VPS
 *   npm run build               # compile TypeScript
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup
 *   pm2 logs bonus-stage-detect
 *   pm2 restart bonus-stage-detect
 *   pm2 stop bonus-stage-detect
 */
module.exports = {
  apps: [
    {
      name: "bonus-stage-detect",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1, // single instance — never run two copies
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
