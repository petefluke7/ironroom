require('dotenv').config();
const http = require('http');
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
