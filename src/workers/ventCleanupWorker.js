const prisma = require('../config/database');

/**
 * Vent Cleanup Worker
 * Runs as a cron job to delete expired vents
 */
async function cleanupExpiredVents() {
    try {
        const result = await prisma.vent.deleteMany({
            where: {
                autoDeleteAt: {
                    lte: new Date(),
                    not: null,
                },
            },
        });

        if (result.count > 0) {
            console.log(`🗑️ Deleted ${result.count} expired vents`);
        }
    } catch (error) {
        console.error('Vent cleanup error:', error);
    }
}

/**
 * Start the vent cleanup worker
 * Runs every hour
 */
function startVentCleanupWorker() {
    console.log('🗑️ Vent cleanup worker started');

    // Run immediately once
    cleanupExpiredVents();

    // Then every hour
    setInterval(cleanupExpiredVents, 60 * 60 * 1000);
}

module.exports = { startVentCleanupWorker, cleanupExpiredVents };
