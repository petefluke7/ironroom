const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../../config/database');

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
 * GET /api/admin/reports
 * Get reports queue with filters
 */
router.get('/', async (req, res, next) => {
    try {
        const { status, type, page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const where = {};
        if (status) where.status = status;
        if (type === 'room') where.roomId = { not: null };
        if (type === 'private') where.privateMatchId = { not: null };

        const [reports, total] = await Promise.all([
            prisma.report.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true,
                    reason: true,
                    status: true,
                    messageId: true,
                    roomId: true,
                    privateMatchId: true,
                    createdAt: true,
                    reporter: { select: { id: true, displayName: true } },
                    targetUser: {
                        select: {
                            id: true,
                            displayName: true,
                            riskScore: true,
                        },
                    },
                },
            }),
            prisma.report.count({ where }),
        ]);

        res.json({
            reports,
            pagination: {
                total,
                page: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit)),
            },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/reports/:id
 * Get report detail with full context
 */
router.get('/:id', async (req, res, next) => {
    try {
        const report = await prisma.report.findUnique({
            where: { id: req.params.id },
            include: {
                reporter: { select: { id: true, displayName: true } },
                targetUser: {
                    select: {
                        id: true,
                        displayName: true,
                        identityMode: true,
                        riskScore: true,
                        createdAt: true,
                        lastLoginAt: true,
                        intents: {
                            include: { intentTag: { select: { tagName: true } } },
                        },
                        _count: {
                            select: {
                                reportsReceived: true,
                                warningsReceived: true,
                            },
                        },
                    },
                },
            },
        });

        if (!report) {
            return res.status(404).json({ error: 'Report not found' });
        }

        // Get conversation context if message was reported
        let messageContext = null;
        if (report.messageId) {
            // Check if it's a room message
            const roomMessage = await prisma.roomMessage.findUnique({
                where: { id: report.messageId },
                select: { messageText: true, createdAt: true, roomId: true },
            });

            if (roomMessage) {
                // Get surrounding messages for context
                const surrounding = await prisma.roomMessage.findMany({
                    where: {
                        roomId: roomMessage.roomId,
                        createdAt: {
                            gte: new Date(roomMessage.createdAt.getTime() - 5 * 60 * 1000),
                            lte: new Date(roomMessage.createdAt.getTime() + 5 * 60 * 1000),
                        },
                    },
                    orderBy: { createdAt: 'asc' },
                    select: {
                        id: true,
                        messageText: true,
                        createdAt: true,
                        sender: { select: { displayName: true } },
                    },
                    take: 20,
                });
                messageContext = { type: 'room', messages: surrounding, reported: roomMessage };
            } else {
                // Check private messages
                const privateMessage = await prisma.privateMessage.findUnique({
                    where: { id: report.messageId },
                    select: { messageText: true, createdAt: true, matchId: true },
                });

                if (privateMessage) {
                    const surrounding = await prisma.privateMessage.findMany({
                        where: {
                            matchId: privateMessage.matchId,
                            createdAt: {
                                gte: new Date(privateMessage.createdAt.getTime() - 5 * 60 * 1000),
                                lte: new Date(privateMessage.createdAt.getTime() + 5 * 60 * 1000),
                            },
                        },
                        orderBy: { createdAt: 'asc' },
                        select: {
                            id: true,
                            messageText: true,
                            createdAt: true,
                            sender: { select: { displayName: true } },
                        },
                        take: 20,
                    });
                    messageContext = { type: 'private', messages: surrounding, reported: privateMessage };
                }
            }
        }

        res.json({ report, messageContext });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /api/admin/reports/:id/resolve
 * Resolve a report with action
 */
router.put('/:id/resolve', async (req, res, next) => {
    try {
        const { action } = req.body; // 'mark_safe', 'warned', 'suspended', 'banned'

        await prisma.report.update({
            where: { id: req.params.id },
            data: { status: 'resolved' },
        });

        // Log action
        await prisma.auditLog.create({
            data: {
                moderatorId: req.moderator.id,
                action: `report_resolved_${action}`,
                reason: req.body.reason || null,
                metadata: { reportId: req.params.id },
            },
        });

        res.json({ message: 'Report resolved' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
