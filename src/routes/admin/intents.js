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
 * GET /api/admin/intents
 * List all intent tags
 */
router.get('/', async (req, res, next) => {
    try {
        const tags = await prisma.intentTag.findMany({
            orderBy: { id: 'asc' },
            include: {
                _count: { select: { userIntents: true } },
            },
        });
        res.json({ tags });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/intents
 * Create a new intent tag
 */
router.post('/', async (req, res, next) => {
    try {
        const { tagName } = req.body;
        if (!tagName) return res.status(400).json({ error: 'Tag name required' });

        const tag = await prisma.intentTag.create({
            data: { tagName: tagName.toLowerCase().trim() },
        });
        res.status(201).json({ tag });
    } catch (error) {
        if (error.code === 'P2002') {
            return res.status(409).json({ error: 'Tag already exists' });
        }
        next(error);
    }
});

/**
 * PUT /api/admin/intents/:id
 * Update an intent tag
 */
router.put('/:id', async (req, res, next) => {
    try {
        const { tagName, isActive } = req.body;
        const updateData = {};
        if (tagName) updateData.tagName = tagName.toLowerCase().trim();
        if (typeof isActive === 'boolean') updateData.isActive = isActive;

        const tag = await prisma.intentTag.update({
            where: { id: parseInt(req.params.id) },
            data: updateData,
        });
        res.json({ tag });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /api/admin/intents/:id
 * Delete an intent tag (soft delete via isActive)
 */
router.delete('/:id', async (req, res, next) => {
    try {
        await prisma.intentTag.update({
            where: { id: parseInt(req.params.id) },
            data: { isActive: false },
        });
        res.json({ message: 'Intent tag deactivated' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
