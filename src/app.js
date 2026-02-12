const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { apiLimiter } = require('./middleware/rateLimiter');

// Route imports
const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const roomRoutes = require('./routes/rooms');
const matchRoutes = require('./routes/matches');
const ventRoutes = require('./routes/vents');
const reportRoutes = require('./routes/reports');
const subscriptionRoutes = require('./routes/subscriptions');

// Admin route imports
const adminAuthRoutes = require('./routes/admin/auth');
const adminReportRoutes = require('./routes/admin/reports');
const adminUserRoutes = require('./routes/admin/users');
const adminRoomRoutes = require('./routes/admin/rooms');
const adminPromptRoutes = require('./routes/admin/prompts');
const adminIntentRoutes = require('./routes/admin/intents');
const adminAnalyticsRoutes = require('./routes/admin/analytics');

const app = express();

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            connectSrc: ["'self'"],
            imgSrc: ["'self'", "data:"],
        },
    },
}));
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
}));

// Body parsing
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// Logging
if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('combined'));
}

// Rate limiting
app.use('/api/', apiLimiter);

// Serve admin panel static files
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));

// Root redirect to admin
app.get('/', (req, res) => res.redirect('/admin/'));

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Debug endpoint to check env vars and DB connectivity
app.get('/health/debug', async (req, res) => {
    const checks = {
        DATABASE_URL: !!process.env.DATABASE_URL ? 'SET' : 'MISSING',
        JWT_SECRET: !!process.env.JWT_SECRET ? 'SET' : 'MISSING',
        REDIS_URL: !!process.env.REDIS_URL ? 'SET' : 'MISSING',
        NODE_ENV: process.env.NODE_ENV || 'not set',
        nodeVersion: process.version,
    };
    try {
        const prisma = require('./config/database');
        const count = await prisma.moderator.count();
        checks.database = 'CONNECTED';
        checks.moderatorCount = count;
    } catch (e) {
        checks.database = 'ERROR: ' + e.message;
    }
    res.json(checks);
});

// ─── API Routes ──────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/vents', ventRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/subscriptions', subscriptionRoutes);

// ─── Admin Routes ────────────────────────────
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/reports', adminReportRoutes);
app.use('/api/admin/users', adminUserRoutes);
app.use('/api/admin/rooms', adminRoomRoutes);
app.use('/api/admin/prompts', adminPromptRoutes);
app.use('/api/admin/intents', adminIntentRoutes);
app.use('/api/admin/analytics', adminAnalyticsRoutes);

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: err.message || 'Internal server error',
    });
});

module.exports = app;
