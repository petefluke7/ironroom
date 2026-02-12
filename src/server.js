require('dotenv').config();
const { execSync } = require('child_process');
const http = require('http');

// ─── Database Setup (runs on every start) ────────────────
// This ensures tables exist and seed data is present
// Safe to run multiple times — db push is idempotent, seed uses upsert/findFirst
async function setupDatabase() {
    console.log('📦 Running database setup...');
    try {
        console.log('  → Pushing schema to database...');
        execSync('npx prisma db push --skip-generate --accept-data-loss', {
            stdio: 'inherit',
            timeout: 60000,
        });
        console.log('  ✅ Schema pushed successfully');
    } catch (err) {
        console.error('  ⚠️ prisma db push failed:', err.message);
        console.error('  Continuing anyway — tables may already exist');
    }

    try {
        console.log('  → Seeding database...');
        execSync('node prisma/seed.js', {
            stdio: 'inherit',
            cwd: process.cwd(),
            timeout: 30000,
        });
        console.log('  ✅ Seeding complete');
    } catch (err) {
        console.error('  ⚠️ Seeding failed:', err.message);
        console.error('  Continuing anyway — seed data may already exist');
    }
}

// ─── Start Application ──────────────────────────────────
async function start() {
    // Run DB setup first
    await setupDatabase();

    const app = require('./app');
    const PORT = process.env.PORT || 3000;
    const server = http.createServer(app);

    // Initialize WebSocket (graceful)
    try {
        const { initChatServer } = require('./websocket/chatServer');
        initChatServer(server);
    } catch (err) {
        console.error('⚠️ WebSocket init failed (non-fatal):', err.message);
    }

    server.listen(PORT, () => {
        console.log(`🏋️ IronRoom API server running on port ${PORT}`);
        console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);

        // Start background workers (graceful — don't crash if Redis is down)
        try {
            const { startMatchmakingWorker } = require('./services/matchmakingService');
            startMatchmakingWorker();
        } catch (err) {
            console.error('⚠️ Matchmaking worker failed to start:', err.message);
        }

        try {
            const { startVentCleanupWorker } = require('./workers/ventCleanupWorker');
            startVentCleanupWorker();
        } catch (err) {
            console.error('⚠️ Vent cleanup worker failed to start:', err.message);
        }

        try {
            const { startSubscriptionWorker } = require('./workers/subscriptionWorker');
            startSubscriptionWorker();
        } catch (err) {
            console.error('⚠️ Subscription worker failed to start:', err.message);
        }
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
        console.log('SIGTERM received. Shutting down gracefully...');
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    });

    // Prevent unhandled errors from crashing the process
    process.on('unhandledRejection', (err) => {
        console.error('Unhandled rejection:', err);
    });

    process.on('uncaughtException', (err) => {
        console.error('Uncaught exception:', err);
    });
}

start();
