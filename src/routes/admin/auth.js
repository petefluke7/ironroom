const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const prisma = require('../../config/database');

const router = express.Router();

/**
 * POST /api/admin/auth/login
 * Admin/Moderator login with email + password
 */
router.post('/login', async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const moderator = await prisma.moderator.findUnique({ where: { email } });

        if (!moderator || !moderator.isActive) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const valid = await bcrypt.compare(password, moderator.passwordHash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // If TOTP is enabled, require 2FA code
        if (moderator.isTotpEnabled) {
            // Return partial auth - client must provide TOTP code
            const tempToken = jwt.sign(
                { moderatorId: moderator.id, requires2fa: true },
                process.env.JWT_SECRET,
                { expiresIn: '5m' }
            );

            return res.json({
                requires2fa: true,
                tempToken,
            });
        }

        // No 2FA yet — issue full token
        const token = jwt.sign(
            { moderatorId: moderator.id, role: moderator.role },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.json({
            token,
            moderator: {
                id: moderator.id,
                name: moderator.name,
                email: moderator.email,
                role: moderator.role,
            },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/auth/verify-2fa
 * Verify TOTP code after initial login
 */
router.post('/verify-2fa', async (req, res, next) => {
    try {
        const { tempToken, totpCode } = req.body;

        if (!tempToken || !totpCode) {
            return res.status(400).json({ error: 'Temp token and TOTP code required' });
        }

        const decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
        if (!decoded.requires2fa) {
            return res.status(400).json({ error: 'Invalid temp token' });
        }

        const moderator = await prisma.moderator.findUnique({
            where: { id: decoded.moderatorId },
        });

        if (!moderator) {
            return res.status(401).json({ error: 'Moderator not found' });
        }

        const verified = speakeasy.totp.verify({
            secret: moderator.totpSecret,
            encoding: 'base32',
            token: totpCode,
            window: 1,
        });

        if (!verified) {
            return res.status(401).json({ error: 'Invalid 2FA code' });
        }

        const token = jwt.sign(
            { moderatorId: moderator.id, role: moderator.role },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.json({
            token,
            moderator: {
                id: moderator.id,
                name: moderator.name,
                email: moderator.email,
                role: moderator.role,
            },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/auth/setup-2fa
 * Generate TOTP secret and QR code for 2FA setup
 * Requires admin auth
 */
router.post('/setup-2fa', async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'Auth required' });

        const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
        const moderator = await prisma.moderator.findUnique({
            where: { id: decoded.moderatorId },
        });

        if (!moderator) return res.status(401).json({ error: 'Not found' });

        const secret = speakeasy.generateSecret({
            name: `IronRoom Admin (${moderator.email})`,
            issuer: process.env.ADMIN_TOTP_ISSUER || 'IronRoom Admin',
        });

        // Save secret temporarily (will be confirmed on first successful verify)
        await prisma.moderator.update({
            where: { id: moderator.id },
            data: { totpSecret: secret.base32 },
        });

        const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);

        res.json({
            secret: secret.base32,
            qrCode: qrCodeUrl,
            message: 'Scan the QR code with your authenticator app, then confirm with /confirm-2fa',
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/auth/confirm-2fa
 * Confirm 2FA setup with a valid code
 */
router.post('/confirm-2fa', async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'Auth required' });

        const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
        const { totpCode } = req.body;

        const moderator = await prisma.moderator.findUnique({
            where: { id: decoded.moderatorId },
        });

        if (!moderator?.totpSecret) {
            return res.status(400).json({ error: 'Setup 2FA first' });
        }

        const verified = speakeasy.totp.verify({
            secret: moderator.totpSecret,
            encoding: 'base32',
            token: totpCode,
            window: 1,
        });

        if (!verified) {
            return res.status(400).json({ error: 'Invalid code. Try again.' });
        }

        await prisma.moderator.update({
            where: { id: moderator.id },
            data: { isTotpEnabled: true },
        });

        res.json({ message: '2FA enabled successfully' });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/auth/create
 * Create a new moderator account (admin only)
 */
router.post('/create', async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'Auth required' });

        const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { email, password, name, role } = req.body;

        if (!email || !password || !name) {
            return res.status(400).json({ error: 'Email, password, and name required' });
        }

        const existing = await prisma.moderator.findUnique({ where: { email } });
        if (existing) {
            return res.status(409).json({ error: 'Moderator with this email already exists' });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const moderator = await prisma.moderator.create({
            data: {
                email,
                passwordHash,
                name,
                role: role === 'admin' ? 'admin' : 'moderator',
            },
        });

        res.status(201).json({
            message: 'Moderator created',
            moderator: {
                id: moderator.id,
                email: moderator.email,
                name: moderator.name,
                role: moderator.role,
            },
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
