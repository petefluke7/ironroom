const express = require('express');
const prisma = require('../config/database');
const { authenticate, requireNotSuspended } = require('../middleware/auth');
const { requireSubscription } = require('../middleware/subscription');

const router = express.Router();

// All room routes require auth + subscription
router.use(authenticate);

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
                sender: {
                    select: {
                        id: true,
                        displayName: true,
                        identityMode: true,
                    },
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
        const { messageText } = req.body;

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
            },
            select: {
                id: true,
                messageText: true,
                createdAt: true,
                sender: {
                    select: {
                        id: true,
                        displayName: true,
                    },
                },
            },
        });

        res.status(201).json({ message });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
