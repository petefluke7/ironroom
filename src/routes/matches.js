const express = require('express');
const prisma = require('../config/database');
const redis = require('../config/redis');
const { authenticate, requireActive, requireNotSuspended } = require('../middleware/auth');
const { requireSubscription } = require('../middleware/subscription');
const { matchLimiter } = require('../middleware/rateLimiter');
const { MATCH_COOLDOWN_MS } = require('../utils/constants');

const router = express.Router();

router.use(authenticate);
router.use(requireActive);
router.use(requireSubscription);

/**
 * GET /api/matches
 * List all matches for the user
 */
router.get('/', async (req, res, next) => {
    try {
        const userId = req.user.id;
        const matches = await prisma.privateMatch.findMany({
            where: {
                OR: [{ userOneId: userId }, { userTwoId: userId }],
            },
            orderBy: { matchedAt: 'desc' },
            include: {
                userOne: { select: { id: true, displayName: true } },
                userTwo: { select: { id: true, displayName: true } },
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    select: { messageText: true, createdAt: true },
                },
            },
        });

        const formatted = matches.map((m) => {
            const partner = m.userOneId === userId ? m.userTwo : m.userOne;
            return {
                id: m.id,
                status: m.status,
                matchedAt: m.matchedAt,
                endedAt: m.endedAt,
                partner,
                lastMessage: m.messages[0] || null,
            };
        });

        res.json({ matches: formatted });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/matches/request
 * Request a private 1-on-1 match
 */
router.post('/request', requireNotSuspended, matchLimiter, async (req, res, next) => {
    try {
        const userId = req.user.id;

        // Check if user is already in an active match
        const activeMatch = await prisma.privateMatch.findFirst({
            where: {
                OR: [{ userOneId: userId }, { userTwoId: userId }],
                status: 'active',
            },
        });

        if (activeMatch) {
            return res.status(409).json({
                error: 'You are already in an active private chat',
                matchId: activeMatch.id,
            });
        }

        // Check cooldown after last match ended
        const lastMatch = await prisma.privateMatch.findFirst({
            where: {
                OR: [{ userOneId: userId }, { userTwoId: userId }],
                status: 'ended',
            },
            orderBy: { endedAt: 'desc' },
        });

        if (lastMatch && lastMatch.endedAt) {
            const cooldownEnd = new Date(lastMatch.endedAt.getTime() + MATCH_COOLDOWN_MS);
            if (new Date() < cooldownEnd) {
                const waitSeconds = Math.ceil((cooldownEnd - new Date()) / 1000);
                return res.status(429).json({
                    error: `Please wait ${waitSeconds} seconds before requesting another match`,
                    retryAfter: waitSeconds,
                });
            }
        }

        // Get user's intent tags for matching
        const userIntents = await prisma.userIntent.findMany({
            where: { userId },
            select: { intentTagId: true },
        });
        const intentTagIds = userIntents.map((ui) => ui.intentTagId);

        // Add user to Redis matchmaking queue
        const queueEntry = JSON.stringify({
            userId,
            intentTagIds,
            timestampJoined: Date.now(),
            lastMatchTime: lastMatch?.endedAt?.getTime() || 0,
        });

        await redis.zadd('matchmaking_queue', Date.now(), queueEntry);

        res.json({
            message: 'You are now in the matching queue',
            status: 'waiting',
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/matches/cancel
 * Cancel match request (remove from queue)
 */
router.post('/cancel', async (req, res, next) => {
    try {
        const userId = req.user.id;

        // Remove all entries for this user from the queue
        const queueEntries = await redis.zrange('matchmaking_queue', 0, -1);
        for (const entry of queueEntries) {
            const parsed = JSON.parse(entry);
            if (parsed.userId === userId) {
                await redis.zrem('matchmaking_queue', entry);
            }
        }

        res.json({ message: 'Match request cancelled' });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/matches/status
 * Check current match status
 */
router.get('/status', async (req, res, next) => {
    try {
        const userId = req.user.id;

        // Check if matched
        const activeMatch = await prisma.privateMatch.findFirst({
            where: {
                OR: [{ userOneId: userId }, { userTwoId: userId }],
                status: 'active',
            },
            select: {
                id: true,
                matchedAt: true,
                userOne: { select: { id: true, displayName: true } },
                userTwo: { select: { id: true, displayName: true } },
            },
        });

        if (activeMatch) {
            const partner = activeMatch.userOne.id === userId
                ? activeMatch.userTwo
                : activeMatch.userOne;

            return res.json({
                status: 'matched',
                matchId: activeMatch.id,
                partner: { id: partner.id, displayName: partner.displayName },
            });
        }

        // Check if in queue
        const queueEntries = await redis.zrange('matchmaking_queue', 0, -1);
        const inQueue = queueEntries.some((entry) => {
            const parsed = JSON.parse(entry);
            return parsed.userId === userId;
        });

        if (inQueue) {
            return res.json({ status: 'waiting' });
        }

        res.json({ status: 'idle' });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/matches/:matchId/end
 * End an active private chat
 */
router.post('/:matchId/end', async (req, res, next) => {
    try {
        const { matchId } = req.params;
        const userId = req.user.id;

        const match = await prisma.privateMatch.findFirst({
            where: {
                id: matchId,
                OR: [{ userOneId: userId }, { userTwoId: userId }],
                status: 'active',
            },
        });

        if (!match) {
            return res.status(404).json({ error: 'Active match not found' });
        }

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

        // Increment support sessions count for both users
        await prisma.user.updateMany({
            where: { id: { in: [match.userOneId, match.userTwoId] } },
            data: {
                supportSessionsCount: { increment: 1 },
                lastSupportSessionAt: now,
            },
        });

        res.json({ message: 'Chat ended', durationSeconds });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/matches/:matchId/messages
 * Get messages from a private match (paginated)
 */
router.get('/:matchId/messages', async (req, res, next) => {
    try {
        const { matchId } = req.params;
        const { cursor, limit = 50 } = req.query;
        const take = Math.min(parseInt(limit), 100);
        const userId = req.user.id;

        // Verify user is part of this match
        const match = await prisma.privateMatch.findFirst({
            where: {
                id: matchId,
                OR: [{ userOneId: userId }, { userTwoId: userId }],
            },
        });

        if (!match) {
            return res.status(404).json({ error: 'Match not found' });
        }

        const queryOptions = {
            where: { matchId },
            take,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                messageText: true,
                createdAt: true,
                sender: {
                    select: { id: true, displayName: true },
                },
            },
        };

        if (cursor) {
            queryOptions.skip = 1;
            queryOptions.cursor = { id: cursor };
        }

        const messages = await prisma.privateMessage.findMany(queryOptions);

        res.json({
            messages: messages.reverse(),
            nextCursor: messages.length === take ? messages[messages.length - 1]?.id : null,
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
