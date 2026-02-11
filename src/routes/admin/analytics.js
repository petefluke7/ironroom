const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../../config/database');

const router = express.Router();

// Admin auth middleware (admin role required)
const adminAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'Auth required' });

        const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
        const moderator = await prisma.moderator.findUnique({
            where: { id: decoded.moderatorId },
        });

        if (!moderator || !moderator.isActive) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        req.moderator = moderator;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

router.use(adminAuth);

/**
 * GET /api/admin/analytics/dashboard
 * Main dashboard stats
 */
router.get('/dashboard', async (req, res, next) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [
            totalUsers,
            newUsersToday,
            activeUsers,
            openReports,
            suspendedUsersToday,
            activePrivateChats,
            totalRooms,
        ] = await Promise.all([
            prisma.user.count(),
            prisma.user.count({ where: { createdAt: { gte: today } } }),
            prisma.user.count({ where: { isActive: true } }),
            prisma.report.count({ where: { status: 'pending' } }),
            prisma.user.count({
                where: {
                    isSuspended: true,
                    updatedAt: { gte: today },
                },
            }),
            prisma.privateMatch.count({ where: { status: 'active' } }),
            prisma.room.count({ where: { isActive: true } }),
        ]);

        res.json({
            totalUsers,
            newUsersToday,
            activeUsers,
            openReports,
            suspendedUsersToday,
            activePrivateChats,
            totalRooms,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/analytics/moderation-summary
 * Daily moderation performance summary
 */
router.get('/moderation-summary', async (req, res, next) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [
            reportsReviewed,
            suspensionsIssued,
            bansIssued,
            warningsIssued,
            totalReportsToday,
        ] = await Promise.all([
            prisma.auditLog.count({
                where: {
                    action: { startsWith: 'report_resolved' },
                    createdAt: { gte: today },
                },
            }),
            prisma.auditLog.count({
                where: { action: 'suspend', createdAt: { gte: today } },
            }),
            prisma.auditLog.count({
                where: { action: 'permanent_ban', createdAt: { gte: today } },
            }),
            prisma.auditLog.count({
                where: { action: 'warn', createdAt: { gte: today } },
            }),
            prisma.report.count({
                where: { createdAt: { gte: today } },
            }),
        ]);

        const falseReportRate = totalReportsToday > 0
            ? await prisma.auditLog.count({
                where: {
                    action: 'report_resolved_mark_safe',
                    createdAt: { gte: today },
                },
            }) / totalReportsToday
            : 0;

        res.json({
            reportsReviewed,
            suspensionsIssued,
            bansIssued,
            warningsIssued,
            falseReportRate: Math.round(falseReportRate * 100) + '%',
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/analytics/matchmaking
 * Matchmaking quality metrics
 */
router.get('/matchmaking', async (req, res, next) => {
    try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const completedMatches = await prisma.privateMatch.findMany({
            where: {
                status: 'ended',
                matchedAt: { gte: sevenDaysAgo },
                durationSeconds: { not: null },
            },
            select: { durationSeconds: true },
        });

        const totalMatches = completedMatches.length;
        const avgDuration = totalMatches > 0
            ? Math.round(completedMatches.reduce((sum, m) => sum + m.durationSeconds, 0) / totalMatches)
            : 0;
        const avgDurationMinutes = Math.round(avgDuration / 60 * 10) / 10;

        // Matches lasting > 8 minutes (quality indicator per document)
        const qualityMatches = completedMatches.filter((m) => m.durationSeconds > 480).length;
        const qualityRate = totalMatches > 0
            ? Math.round((qualityMatches / totalMatches) * 100)
            : 0;

        res.json({
            totalMatchesLast7Days: totalMatches,
            averageDurationSeconds: avgDuration,
            averageDurationMinutes: avgDurationMinutes,
            qualityMatchRate: qualityRate + '%',
            qualityThreshold: '8 minutes',
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
