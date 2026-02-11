const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const prisma = require('../config/database');

let io;

/**
 * Initialize Socket.IO server for private 1-on-1 chat
 * Rooms (group chat) are async feed, no WebSocket needed
 */
function initChatServer(httpServer) {
    io = new Server(httpServer, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
        },
        pingTimeout: 60000,
        pingInterval: 25000,
    });

    // Authentication middleware for WebSocket
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token || socket.handshake.query?.token;

            if (!token) {
                return next(new Error('Authentication token required'));
            }

            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const user = await prisma.user.findUnique({
                where: { id: decoded.userId },
                select: {
                    id: true,
                    displayName: true,
                    isSuspended: true,
                },
            });

            if (!user || user.isSuspended) {
                return next(new Error('Access denied'));
            }

            socket.userId = user.id;
            socket.displayName = user.displayName;
            next();
        } catch (error) {
            next(new Error('Invalid token'));
        }
    });

    io.on('connection', (socket) => {
        console.log(`🔌 User connected: ${socket.userId}`);

        // Join a private match room
        socket.on('join_match', async ({ matchId }) => {
            try {
                // Verify user is part of this match
                const match = await prisma.privateMatch.findFirst({
                    where: {
                        id: matchId,
                        OR: [{ userOneId: socket.userId }, { userTwoId: socket.userId }],
                        status: 'active',
                    },
                });

                if (!match) {
                    socket.emit('error', { message: 'Match not found or inactive' });
                    return;
                }

                socket.join(`match:${matchId}`);
                socket.matchId = matchId;

                socket.emit('joined_match', {
                    matchId,
                    message: 'Connected to private chat',
                });

                console.log(`👥 User ${socket.userId} joined match ${matchId}`);
            } catch (error) {
                socket.emit('error', { message: 'Failed to join match' });
            }
        });

        // Send a private message
        socket.on('send_message', async ({ matchId, messageText }) => {
            try {
                if (!messageText || messageText.trim().length === 0) return;
                if (messageText.length > 2000) {
                    socket.emit('error', { message: 'Message too long' });
                    return;
                }

                // Verify match is still active
                const match = await prisma.privateMatch.findFirst({
                    where: { id: matchId, status: 'active' },
                });

                if (!match) {
                    socket.emit('error', { message: 'Match is no longer active' });
                    return;
                }

                // Save message to database
                const message = await prisma.privateMessage.create({
                    data: {
                        matchId,
                        senderId: socket.userId,
                        messageText: messageText.trim(),
                    },
                    select: {
                        id: true,
                        messageText: true,
                        createdAt: true,
                        sender: {
                            select: { id: true, displayName: true },
                        },
                    },
                });

                // Broadcast to both users in the match room
                io.to(`match:${matchId}`).emit('new_message', message);

                // Send push notification to other user if offline
                const otherUserId = match.userOneId === socket.userId
                    ? match.userTwoId
                    : match.userOneId;

                // Check if other user is connected
                const otherSockets = await io.in(`match:${matchId}`).fetchSockets();
                const otherOnline = otherSockets.some((s) => s.userId === otherUserId);

                if (!otherOnline) {
                    // Queue push notification (handled by notification service)
                    const { sendPushNotification } = require('../services/notificationService');
                    await sendPushNotification(otherUserId, {
                        title: 'New message',
                        body: 'Someone sent you a message',
                        data: { type: 'private_message', matchId },
                    });
                }
            } catch (error) {
                console.error('Error sending message:', error);
                socket.emit('error', { message: 'Failed to send message' });
            }
        });

        // End chat
        socket.on('end_chat', async ({ matchId }) => {
            try {
                const match = await prisma.privateMatch.findFirst({
                    where: {
                        id: matchId,
                        OR: [{ userOneId: socket.userId }, { userTwoId: socket.userId }],
                        status: 'active',
                    },
                });

                if (!match) return;

                const now = new Date();
                const durationSeconds = Math.floor((now - match.matchedAt) / 1000);

                await prisma.privateMatch.update({
                    where: { id: matchId },
                    data: {
                        status: 'ended',
                        endedAt: now,
                        durationSeconds,
                    },
                });

                // Notify both users
                io.to(`match:${matchId}`).emit('chat_ended', {
                    matchId,
                    endedBy: socket.userId,
                    durationSeconds,
                });

                // Remove all users from the match room
                const sockets = await io.in(`match:${matchId}`).fetchSockets();
                for (const s of sockets) {
                    s.leave(`match:${matchId}`);
                }

                console.log(`🔚 Match ${matchId} ended by ${socket.userId}`);
            } catch (error) {
                socket.emit('error', { message: 'Failed to end chat' });
            }
        });

        // Handle disconnection
        socket.on('disconnect', () => {
            console.log(`❌ User disconnected: ${socket.userId}`);
        });
    });

    console.log('📡 Chat WebSocket server initialized');
    return io;
}

function getIO() {
    if (!io) throw new Error('Socket.IO not initialized');
    return io;
}

module.exports = { initChatServer, getIO };
