const express = require('express');
const prisma = require('../config/database');
const { authenticate, requireActive, requireNotSuspended } = require('../middleware/auth');
const { requireSubscription } = require('../middleware/subscription');
const { VENT_AUTO_DELETE_OPTIONS } = require('../utils/constants');

const router = express.Router();

router.use(authenticate);
router.use(requireActive);

/**
 * GET /api/vents
 * Get user's private vents
 */
router.get('/', async (req, res, next) => {
    try {
        const vents = await prisma.vent.findMany({
            where: { userId: req.user.id },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                content: true,
                autoDeleteAt: true,
                createdAt: true,
            },
        });

        res.json({ vents });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/vents
 * Create a new vent entry
 */
router.post('/', requireSubscription, requireNotSuspended, async (req, res, next) => {
    try {
        const { content, autoDeleteOption } = req.body;

        if (!content || content.trim().length === 0) {
            return res.status(400).json({ error: 'Vent content cannot be empty' });
        }

        if (content.length > 5000) {
            return res.status(400).json({ error: 'Vent too long (max 5000 characters)' });
        }

        let autoDeleteAt = null;
        if (autoDeleteOption && autoDeleteOption !== 'keep') {
            const ms = VENT_AUTO_DELETE_OPTIONS[autoDeleteOption];
            if (!ms) {
                return res.status(400).json({
                    error: 'Invalid auto-delete option. Use: 24h, 72h, or keep',
                });
            }
            autoDeleteAt = new Date(Date.now() + ms);
        }

        const vent = await prisma.vent.create({
            data: {
                userId: req.user.id,
                content: content.trim(),
                autoDeleteAt,
            },
            select: {
                id: true,
                content: true,
                autoDeleteAt: true,
                createdAt: true,
            },
        });

        res.status(201).json({ vent });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /api/vents/:id
 * Delete a vent entry manually
 */
router.delete('/:id', async (req, res, next) => {
    try {
        const { id } = req.params;

        const vent = await prisma.vent.findFirst({
            where: { id, userId: req.user.id },
        });

        if (!vent) {
            return res.status(404).json({ error: 'Vent not found' });
        }

        await prisma.vent.delete({ where: { id } });

        res.json({ message: 'Vent deleted' });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/vents/prompts
 * Get active vent prompts
 */
router.get('/prompts', async (req, res, next) => {
    try {
        const prompts = await prisma.ventPrompt.findMany({
            where: { isActive: true },
            select: {
                id: true,
                question: true,
            },
            orderBy: { createdAt: 'desc' },
        });

        res.json({ prompts });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
