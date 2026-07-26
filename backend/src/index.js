require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// Security & performance
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// API
app.use('/api', apiRoutes);

// Serve frontend static
const frontendPath = path.join(__dirname, '../../frontend');
app.use(express.static(frontendPath));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   Shopee Affiliate Manager                   ║
║   Mode : ${(process.env.APP_MODE || 'mock').padEnd(10)}                     ║
║   Port : ${String(PORT).padEnd(10)}                     ║
║   Ready for EasyPanel + PostgreSQL           ║
╚══════════════════════════════════════════════╝
  `);
});
