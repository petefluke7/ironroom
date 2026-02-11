const prisma = require('../config/database');
const { SUBSCRIPTION_GRACE_DAYS } = require('../utils/constants');

/**
 * Subscription Validator Worker
 * Checks for expired subscriptions and deactivates access
 */
async function validateSubscriptions() {
    try {
        const now = new Date();
        const graceDate = new Date(now);
        graceDate.setDate(graceDate.getDate() - SUBSCRIPTION_GRACE_DAYS);

        // Find expired subscriptions past grace period
        const expiredSubs = await prisma.subscription.findMany({
            where: {
                isActive: true,
                expiryDate: { lt: graceDate },
            },
            select: { id: true, userId: true },
        });

        if (expiredSubs.length > 0) {
            // Deactivate subscriptions
            const subIds = expiredSubs.map((s) => s.id);
            await prisma.subscription.updateMany({
                where: { id: { in: subIds } },
                data: { isActive: false },
            });

            // Deactivate user accounts (they can still login but can't access features)
            const userIds = [...new Set(expiredSubs.map((s) => s.userId))];

            // Only deactivate users who have no other active subscription
            for (const userId of userIds) {
                const otherActiveSub = await prisma.subscription.findFirst({
                    where: { userId, isActive: true },
                });

                if (!otherActiveSub) {
                    await prisma.user.update({
                        where: { id: userId },
                        data: { isActive: false },
                    });
                }
            }

            console.log(`💳 Deactivated ${expiredSubs.length} expired subscriptions`);
        }
    } catch (error) {
        console.error('Subscription validation error:', error);
    }
}

/**
 * Start the subscription validator worker
 * Runs every 6 hours
 */
function startSubscriptionWorker() {
    console.log('💳 Subscription validator worker started');

    // Run immediately
    validateSubscriptions();

    // Then every 6 hours
    setInterval(validateSubscriptions, 6 * 60 * 60 * 1000);
}

module.exports = { startSubscriptionWorker, validateSubscriptions };
