require('dotenv').config();
const http = require('http');
const app = require('./app');
const { initChatServer } = require('./websocket/chatServer');
const { startMatchmakingWorker } = require('./services/matchmakingService');
const { startVentCleanupWorker } = require('./workers/ventCleanupWorker');
const { startSubscriptionWorker } = require('./workers/subscriptionWorker');

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);

// Initialize WebSocket chat server
initChatServer(server);

server.listen(PORT, () => {
    console.log(`🏋️ IronRoom API server running on port ${PORT}`);
    console.log(`📡 WebSocket server attached`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);

    // Start background workers
    startMatchmakingWorker();
    startVentCleanupWorker();
    startSubscriptionWorker();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
