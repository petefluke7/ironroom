const express = require('express');
const prisma = require('../config/database');
const { authenticate } = require('../middleware/auth');

const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads');
        // Ensure directory exists
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // userId-timestamp.ext
        const ext = path.extname(file.originalname);
        cb(null, `${req.user.id}-${Date.now()}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('only images are allowed'));
        }
    }
});

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
                profilePictureUrl: true,
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
 * POST /api/profile/avatar
 * Upload profile picture
 */
router.post('/avatar', upload.single('avatar'), async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const profilePictureUrl = `/uploads/${req.file.filename}`;

        const user = await prisma.user.update({
            where: { id: req.user.id },
            data: { profilePictureUrl },
            select: {
                id: true,
                displayName: true,
                profilePictureUrl: true,
            }
        });

        res.json({ message: 'Profile picture updated', user });
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
