const prisma = require('../config/database');

/**
 * Subscription Guard Middleware
 * Checks if user has an active subscription before allowing access
 * Grace period: 3 days after expiry
 */
const requireSubscription = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const gracePeriodDays = 3;
        const graceDate = new Date();
        graceDate.setDate(graceDate.getDate() - gracePeriodDays);

        const activeSubscription = await prisma.subscription.findFirst({
            where: {
                userId,
                isActive: true,
                expiryDate: { gte: graceDate },
            },
            orderBy: { expiryDate: 'desc' },
        });

        if (!activeSubscription) {
            return res.status(402).json({
                error: 'Active subscription required',
                message: 'Please subscribe to access this feature.',
            });
        }

        // Check if past expiry but within grace period
        if (activeSubscription.expiryDate < new Date()) {
            req.subscriptionGrace = true;
        }

        req.subscription = activeSubscription;
        next();
    } catch (error) {
        next(error);
    }
};

module.exports = { requireSubscription };
