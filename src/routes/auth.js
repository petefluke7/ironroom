const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const firebaseAdmin = require('../config/firebase');
const { authLimiter } = require('../middleware/rateLimiter');
const { authenticate } = require('../middleware/auth');
const {
    validateEmail,
    validatePassword,
    validatePhoneNumber,
    PASSWORD_REQUIREMENTS,
} = require('../utils/validators');

const router = express.Router();

// Apply stricter rate limiting to auth routes
router.use(authLimiter);

/**
 * POST /api/auth/signup
 * Create a new account with email+password
 */
router.post('/signup', async (req, res, next) => {
    try {
        const { email, password, displayName, identityMode, deviceId } = req.body;

        if (!email || !password || !displayName || !identityMode) {
            return res.status(400).json({ error: 'Email, password, display name, and identity mode are required' });
        }

        if (!validateEmail(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        if (!validatePassword(password)) {
            return res.status(400).json({ error: PASSWORD_REQUIREMENTS });
        }

        if (!['real_name', 'first_name', 'nickname'].includes(identityMode)) {
            return res.status(400).json({ error: 'Invalid identity mode' });
        }

        // Check for existing user
        const existingUser = await prisma.user.findFirst({
            where: { email },
        });

        if (existingUser) {
            return res.status(409).json({ error: 'An account with this email already exists' });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const user = await prisma.user.create({
            data: {
                email,
                passwordHash,
                displayName,
                identityMode,
                deviceId: deviceId || null,
                isVerified: true, // Auto-verified for now (MVP)
                isActive: false, // Activated after subscription
            },
        });

        // Generate OTP-like verification (in production, send email)
        // For MVP, we'll use a simple 6-digit code stored temporarily
        // In production, integrate proper email verification service

        res.status(201).json({
            message: 'Account created. Please verify your email.',
            userId: user.id,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/auth/signup-phone
 * Create account using phone number (Firebase Auth handles OTP)
 */
router.post('/signup-phone', async (req, res, next) => {
    try {
        const { firebaseToken, displayName, identityMode, deviceId } = req.body;

        if (!firebaseToken || !displayName || !identityMode) {
            return res.status(400).json({ error: 'Firebase token, display name, and identity mode are required' });
        }

        // Verify Firebase token
        const decodedToken = await firebaseAdmin.auth().verifyIdToken(firebaseToken);
        const phoneNumber = decodedToken.phone_number;

        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number not found in token' });
        }

        // Check for existing user
        const existingUser = await prisma.user.findFirst({
            where: { phoneNumber },
        });

        if (existingUser) {
            return res.status(409).json({ error: 'An account with this phone number already exists' });
        }

        const user = await prisma.user.create({
            data: {
                phoneNumber,
                passwordHash: '', // No password for phone auth
                firebaseUid: decodedToken.uid,
                displayName,
                identityMode,
                deviceId: deviceId || null,
                isVerified: true, // Phone already verified via Firebase
                isActive: false,  // Activated after subscription
            },
        });

        // Generate JWT tokens
        const { accessToken, refreshToken } = generateTokens(user.id);

        res.status(201).json({
            message: 'Account created via phone.',
            userId: user.id,
            accessToken,
            refreshToken,
        });
    } catch (error) {
        if (error.code === 'auth/id-token-expired') {
            return res.status(401).json({ error: 'Firebase token expired' });
        }
        next(error);
    }
});

/**
 * POST /api/auth/login
 * Login with email+password
 */
router.post('/login', async (req, res, next) => {
    try {
        const { email, password, deviceId } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const user = await prisma.user.findUnique({ where: { email } });

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Check if device is banned
        if (deviceId) {
            const bannedDevice = await prisma.user.findFirst({
                where: {
                    deviceId,
                    isActive: false,
                    isSuspended: true,
                    suspendedUntil: null, // Permanent ban
                },
            });
            if (bannedDevice) {
                return res.status(403).json({ error: 'This device has been banned' });
            }
        }

        const passwordValid = await bcrypt.compare(password, user.passwordHash);
        if (!passwordValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (!user.isVerified) {
            return res.status(403).json({ error: 'Please verify your email first' });
        }

        // Update last login and device ID
        await prisma.user.update({
            where: { id: user.id },
            data: {
                lastLoginAt: new Date(),
                deviceId: deviceId || user.deviceId,
            },
        });

        const { accessToken, refreshToken } = generateTokens(user.id);

        res.json({
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                displayName: user.displayName,
                identityMode: user.identityMode,
                isActive: user.isActive,
                agreedToValues: user.agreedToValues,
            },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/auth/login-phone
 * Login with Firebase phone auth token
 */
router.post('/login-phone', async (req, res, next) => {
    try {
        const { firebaseToken, deviceId } = req.body;

        if (!firebaseToken) {
            return res.status(400).json({ error: 'Firebase token required' });
        }

        const decodedToken = await firebaseAdmin.auth().verifyIdToken(firebaseToken);
        const phoneNumber = decodedToken.phone_number;

        const user = await prisma.user.findUnique({ where: { phoneNumber } });

        if (!user) {
            return res.status(404).json({ error: 'No account found with this phone number' });
        }

        // Update last login
        await prisma.user.update({
            where: { id: user.id },
            data: {
                lastLoginAt: new Date(),
                deviceId: deviceId || user.deviceId,
            },
        });

        const { accessToken, refreshToken } = generateTokens(user.id);

        res.json({
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                displayName: user.displayName,
                identityMode: user.identityMode,
                isActive: user.isActive,
                agreedToValues: user.agreedToValues,
            },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token
 */
router.post('/refresh', async (req, res, next) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({ error: 'Refresh token required' });
        }

        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
        });

        if (!user) {
            return res.status(401).json({ error: 'Invalid refresh token' });
        }

        const tokens = generateTokens(user.id);

        res.json(tokens);
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Refresh token expired. Please login again.' });
        }
        next(error);
    }
});

/**
 * POST /api/auth/agree-to-values
 * Record community values agreement
 */
router.post('/agree-to-values', authenticate, async (req, res, next) => {
    try {
        await prisma.user.update({
            where: { id: req.user.id },
            data: {
                agreedToValues: true,
                agreedToValuesAt: new Date(),
            },
        });

        res.json({ message: 'Community values agreement recorded' });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/auth/set-intents
 * Set user intent tags (during onboarding or later)
 */
router.post('/set-intents', authenticate, async (req, res, next) => {
    try {
        const { intentTagIds } = req.body;

        if (!Array.isArray(intentTagIds) || intentTagIds.length < 2) {
            return res.status(400).json({ error: 'Please select at least 2 intent tags' });
        }

        if (intentTagIds.length > 4) {
            return res.status(400).json({ error: 'Maximum 4 intent tags allowed' });
        }

        // Verify all tags exist
        const validTags = await prisma.intentTag.findMany({
            where: { id: { in: intentTagIds }, isActive: true },
        });

        if (validTags.length !== intentTagIds.length) {
            return res.status(400).json({ error: 'One or more invalid intent tags' });
        }

        // Remove existing intents and set new ones
        await prisma.$transaction([
            prisma.userIntent.deleteMany({ where: { userId: req.user.id } }),
            ...intentTagIds.map((tagId) =>
                prisma.userIntent.create({
                    data: {
                        userId: req.user.id,
                        intentTagId: tagId,
                    },
                })
            ),
        ]);

        res.json({ message: 'Intent tags updated', tags: validTags });
    } catch (error) {
        next(error);
    }
});

// ─── Helper Functions ─────────────────────────

function generateTokens(userId) {
    const accessToken = jwt.sign(
        { userId },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_ACCESS_EXPIRY || '15m' }
    );

    const refreshToken = jwt.sign(
        { userId },
        process.env.JWT_REFRESH_SECRET,
        { expiresIn: process.env.JWT_REFRESH_EXPIRY || '7d' }
    );

    return { accessToken, refreshToken };
}

module.exports = router;
