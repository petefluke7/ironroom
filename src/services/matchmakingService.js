const { Worker, Queue } = require('bullmq');
const redis = require('../config/redis');
const prisma = require('../config/database');
const { MATCH_SCORING } = require('../utils/constants');

const matchmakingQueue = new Queue('matchmaking', { connection: redis });

/**
 * Matchmaking Worker
 * Runs every 3-5 seconds to pair users from the Redis queue
 * Scoring formula per document:
 *  - Shared intent: +50 points
 *  - Time waiting: +1 per 10 seconds
 *  - Recent activity: +10 if both joined within 2 minutes
 *  - Conversation fatigue: -40 if matched within last 7 days
 */
async function processMatchmakingQueue() {
    try {
        const entries = await redis.zrange('matchmaking_queue', 0, -1);

        if (entries.length < 2) return;

        const users = entries.map((e) => JSON.parse(e));
        const now = Date.now();

        let bestPair = null;
        let bestScore = -Infinity;

        // Compare all possible pairs
        for (let i = 0; i < users.length; i++) {
            for (let j = i + 1; j < users.length; j++) {
                const userA = users[i];
                const userB = users[j];

                // Safety filter: check blocks
                const isBlocked = await checkBlocked(userA.userId, userB.userId);
                if (isBlocked) continue;

                // Safety filter: check recent reports between them
                const hasReport = await checkReported(userA.userId, userB.userId);
                if (hasReport) continue;

                // Safety filter: check if either is suspended
                const eitherSuspended = await checkSuspended(userA.userId, userB.userId);
                if (eitherSuspended) continue;

                // Calculate score
                let score = 0;

                // Shared intent match
                const sharedIntents = userA.intentTagIds.filter((id) =>
                    userB.intentTagIds.includes(id)
                );
                if (sharedIntents.length > 0) {
                    score += MATCH_SCORING.SHARED_INTENT;
                }

                // Time waiting bonus
                const waitA = (now - userA.timestampJoined) / 1000;
                const waitB = (now - userB.timestampJoined) / 1000;
                score += Math.floor(waitA / 10) * MATCH_SCORING.TIME_WAITING_PER_10S;
                score += Math.floor(waitB / 10) * MATCH_SCORING.TIME_WAITING_PER_10S;

                // Recent activity similarity
                const joinDiff = Math.abs(userA.timestampJoined - userB.timestampJoined);
                if (joinDiff < MATCH_SCORING.RECENT_ACTIVITY_WINDOW_MS) {
                    score += MATCH_SCORING.RECENT_ACTIVITY;
                }

                // Conversation fatigue penalty
                const recentMatch = await checkRecentMatch(
                    userA.userId,
                    userB.userId,
                    MATCH_SCORING.FATIGUE_WINDOW_DAYS
                );
                if (recentMatch) {
                    score += MATCH_SCORING.CONVERSATION_FATIGUE;
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestPair = { userA, userB, score };
                }
            }
        }

        if (bestPair) {
            await createMatch(bestPair.userA, bestPair.userB);

            // Remove both from queue
            for (const entry of entries) {
                const parsed = JSON.parse(entry);
                if (parsed.userId === bestPair.userA.userId || parsed.userId === bestPair.userB.userId) {
                    await redis.zrem('matchmaking_queue', entry);
                }
            }

            console.log(`✅ Match created: ${bestPair.userA.userId} ↔ ${bestPair.userB.userId} (score: ${bestPair.score})`);
        }

        // Handle timeout: users waiting > 60s, expand criteria
        for (const user of users) {
            const waitTime = now - user.timestampJoined;
            if (waitTime > 120000) {
                // 2 minutes - notify user to try rooms
                // Remove from queue after notification
                for (const entry of entries) {
                    const parsed = JSON.parse(entry);
                    if (parsed.userId === user.userId) {
                        await redis.zrem('matchmaking_queue', entry);
                    }
                }

                const { sendPushNotification } = require('./notificationService');
                await sendPushNotification(user.userId, {
                    title: 'No match found yet',
                    body: 'While we search, you can join a room meantime.',
                    data: { type: 'match_timeout' },
                });
            }
        }
    } catch (error) {
        console.error('Matchmaking error:', error);
    }
}

async function createMatch(userA, userB) {
    const match = await prisma.privateMatch.create({
        data: {
            userOneId: userA.userId,
            userTwoId: userB.userId,
            status: 'active',
        },
    });

    // Notify both via WebSocket if connected
    try {
        const { getIO } = require('../websocket/chatServer');
        const io = getIO();

        const allSockets = await io.fetchSockets();
        for (const socket of allSockets) {
            if (socket.userId === userA.userId || socket.userId === userB.userId) {
                socket.emit('match_found', {
                    matchId: match.id,
                    message: 'You have been connected with someone ready to talk',
                });
            }
        }
    } catch (err) {
        console.log('WebSocket notification skipped:', err.message);
    }

    // Also send push notifications
    const { sendPushNotification } = require('./notificationService');
    await sendPushNotification(userA.userId, {
        title: 'Match found',
        body: 'You have been connected with someone ready to talk',
        data: { type: 'match_found', matchId: match.id },
    });
    await sendPushNotification(userB.userId, {
        title: 'Match found',
        body: 'You have been connected with someone ready to talk',
        data: { type: 'match_found', matchId: match.id },
    });

    return match;
}

async function checkBlocked(userAId, userBId) {
    const block = await prisma.blockedUser.findFirst({
        where: {
            OR: [
                { blockerId: userAId, blockedId: userBId },
                { blockerId: userBId, blockedId: userAId },
            ],
        },
    });
    return !!block;
}

async function checkReported(userAId, userBId) {
    const report = await prisma.report.findFirst({
        where: {
            OR: [
                { reportedBy: userAId, targetUserId: userBId },
                { reportedBy: userBId, targetUserId: userAId },
            ],
        },
    });
    return !!report;
}

async function checkSuspended(userAId, userBId) {
    const suspended = await prisma.user.findFirst({
        where: {
            id: { in: [userAId, userBId] },
            isSuspended: true,
        },
    });
    return !!suspended;
}

async function checkRecentMatch(userAId, userBId, daysBack) {
    const since = new Date();
    since.setDate(since.getDate() - daysBack);

    const match = await prisma.privateMatch.findFirst({
        where: {
            OR: [
                { userOneId: userAId, userTwoId: userBId },
                { userOneId: userBId, userTwoId: userAId },
            ],
            matchedAt: { gte: since },
        },
    });
    return !!match;
}

/**
 * Start the matchmaking worker loop
 */
function startMatchmakingWorker() {
    console.log('🎯 Matchmaking worker started');

    // Run every 3 seconds
    setInterval(async () => {
        await processMatchmakingQueue();
    }, 3000);
}

module.exports = { startMatchmakingWorker, processMatchmakingQueue };
