const jwt = require('jsonwebtoken');
const prisma = require('../config/database');

/**
 * JWT Authentication Middleware
 * Verifies access token and attaches user to request
 */
const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Access token required' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: {
                id: true,
                email: true,
                phoneNumber: true,
                displayName: true,
                identityMode: true,
                isActive: true,
                isSuspended: true,
                suspendedUntil: true,
                isVerified: true,
                agreedToValues: true,
            },
        });

        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }

        if (!user.isActive) {
            return res.status(403).json({ error: 'Account is deactivated' });
        }

        if (user.isSuspended) {
            if (user.suspendedUntil && new Date() < user.suspendedUntil) {
                return res.status(403).json({
                    error: 'Account is temporarily suspended',
                    suspendedUntil: user.suspendedUntil,
                });
            }
            // Suspension expired, reactivate
            await prisma.user.update({
                where: { id: user.id },
                data: { isSuspended: false, suspendedUntil: null },
            });
            user.isSuspended = false;
        }

        req.user = user;
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ error: 'Invalid token' });
        }
        next(error);
    }
};

/**
 * Middleware to check user is not suspended for write operations
 */
const requireNotSuspended = (req, res, next) => {
    if (req.user.isSuspended) {
        return res.status(403).json({
            error: 'Your account is suspended. You can read content but cannot post.',
        });
    }
    next();
};

module.exports = { authenticate, requireNotSuspended };
