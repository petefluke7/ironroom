const express = require('express');
const prisma = require('../config/database');
const { authenticate, requireActive, requireNotSuspended } = require('../middleware/auth');
const { requireSubscription } = require('../middleware/subscription');
const { matchLimiter } = require('../middleware/rateLimiter');
const { MATCH_COOLDOWN_MS, MATCH_SCORING } = require('../utils/constants');

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
 * Request a private 1-on-1 match.
 * Uses DB-based queue + scoring algorithm (same logic as original Redis worker).
 */
router.post('/request', requireNotSuspended, matchLimiter, async (req, res, next) => {
    try {
        const userId = req.user.id;

        // 1. Check if user is already in an active match
        const activeMatch = await prisma.privateMatch.findFirst({
            where: {
                OR: [{ userOneId: userId }, { userTwoId: userId }],
                status: 'active',
            },
            include: {
                userOne: { select: { id: true, displayName: true } },
                userTwo: { select: { id: true, displayName: true } },
            },
        });

        if (activeMatch) {
            const partner = activeMatch.userOneId === userId ? activeMatch.userTwo : activeMatch.userOne;
            return res.json({
                status: 'matched',
                matchId: activeMatch.id,
                partnerName: partner.displayName,
            });
        }

        // 2. Check cooldown after last match ended
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

        // 3. Get user's intent tags
        const userIntents = await prisma.userIntent.findMany({
            where: { userId },
            select: { intentTagId: true },
        });
        const myIntentTagIds = userIntents.map((ui) => String(ui.intentTagId));

        // 4. Check if already in queue
        const existing = await prisma.matchQueue.findUnique({ where: { userId } });
        if (!existing) {
            // Add to queue
            await prisma.matchQueue.create({
                data: { userId, intentTagIds: myIntentTagIds },
            });
        }

        // 5. Look for other waiting users (excluding self)
        const waitingUsers = await prisma.matchQueue.findMany({
            where: { userId: { not: userId } },
            include: { user: { select: { id: true, displayName: true, isSuspended: true } } },
        });

        if (waitingUsers.length === 0) {
            return res.json({ status: 'waiting', message: 'You are in the matching queue' });
        }

        // 6. Run scoring algorithm against all waiting users
        let bestMatch = null;
        let bestScore = -Infinity;

        for (const candidate of waitingUsers) {
            // Safety filter: skip suspended users
            if (candidate.user.isSuspended) continue;

            // Safety filter: check blocks
            const block = await prisma.blockedUser.findFirst({
                where: {
                    OR: [
                        { blockerId: userId, blockedId: candidate.userId },
                        { blockerId: candidate.userId, blockedId: userId },
                    ],
                },
            });
            if (block) continue;

            // Safety filter: check reports
            const report = await prisma.report.findFirst({
                where: {
                    OR: [
                        { reportedBy: userId, targetUserId: candidate.userId },
                        { reportedBy: candidate.userId, targetUserId: userId },
                    ],
                },
            });
            if (report) continue;

            // ─── SCORING ALGORITHM ───
            let score = 0;

            // Shared intent tags → +50
            const candidateIntents = candidate.intentTagIds || [];
            const sharedIntents = myIntentTagIds.filter((id) =>
                candidateIntents.includes(id)
            );
            if (sharedIntents.length > 0) {
                score += MATCH_SCORING.SHARED_INTENT;
            }

            // Time waiting bonus → +1 per 10 seconds
            const now = Date.now();
            const waitTimeMs = now - candidate.joinedAt.getTime();
            score += Math.floor(waitTimeMs / 10000) * MATCH_SCORING.TIME_WAITING_PER_10S;

            // Recent activity similarity → +10 if both joined within 2 minutes
            const myEntry = existing || { joinedAt: new Date() };
            const joinDiff = Math.abs(myEntry.joinedAt.getTime() - candidate.joinedAt.getTime());
            if (joinDiff < MATCH_SCORING.RECENT_ACTIVITY_WINDOW_MS) {
                score += MATCH_SCORING.RECENT_ACTIVITY;
            }

            // Conversation fatigue → -40 if matched within last 7 days
            const since = new Date();
            since.setDate(since.getDate() - MATCH_SCORING.FATIGUE_WINDOW_DAYS);
            const recentMatch = await prisma.privateMatch.findFirst({
                where: {
                    OR: [
                        { userOneId: userId, userTwoId: candidate.userId },
                        { userOneId: candidate.userId, userTwoId: userId },
                    ],
                    matchedAt: { gte: since },
                },
            });
            if (recentMatch) {
                score += MATCH_SCORING.CONVERSATION_FATIGUE;
            }

            console.log(`  Score for ${candidate.user.displayName}: ${score}`);

            if (score > bestScore) {
                bestScore = score;
                bestMatch = candidate;
            }
        }

        if (!bestMatch) {
            return res.json({ status: 'waiting', message: 'No compatible match found yet' });
        }

        // 7. Create the match
        const match = await prisma.privateMatch.create({
            data: {
                userOneId: userId,
                userTwoId: bestMatch.userId,
                status: 'active',
            },
        });

        // 8. Remove both users from queue
        await prisma.matchQueue.deleteMany({
            where: { userId: { in: [userId, bestMatch.userId] } },
        });

        console.log(`✅ Match created: ${userId} ↔ ${bestMatch.userId} (score: ${bestScore})`);

        // 9. Send push notifications to partner
        try {
            const { sendPushNotification } = require('../services/notificationService');
            await sendPushNotification(bestMatch.userId, {
                title: 'Match found!',
                body: 'You have been connected with someone ready to talk',
                data: { type: 'match_found', matchId: match.id },
            });
        } catch (err) {
            console.error('Push notification error:', err.message);
        }

        return res.json({
            status: 'matched',
            matchId: match.id,
            partnerName: bestMatch.user.displayName,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/matches/cancel
 * Cancel match request (remove from DB queue)
 */
router.post('/cancel', async (req, res, next) => {
    try {
        const userId = req.user.id;
        await prisma.matchQueue.deleteMany({ where: { userId } });
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
                partnerName: partner.displayName,
            });
        }

        // Check if in queue
        const inQueue = await prisma.matchQueue.findUnique({ where: { userId } });
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

/**
 * POST /api/matches/:matchId/messages
 * Send a message in a private match (HTTP fallback for WebSocket)
 */
router.post('/:matchId/messages', requireNotSuspended, async (req, res, next) => {
    try {
        const { matchId } = req.params;
        const { messageText } = req.body;
        const userId = req.user.id;

        if (!messageText || messageText.trim().length === 0) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }

        // Verify user is part of this active match
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

        const message = await prisma.privateMessage.create({
            data: {
                matchId,
                senderId: userId,
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

        res.status(201).json({ message });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
