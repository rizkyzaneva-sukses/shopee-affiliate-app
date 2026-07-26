/**
 * Frontend Config
 * API_BASE otomatis relative (sama origin) saat di-serve oleh backend.
 * Untuk development terpisah bisa ganti ke http://localhost:3000
 */
window.APP_CONFIG = {
  API_BASE: '',          // '' = same origin (production)
  // API_BASE: 'http://localhost:3000',
  DEFAULT_PERIOD: 'Last30d',
  REFRESH_INTERVAL_MS: 0, // 0 = manual only
};
