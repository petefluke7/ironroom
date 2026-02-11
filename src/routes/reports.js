const express = require('express');
const prisma = require('../config/database');
const { authenticate, requireNotSuspended } = require('../middleware/auth');
const { REPORT_REASONS } = require('../utils/constants');

const router = express.Router();

router.use(authenticate);

/**
 * POST /api/reports
 * Report a message or user
 */
router.post('/', requireNotSuspended, async (req, res, next) => {
    try {
        const { targetUserId, messageId, roomId, privateMatchId, reason } = req.body;

        if (!targetUserId || !reason) {
            return res.status(400).json({ error: 'Target user and reason are required' });
        }

        if (!REPORT_REASONS.includes(reason)) {
            return res.status(400).json({
                error: `Invalid reason. Use: ${REPORT_REASONS.join(', ')}`,
            });
        }

        // Can't report yourself
        if (targetUserId === req.user.id) {
            return res.status(400).json({ error: 'You cannot report yourself' });
        }

        // Check target user exists
        const targetUser = await prisma.user.findUnique({ where: { id: targetUserId } });
        if (!targetUser) {
            return res.status(404).json({ error: 'Target user not found' });
        }

        const report = await prisma.report.create({
            data: {
                reportedBy: req.user.id,
                targetUserId,
                messageId: messageId || null,
                roomId: roomId || null,
                privateMatchId: privateMatchId || null,
                reason,
            },
        });

        // Update target user's risk score
        await prisma.user.update({
            where: { id: targetUserId },
            data: { riskScore: { increment: 5 } },
        });

        // Check for auto-flag trigger: multiple reports on same user
        const recentReportCount = await prisma.report.count({
            where: {
                targetUserId,
                createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            },
        });

        // If 3+ reports in 24 hours, auto-escalate risk
        if (recentReportCount >= 3) {
            await prisma.user.update({
                where: { id: targetUserId },
                data: { riskScore: { increment: 20 } },
            });
        }

        res.status(201).json({ message: 'Report submitted', reportId: report.id });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/reports/block
 * Block a user
 */
router.post('/block', async (req, res, next) => {
    try {
        const { targetUserId } = req.body;

        if (!targetUserId) {
            return res.status(400).json({ error: 'Target user ID required' });
        }

        if (targetUserId === req.user.id) {
            return res.status(400).json({ error: 'You cannot block yourself' });
        }

        // Check if already blocked
        const existing = await prisma.blockedUser.findUnique({
            where: {
                blockerId_blockedId: { blockerId: req.user.id, blockedId: targetUserId },
            },
        });

        if (existing) {
            return res.json({ message: 'User already blocked' });
        }

        await prisma.blockedUser.create({
            data: {
                blockerId: req.user.id,
                blockedId: targetUserId,
            },
        });

        // Update risk score for blocked user (multiple blocks = red flag)
        await prisma.user.update({
            where: { id: targetUserId },
            data: { riskScore: { increment: 3 } },
        });

        // If user is in active match with this person, end it
        const activeMatch = await prisma.privateMatch.findFirst({
            where: {
                OR: [
                    { userOneId: req.user.id, userTwoId: targetUserId },
                    { userOneId: targetUserId, userTwoId: req.user.id },
                ],
                status: 'active',
            },
        });

        if (activeMatch) {
            await prisma.privateMatch.update({
                where: { id: activeMatch.id },
                data: { status: 'blocked', endedAt: new Date() },
            });
        }

        res.json({ message: 'User blocked' });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/reports/unblock
 * Unblock a user
 */
router.post('/unblock', async (req, res, next) => {
    try {
        const { targetUserId } = req.body;

        await prisma.blockedUser.deleteMany({
            where: { blockerId: req.user.id, blockedId: targetUserId },
        });

        res.json({ message: 'User unblocked' });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/reports/blocked
 * Get list of blocked users
 */
router.get('/blocked', async (req, res, next) => {
    try {
        const blockedUsers = await prisma.blockedUser.findMany({
            where: { blockerId: req.user.id },
            select: {
                blocked: {
                    select: { id: true, displayName: true },
                },
                createdAt: true,
            },
        });

        res.json({ blockedUsers });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
