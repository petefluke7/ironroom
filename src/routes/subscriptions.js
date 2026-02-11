const express = require('express');
const prisma = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

/**
 * POST /api/subscriptions/verify-purchase
 * Verify an in-app purchase and activate subscription
 */
router.post('/verify-purchase', async (req, res, next) => {
    try {
        const { platform, transactionId, planType, purchaseToken } = req.body;

        if (!platform || !transactionId || !planType) {
            return res.status(400).json({ error: 'Platform, transaction ID, and plan type are required' });
        }

        if (!['apple', 'google'].includes(platform)) {
            return res.status(400).json({ error: 'Invalid platform. Use: apple or google' });
        }

        if (!['monthly', 'yearly'].includes(planType)) {
            return res.status(400).json({ error: 'Invalid plan type. Use: monthly or yearly' });
        }

        // TODO: In production, verify with Apple/Google servers
        // Apple: Verify receipt with App Store Server API
        // Google: Verify with Google Play Developer API using purchaseToken
        //
        // For MVP development/testing, we accept the purchase directly.
        // Production implementation requires:
        // - Apple: https://developer.apple.com/documentation/appstoreserverapi
        // - Google: https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions

        // Check for duplicate transaction
        const existing = await prisma.subscription.findFirst({
            where: { transactionId },
        });

        if (existing) {
            return res.status(409).json({ error: 'This transaction has already been processed' });
        }

        // Calculate expiry based on plan type
        const now = new Date();
        const expiryDate = new Date(now);
        if (planType === 'monthly') {
            expiryDate.setMonth(expiryDate.getMonth() + 1);
        } else {
            expiryDate.setFullYear(expiryDate.getFullYear() + 1);
        }

        // Deactivate any existing active subscriptions
        await prisma.subscription.updateMany({
            where: { userId: req.user.id, isActive: true },
            data: { isActive: false },
        });

        // Create new subscription
        const subscription = await prisma.subscription.create({
            data: {
                userId: req.user.id,
                planType,
                platform,
                startDate: now,
                expiryDate,
                transactionId,
                isActive: true,
            },
        });

        // Activate user account if not already active
        await prisma.user.update({
            where: { id: req.user.id },
            data: { isActive: true },
        });

        res.json({
            message: 'Subscription activated',
            subscription: {
                planType: subscription.planType,
                startDate: subscription.startDate,
                expiryDate: subscription.expiryDate,
            },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/subscriptions/status
 * Get current subscription status
 */
router.get('/status', async (req, res, next) => {
    try {
        const subscription = await prisma.subscription.findFirst({
            where: { userId: req.user.id, isActive: true },
            orderBy: { expiryDate: 'desc' },
        });

        if (!subscription) {
            return res.json({
                hasActiveSubscription: false,
                message: 'No active subscription',
            });
        }

        const isExpired = new Date() > subscription.expiryDate;
        const gracePeriodEnd = new Date(subscription.expiryDate);
        gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 3);
        const inGracePeriod = isExpired && new Date() <= gracePeriodEnd;

        res.json({
            hasActiveSubscription: !isExpired || inGracePeriod,
            subscription: {
                planType: subscription.planType,
                platform: subscription.platform,
                startDate: subscription.startDate,
                expiryDate: subscription.expiryDate,
                isExpired,
                inGracePeriod,
            },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/subscriptions/restore
 * Restore a previous purchase
 */
router.post('/restore', async (req, res, next) => {
    try {
        const { platform, purchaseToken } = req.body;

        // TODO: In production, verify restored purchase with Apple/Google
        // For now, check if there's a valid subscription for this user on this platform

        const subscription = await prisma.subscription.findFirst({
            where: {
                userId: req.user.id,
                platform,
                expiryDate: { gte: new Date() },
            },
            orderBy: { expiryDate: 'desc' },
        });

        if (!subscription) {
            return res.status(404).json({ error: 'No restorable purchase found' });
        }

        // Reactivate
        await prisma.subscription.update({
            where: { id: subscription.id },
            data: { isActive: true },
        });

        await prisma.user.update({
            where: { id: req.user.id },
            data: { isActive: true },
        });

        res.json({
            message: 'Purchase restored',
            subscription: {
                planType: subscription.planType,
                expiryDate: subscription.expiryDate,
            },
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
