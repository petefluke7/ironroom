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
 * GET /api/admin/rooms
 * List all rooms (including inactive)
 */
router.get('/', async (req, res, next) => {
    try {
        const rooms = await prisma.room.findMany({
            orderBy: { createdAt: 'asc' },
            select: {
                id: true,
                name: true,
                description: true,
                isActive: true,
                createdAt: true,
                _count: { select: { members: true, messages: true } },
            },
        });

        res.json({ rooms });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/rooms
 * Create a new room
 */
router.post('/', async (req, res, next) => {
    try {
        if (req.moderator.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { name, description } = req.body;

        if (!name || !description) {
            return res.status(400).json({ error: 'Name and description required' });
        }

        const room = await prisma.room.create({
            data: { name, description },
        });

        await prisma.auditLog.create({
            data: {
                moderatorId: req.moderator.id,
                action: 'create_room',
                metadata: { roomId: room.id, roomName: name },
            },
        });

        res.status(201).json({ message: 'Room created', room });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /api/admin/rooms/:id
 * Update a room
 */
router.put('/:id', async (req, res, next) => {
    try {
        if (req.moderator.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { name, description, isActive } = req.body;
        const updateData = {};
        if (name) updateData.name = name;
        if (description) updateData.description = description;
        if (typeof isActive === 'boolean') updateData.isActive = isActive;

        const room = await prisma.room.update({
            where: { id: req.params.id },
            data: updateData,
        });

        await prisma.auditLog.create({
            data: {
                moderatorId: req.moderator.id,
                action: 'update_room',
                metadata: { roomId: room.id, changes: updateData },
            },
        });

        res.json({ message: 'Room updated', room });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /api/admin/rooms/:id
 * Delete (deactivate) a room
 */
router.delete('/:id', async (req, res, next) => {
    try {
        if (req.moderator.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        await prisma.room.update({
            where: { id: req.params.id },
            data: { isActive: false },
        });

        await prisma.auditLog.create({
            data: {
                moderatorId: req.moderator.id,
                action: 'delete_room',
                metadata: { roomId: req.params.id },
            },
        });

        res.json({ message: 'Room deactivated' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
