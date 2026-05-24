// Central config. Everything reads from env so the same code runs
// locally and on Render without edits.
export const config = {
  port: process.env.PORT || 5001,
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Email (alerts + reports). Falls back to console logging if unset,
  // so the app runs end-to-end with zero third-party setup.
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || 'Polaris <alerts@polaris.app>',
  },

  // Public base URL, used when we print webhook ingest endpoints.
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:5000',
};

export const isProd = config.nodeEnv === 'production';
