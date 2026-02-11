const express = require('express');
const prisma = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// All profile routes require authentication
router.use(authenticate);

/**
 * GET /api/profile
 * Get current user's profile
 */
router.get('/', async (req, res, next) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: {
                id: true,
                email: true,
                phoneNumber: true,
                displayName: true,
                identityMode: true,
                isActive: true,
                agreedToValues: true,
                createdAt: true,
                intents: {
                    include: { intentTag: { select: { id: true, tagName: true } } },
                },
                subscriptions: {
                    where: { isActive: true },
                    orderBy: { expiryDate: 'desc' },
                    take: 1,
                    select: {
                        planType: true,
                        platform: true,
                        expiryDate: true,
                        isActive: true,
                    },
                },
            },
        });

        res.json({ user });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /api/profile/update
 * Update display name and identity mode
 */
router.put('/update', async (req, res, next) => {
    try {
        const { displayName, identityMode } = req.body;

        const updateData = {};
        if (displayName) updateData.displayName = displayName;
        if (identityMode && ['real_name', 'first_name', 'nickname'].includes(identityMode)) {
            updateData.identityMode = identityMode;
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ error: 'Nothing to update' });
        }

        const user = await prisma.user.update({
            where: { id: req.user.id },
            data: updateData,
            select: {
                id: true,
                displayName: true,
                identityMode: true,
            },
        });

        res.json({ message: 'Profile updated', user });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /api/profile/fcm-token
 * Update FCM push notification token
 */
router.put('/fcm-token', async (req, res, next) => {
    try {
        const { fcmToken } = req.body;

        if (!fcmToken) {
            return res.status(400).json({ error: 'FCM token required' });
        }

        await prisma.user.update({
            where: { id: req.user.id },
            data: { fcmToken },
        });

        res.json({ message: 'FCM token updated' });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /api/profile
 * Delete account and all personal data (GDPR compliant)
 */
router.delete('/', async (req, res, next) => {
    try {
        const { confirmation } = req.body;

        if (confirmation !== 'DELETE_MY_ACCOUNT') {
            return res.status(400).json({
                error: 'Please send confirmation: "DELETE_MY_ACCOUNT" to proceed',
            });
        }

        // Cascade delete handles most relations
        // But we explicitly clear any data that might remain
        await prisma.$transaction([
            prisma.userIntent.deleteMany({ where: { userId: req.user.id } }),
            prisma.roomMember.deleteMany({ where: { userId: req.user.id } }),
            prisma.vent.deleteMany({ where: { userId: req.user.id } }),
            prisma.blockedUser.deleteMany({
                where: { OR: [{ blockerId: req.user.id }, { blockedId: req.user.id }] },
            }),
            prisma.user.delete({ where: { id: req.user.id } }),
        ]);

        res.json({ message: 'Account and all personal data deleted permanently' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
