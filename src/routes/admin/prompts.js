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
 * GET /api/admin/prompts
 * List all vent prompts
 */
router.get('/', async (req, res, next) => {
    try {
        const prompts = await prisma.ventPrompt.findMany({
            orderBy: { createdAt: 'desc' },
        });
        res.json({ prompts });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/prompts
 * Create a vent prompt
 */
router.post('/', async (req, res, next) => {
    try {
        const { question } = req.body;
        if (!question) return res.status(400).json({ error: 'Question required' });

        const prompt = await prisma.ventPrompt.create({
            data: { question },
        });
        res.status(201).json({ prompt });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /api/admin/prompts/:id
 * Update a vent prompt
 */
router.put('/:id', async (req, res, next) => {
    try {
        const { question, isActive } = req.body;
        const updateData = {};
        if (question) updateData.question = question;
        if (typeof isActive === 'boolean') updateData.isActive = isActive;

        const prompt = await prisma.ventPrompt.update({
            where: { id: parseInt(req.params.id) },
            data: updateData,
        });
        res.json({ prompt });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /api/admin/prompts/:id
 * Delete a vent prompt
 */
router.delete('/:id', async (req, res, next) => {
    try {
        await prisma.ventPrompt.delete({
            where: { id: parseInt(req.params.id) },
        });
        res.json({ message: 'Prompt deleted' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
