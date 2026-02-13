const express = require('express');
const prisma = require('../config/database');
const { authenticate, requireActive, requireNotSuspended } = require('../middleware/auth');
const { requireSubscription } = require('../middleware/subscription');

const router = express.Router();

// All room routes require auth + active status + subscription (for some)
router.use(authenticate);
router.use(requireActive);

/**
 * GET /api/rooms
 * List all active rooms with member counts
 */
router.get('/', async (req, res, next) => {
    try {
        const rooms = await prisma.room.findMany({
            where: { isActive: true },
            select: {
                id: true,
                name: true,
                description: true,
                _count: {
                    select: { members: true },
                },
            },
            orderBy: { createdAt: 'asc' },
        });

        const formatted = rooms.map((room) => ({
            id: room.id,
            name: room.name,
            description: room.description,
            activeParticipants: room._count.members,
        }));

        res.json({ rooms: formatted });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/rooms/:roomId/join
 * Join a room
 */
router.post('/:roomId/join', requireSubscription, requireNotSuspended, async (req, res, next) => {
    try {
        const { roomId } = req.params;

        const room = await prisma.room.findUnique({ where: { id: roomId } });
        if (!room || !room.isActive) {
            return res.status(404).json({ error: 'Room not found' });
        }

        // Check if already a member
        const existing = await prisma.roomMember.findUnique({
            where: { roomId_userId: { roomId, userId: req.user.id } },
        });

        if (existing) {
            return res.json({ message: 'Already a member of this room' });
        }

        await prisma.roomMember.create({
            data: { roomId, userId: req.user.id },
        });

        res.json({ message: 'Joined room successfully' });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/rooms/:roomId/leave
 * Leave a room
 */
router.post('/:roomId/leave', async (req, res, next) => {
    try {
        const { roomId } = req.params;

        await prisma.roomMember.deleteMany({
            where: { roomId, userId: req.user.id },
        });

        res.json({ message: 'Left room' });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/rooms/:roomId/messages
 * Get paginated messages from a room (async feed)
 * Cursor-based pagination: ?cursor=<last_message_id>&limit=50
 */
router.get('/:roomId/messages', requireSubscription, async (req, res, next) => {
    try {
        const { roomId } = req.params;
        const { cursor, limit = 50 } = req.query;
        const take = Math.min(parseInt(limit), 100);

        // Verify room exists
        const room = await prisma.room.findUnique({ where: { id: roomId } });
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }

        // Get blocked user IDs to filter them out
        const blocks = await prisma.blockedUser.findMany({
            where: {
                OR: [
                    { blockerId: req.user.id },
                    { blockedId: req.user.id },
                ],
            },
        });
        const blockedIds = blocks.map((b) =>
            b.blockerId === req.user.id ? b.blockedId : b.blockerId
        );

        const whereClause = {
            roomId,
            senderId: { notIn: blockedIds },
        };

        const queryOptions = {
            where: whereClause,
            take,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                messageText: true,
                createdAt: true,
                isFlagged: true,
                replyToId: true,
                sender: {
                    select: {
                        id: true,
                        displayName: true,
                        identityMode: true,
                    },
                },
                replyTo: {
                    select: {
                        id: true,
                        messageText: true,
                        sender: {
                            select: { displayName: true }
                        }
                    }
                },
            },
        };

        if (cursor) {
            queryOptions.skip = 1;
            queryOptions.cursor = { id: cursor };
        }

        const messages = await prisma.roomMessage.findMany(queryOptions);

        res.json({
            messages: messages.reverse(), // Return in chronological order
            nextCursor: messages.length === take ? messages[messages.length - 1]?.id : null,
            hasMore: messages.length === take,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/rooms/:roomId/messages
 * Post a message to a room (async feed)
 */
router.post('/:roomId/messages', requireSubscription, requireNotSuspended, async (req, res, next) => {
    try {
        const { roomId } = req.params;
        const { messageText, replyToId } = req.body;

        if (!messageText || messageText.trim().length === 0) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }

        if (messageText.length > 2000) {
            return res.status(400).json({ error: 'Message too long (max 2000 characters)' });
        }

        // Verify room exists and user is a member
        const membership = await prisma.roomMember.findUnique({
            where: { roomId_userId: { roomId, userId: req.user.id } },
        });

        if (!membership) {
            return res.status(403).json({ error: 'You must join this room first' });
        }

        const message = await prisma.roomMessage.create({
            data: {
                roomId,
                senderId: req.user.id,
                messageText: messageText.trim(),
                replyToId: replyToId || null,
            },
            select: {
                id: true,
                messageText: true,
                createdAt: true,
                replyToId: true,
                replyTo: {
                    select: {
                        id: true,
                        messageText: true,
                        sender: { select: { displayName: true } }
                    }
                },
                sender: {
                    select: {
                        id: true,
                        displayName: true,
                    },
                },
            },
        });

        // ─── Handle Mentions ───
        const mentionMatches = messageText.match(/@([\w\s]+)/g);
        if (mentionMatches) {
            const potentialNames = mentionMatches.map(m => m.substring(1).trim());
            // Find users with these display names
            const mentionedUsers = await prisma.user.findMany({
                where: {
                    displayName: { in: potentialNames, mode: 'insensitive' },
                    id: { not: req.user.id }, // Don't notify self
                    isActive: true,
                },
                select: { id: true, fcmToken: true }
            });

            if (mentionedUsers.length > 0) {
                const notificationService = require('../../../services/notificationService');
                const room = await prisma.room.findUnique({ where: { id: roomId }, select: { name: true } });

                // Send notifications asynchronously
                Promise.all(mentionedUsers.map(user => {
                    return notificationService.sendPushNotification(user.id, {
                        title: `Mentioned in ${room.name}`,
                        body: `${req.user.displayName} mentioned you: "${messageText.length > 50 ? messageText.substring(0, 50) + '...' : messageText}"`,
                        data: {
                            type: 'mention',
                            roomId: roomId,
                        }
                    });
                })).catch(err => console.error('Failed to send mention notifications:', err));
            }
        }

        res.status(201).json({ message });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
