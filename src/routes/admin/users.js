const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../../config/database');
const { SUSPENSION_DURATIONS, WARNINGS_AUTO_REVIEW_THRESHOLD, WARNINGS_REVIEW_WINDOW_DAYS } = require('../../utils/constants');
const { sendPushNotification } = require('../../services/notificationService');
const { recalculateRiskScore, getRiskLevel } = require('../../services/riskScoringService');

const router = express.Router();

// Admin auth middleware
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
 * GET /api/admin/users/search
 * Search users by name, email, or phone
 */
router.get('/search', async (req, res, next) => {
    try {
        const { q, page = 1, limit = 20 } = req.query;

        if (!q || q.length < 2) {
            return res.status(400).json({ error: 'Search query must be at least 2 characters' });
        }

        const where = {
            OR: [
                { displayName: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
                { phoneNumber: { contains: q } },
            ],
        };

        const [users, total] = await Promise.all([
            prisma.user.findMany({
                where,
                skip: (parseInt(page) - 1) * parseInt(limit),
                take: parseInt(limit),
                select: {
                    id: true,
                    displayName: true,
                    email: true,
                    phoneNumber: true,
                    riskScore: true,
                    isSuspended: true,
                    isActive: true,
                    createdAt: true,
                },
            }),
            prisma.user.count({ where }),
        ]);

        res.json({
            users: users.map((u) => ({
                ...u,
                riskLevel: getRiskLevel(u.riskScore),
            })),
            pagination: { total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/users/high-risk
 * Get high-risk users for priority review
 */
router.get('/high-risk', async (req, res, next) => {
    try {
        const users = await prisma.user.findMany({
            where: { riskScore: { gte: 30 } },
            orderBy: { riskScore: 'desc' },
            take: 50,
            select: {
                id: true,
                displayName: true,
                riskScore: true,
                isSuspended: true,
                createdAt: true,
                _count: {
                    select: { reportsReceived: true, warningsReceived: true },
                },
            },
        });

        res.json({ users });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/users/:id
 * Get detailed user profile for moderation
 */
router.get('/:id', async (req, res, next) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.params.id },
            select: {
                id: true,
                displayName: true,
                email: true,
                phoneNumber: true,
                identityMode: true,
                riskScore: true,
                isSuspended: true,
                suspendedUntil: true,
                isActive: true,
                createdAt: true,
                lastLoginAt: true,
                supportSessionsCount: true,
                intents: {
                    include: { intentTag: { select: { tagName: true } } },
                },
                _count: {
                    select: {
                        reportsReceived: true,
                        warningsReceived: true,
                        roomMemberships: true,
                        privateMatchesAsOne: true,
                        privateMatchesAsTwo: true,
                    },
                },
            },
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Get recent warnings
        const warnings = await prisma.warning.findMany({
            where: { userId: req.params.id },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: { id: true, reason: true, message: true, createdAt: true },
        });

        // Get reports history
        const reports = await prisma.report.findMany({
            where: { targetUserId: req.params.id },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: { id: true, reason: true, status: true, createdAt: true },
        });

        // Get moderator notes
        const notes = await prisma.moderatorNote.findMany({
            where: { userId: req.params.id },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                content: true,
                createdAt: true,
                moderator: { select: { name: true } },
            },
        });

        res.json({
            user: { ...user, riskLevel: getRiskLevel(user.riskScore) },
            warnings,
            reports,
            notes,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/users/:id/warn
 * Issue a warning to a user
 */
router.post('/:id/warn', async (req, res, next) => {
    try {
        const { reason } = req.body;
        const userId = req.params.id;

        if (!reason) {
            return res.status(400).json({ error: 'Reason required' });
        }

        const warningMessage = 'A reminder to keep conversations respectful. Please review community guidelines.';

        await prisma.warning.create({
            data: {
                userId,
                issuedBy: req.moderator.id,
                reason,
                message: warningMessage,
            },
        });

        // Recalculate risk score
        await recalculateRiskScore(userId);

        // Check auto-review threshold
        const recentWarnings = await prisma.warning.count({
            where: {
                userId,
                createdAt: {
                    gte: new Date(Date.now() - WARNINGS_REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000),
                },
            },
        });

        let autoReview = false;
        if (recentWarnings >= WARNINGS_AUTO_REVIEW_THRESHOLD) {
            autoReview = true;
        }

        // Send push notification to user
        await sendPushNotification(userId, {
            title: 'Community notice',
            body: warningMessage,
            data: { type: 'warning' },
        });

        // Audit log
        await prisma.auditLog.create({
            data: {
                moderatorId: req.moderator.id,
                action: 'warn',
                targetUserId: userId,
                reason,
            },
        });

        res.json({
            message: 'Warning issued',
            autoReviewTriggered: autoReview,
            totalRecentWarnings: recentWarnings,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/users/:id/suspend
 * Temporarily suspend a user
 */
router.post('/:id/suspend', async (req, res, next) => {
    try {
        const { duration, reason } = req.body;
        const userId = req.params.id;

        if (!duration || !SUSPENSION_DURATIONS[duration]) {
            return res.status(400).json({
                error: `Invalid duration. Use: ${Object.keys(SUSPENSION_DURATIONS).join(', ')}`,
            });
        }

        const suspendedUntil = new Date(Date.now() + SUSPENSION_DURATIONS[duration]);

        await prisma.user.update({
            where: { id: userId },
            data: { isSuspended: true, suspendedUntil },
        });

        await recalculateRiskScore(userId);

        // Send notification
        await sendPushNotification(userId, {
            title: 'Account suspended',
            body: `Your account has been temporarily suspended until ${suspendedUntil.toISOString()}`,
            data: { type: 'suspension' },
        });

        // Audit log
        await prisma.auditLog.create({
            data: {
                moderatorId: req.moderator.id,
                action: 'suspend',
                targetUserId: userId,
                reason: reason || `Suspended for ${duration}`,
                metadata: { duration, suspendedUntil: suspendedUntil.toISOString() },
            },
        });

        res.json({ message: `User suspended until ${suspendedUntil.toISOString()}` });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/users/:id/ban
 * Permanently ban a user (admin only)
 */
router.post('/:id/ban', async (req, res, next) => {
    try {
        if (req.moderator.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required for permanent bans' });
        }

        const { reason } = req.body;
        const userId = req.params.id;

        // Get device ID before banning
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { deviceId: true },
        });

        await prisma.user.update({
            where: { id: userId },
            data: {
                isActive: false,
                isSuspended: true,
                suspendedUntil: null, // null = permanent
            },
        });

        // Audit log
        await prisma.auditLog.create({
            data: {
                moderatorId: req.moderator.id,
                action: 'permanent_ban',
                targetUserId: userId,
                reason: reason || 'Permanent ban',
                metadata: { deviceId: user?.deviceId },
            },
        });

        res.json({ message: 'User permanently banned' });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/users/:id/notes
 * Add a moderator note on a user
 */
router.post('/:id/notes', async (req, res, next) => {
    try {
        const { content } = req.body;

        if (!content) {
            return res.status(400).json({ error: 'Note content required' });
        }

        const note = await prisma.moderatorNote.create({
            data: {
                moderatorId: req.moderator.id,
                userId: req.params.id,
                content,
            },
        });

        res.status(201).json({ message: 'Note added', note });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/users/:id/conversations
 * View user's conversation history (for investigation)
 */
router.get('/:id/conversations', async (req, res, next) => {
    try {
        const userId = req.params.id;
        const { type } = req.query;

        const result = {};

        if (!type || type === 'rooms') {
            result.roomMessages = await prisma.roomMessage.findMany({
                where: { senderId: userId, isFlagged: true },
                orderBy: { createdAt: 'desc' },
                take: 50,
                select: {
                    id: true,
                    messageText: true,
                    createdAt: true,
                    room: { select: { name: true } },
                },
            });
        }

        if (!type || type === 'private') {
            result.privateMessages = await prisma.privateMessage.findMany({
                where: { senderId: userId, isFlagged: true },
                orderBy: { createdAt: 'desc' },
                take: 50,
                select: {
                    id: true,
                    messageText: true,
                    createdAt: true,
                },
            });
        }

        if (!type || type === 'vents') {
            // Vents: count only, content hidden for privacy
            result.ventCount = await prisma.vent.count({ where: { userId } });
        }

        res.json(result);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
